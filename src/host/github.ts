import type { ExternalAccount, ExternalConfig, ExternalItem, ExternalProject } from '../shared/external.ts'
import type { ExternalReadContext, ExternalTaskProvider } from './external-provider.ts'
import { externalGet, ExternalRequestThrottle } from './external-http.ts'

/**
 * GitHub Issues as an external task source. Read-only: the board imports
 * issues into cards; nothing here writes back to GitHub (see github-writeback
 * in a later phase). Scope IDs are `owner/repo`; issue IDs are numbers.
 */
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const GITHUB_API_VERSION = '2022-11-28'
const DEFAULT_BASE_URL = 'https://api.github.com'
const MAX_ISSUE_PAGES = 50
const MAX_REPO_PAGES = 10

/** Comma-separated label names, trimmed and lower-cased for lookups. */
function words(raw: string | undefined): ReadonlySet<string> {
  return new Set((raw ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean))
}

export class GithubProvider implements ExternalTaskProvider {
  private readonly baseUrl: string
  private readonly throttle: ExternalRequestThrottle
  private readonly urgent: ReadonlySet<string>
  private readonly relaxed: ReadonlySet<string>

  constructor(
    private readonly config: ExternalConfig,
    private readonly request: typeof fetch = fetch,
    intervalMs = Number(config.settings.requestIntervalMs ?? 100),
  ) {
    if (config.authMode !== 'token' || !config.credentials.token?.trim()) throw new Error('GitHub requires a personal access token')
    const base = (config.baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '')
    if (!/^https?:\/\//.test(base)) throw new Error('GitHub API base URL must use http or https')
    this.baseUrl = base
    this.throttle = new ExternalRequestThrottle(Number.isFinite(intervalMs) && intervalMs >= 0 ? intervalMs : 100)
    this.urgent = words(config.settings.urgentLabels ?? 'urgent,high,紧急,高')
    this.relaxed = words(config.settings.relaxedLabels ?? 'low,nice to have,低')
  }

  private async get(path: string, signal: AbortSignal): Promise<unknown> {
    return externalGet(this.request, `${this.baseUrl}${path}`, {
      Authorization: `Bearer ${this.config.credentials.token}`,
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'User-Agent': 'dsh-taskboard-github',
    }, signal, () => this.throttle.wait(signal))
  }

  private repo(projectId: string): string {
    if (!REPO_PATTERN.test(projectId)) throw new Error('invalid GitHub repository scope')
    return projectId
  }

  private async user(signal: AbortSignal): Promise<Record<string, unknown>> {
    const raw = await this.get('/user', signal)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid GitHub account response')
    return raw as Record<string, unknown>
  }

  async test(signal: AbortSignal): Promise<void> {
    await this.user(signal)
    for (const mapping of this.config.mappings) {
      const raw = await this.get(`/repos/${this.repo(mapping.projectId)}`, signal)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid GitHub repository response')
    }
  }

  async getAccount(signal: AbortSignal): Promise<ExternalAccount> {
    const user = await this.user(signal)
    if (typeof user.login !== 'string' || !user.login) throw new Error('invalid GitHub account response')
    return { account: user.login, ...(typeof user.name === 'string' && user.name ? { name: user.name } : {}) }
  }

  async listProjects(signal: AbortSignal): Promise<ExternalProject[]> {
    const seen = new Set<string>()
    const projects: ExternalProject[] = []
    for (let page = 1; page <= MAX_REPO_PAGES; page++) {
      const raw = await this.get(`/user/repos?per_page=100&sort=updated&page=${page}`, signal)
      if (!Array.isArray(raw)) throw new Error('invalid GitHub repository list')
      let added = 0
      for (const entry of raw) {
        if (!entry || typeof entry !== 'object') throw new Error('invalid GitHub repository entry')
        const name = (entry as Record<string, unknown>).full_name
        if (typeof name !== 'string' || !REPO_PATTERN.test(name)) throw new Error('invalid GitHub repository name')
        if (seen.has(name)) continue
        seen.add(name)
        added++
        projects.push({ id: name, name })
      }
      if (raw.length < 100) return projects
      if (!added) throw new Error('GitHub repository pagination did not advance')
    }
    throw new Error('GitHub repository pagination limit exceeded')
  }

  async getItems(projectId: string, signal: AbortSignal, context?: ExternalReadContext): Promise<ExternalItem[]> {
    const repo = this.repo(projectId)
    const items: ExternalItem[] = []
    const seen = new Set<string>()
    const since = this.sinceQuery()
    for (let page = 1; page <= MAX_ISSUE_PAGES; page++) {
      const raw = await this.get(`/repos/${repo}/issues?state=all&per_page=100&sort=updated&direction=desc&page=${page}${since}`, signal)
      if (!Array.isArray(raw)) throw new Error('invalid GitHub issue list')
      let added = 0
      for (const entry of raw) {
        if (!entry || typeof entry !== 'object') throw new Error('invalid GitHub issue entry')
        const record = entry as Record<string, unknown>
        // The issues endpoint also returns pull requests; the board tracks issues only.
        if (record.pull_request !== undefined) continue
        const item = this.normalize(projectId, record)
        if (seen.has(item.id)) continue
        seen.add(item.id)
        added++
        // Closed issues are history: import them only when a card already tracks them.
        const previous = context?.existing.get(JSON.stringify(['issue', item.id]))
        if (context && previous === undefined && item.closed) continue
        items.push(item)
      }
      if (raw.length < 100) return items
      if (!added) throw new Error('GitHub issue pagination did not advance')
    }
    throw new Error('GitHub issue pagination limit exceeded')
  }

  async getItem(projectId: string, type: string, id: string, signal: AbortSignal): Promise<ExternalItem | undefined> {
    if (type !== 'issue') throw new Error('unsupported GitHub work item')
    if (!/^\d+$/.test(id)) throw new Error('invalid GitHub issue ID')
    const repo = this.repo(projectId)
    const raw = await this.get(`/repos/${repo}/issues/${encodeURIComponent(id)}`, signal)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid GitHub issue response')
    const record = raw as Record<string, unknown>
    if (record.pull_request !== undefined) return undefined
    return this.normalize(projectId, record)
  }

  private sinceQuery(): string {
    const since = this.config.since?.trim() ?? ''
    if (!since) return ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error('invalid GitHub since date')
    return `&since=${encodeURIComponent(`${since}T00:00:00Z`)}`
  }

  private normalize(projectId: string, raw: Record<string, unknown>): ExternalItem {
    const number = raw.number
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) throw new Error('invalid GitHub issue number')
    const title = raw.title
    if (typeof title !== 'string' || !title.trim()) throw new Error('invalid GitHub issue title')
    const state = raw.state
    if (state !== 'open' && state !== 'closed') throw new Error('invalid GitHub issue state')
    const url = raw.html_url
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Error('invalid GitHub issue URL')
    const body = raw.body ?? ''
    if (typeof body !== 'string') throw new Error('invalid GitHub issue body')
    const labels = this.labels(raw.labels)
    const assignees = this.assignees(raw.assignees)
    const urgency = this.urgency(labels)
    return {
      projectId, type: 'issue', id: String(number), title: title.trim(), description: body,
      priority: labels.join(','), status: state, assignedTo: this.login(raw.assignee) ?? assignees[0] ?? '',
      assignees, closed: state === 'closed', urgency, url,
    }
  }

  private urgency(labels: readonly string[]): ExternalItem['urgency'] {
    const names = new Set(labels.map(label => label.toLowerCase()))
    if ([...this.urgent].some(label => names.has(label))) return 'urgent'
    if ([...this.relaxed].some(label => names.has(label))) return 'relaxed'
    return 'normal'
  }

  private labels(raw: unknown): string[] {
    if (!Array.isArray(raw)) throw new Error('invalid GitHub issue labels')
    const labels: string[] = []
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') throw new Error('invalid GitHub issue label')
      const name = (entry as Record<string, unknown>).name
      if (typeof name !== 'string' || !name) throw new Error('invalid GitHub issue label')
      labels.push(name)
    }
    return labels
  }

  private assignees(raw: unknown): string[] {
    if (raw === undefined || raw === null) return []
    if (!Array.isArray(raw)) throw new Error('invalid GitHub issue assignees')
    const logins: string[] = []
    for (const entry of raw) {
      const login = this.login(entry)
      if (login === undefined) throw new Error('invalid GitHub issue assignee')
      logins.push(login)
    }
    return logins
  }

  private login(raw: unknown): string | undefined {
    if (raw === undefined || raw === null) return undefined
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid GitHub issue assignee')
    const login = (raw as Record<string, unknown>).login
    if (typeof login !== 'string' || !login) throw new Error('invalid GitHub issue assignee')
    return login
  }
}
