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
/** Project item pages (100 items each) — a board with more items keeps the first 2000. */
const MAX_PROJECT_PAGES = 20

/**
 * One page of a ProjectV2 board: each item's issue number and its single-select
 * Status option.
 *
 * Two GraphQL traps this query has already hit:
 * - `repositoryOwner` returns the `RepositoryOwner` interface, which has no
 *   `projectV2` field — the selection MUST go through `... on ProjectV2Owner`.
 * - GraphQL rejects a declared-but-unused variable, so the status field name is
 *   NOT a variable; the caller filters field values by name locally.
 */
const PROJECT_ITEMS_QUERY = `query TaskboardProjectItems($login: String!, $num: Int!, $cursor: String) {
  repositoryOwner(login: $login) {
    ... on ProjectV2Owner {
      projectV2(number: $num) {
        items(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            content { ... on Issue { number repository { nameWithOwner } } }
            fieldValues(first: 50) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field { ... on ProjectV2SingleSelectField { name } }
                }
              }
            }
          }
        }
      }
    }
  }
}`

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

  /** GraphQL POST against the API root (Project fields are not on REST). */
  private async graphql(query: string, variables: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    await this.throttle.wait(signal)
    const response = await this.request(`${this.baseUrl}/graphql`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.credentials.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'dsh-taskboard-github',
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      redirect: 'error',
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`External request failed (HTTP ${response.status})`)
    }
    const raw = await response.json().catch(() => { throw new Error('External service returned invalid JSON') }) as
      { data?: unknown; errors?: unknown }
    if (Array.isArray(raw.errors) && raw.errors.length > 0) throw new Error('GitHub Project query failed')
    if (!raw.data || typeof raw.data !== 'object') throw new Error('invalid GitHub Project response')
    return raw.data as Record<string, unknown>
  }

  /**
   * `owner/repo#number` → Project Status option name for the configured board.
   *
   * The key MUST carry the repository: one Project can hold items from several
   * repositories, and issue numbers collide across them (`hdefense#11` vs
   * `cloudflare#11`). Keying by number alone applied another repo's status to
   * the card.
   *
   * One paginated query for the whole project instead of a lookup per issue.
   * Empty when no project is configured, and a failed query degrades to empty
   * (a token without the `project` scope must not break issue import).
   */
  private async projectStatuses(signal: AbortSignal): Promise<ReadonlyMap<string, string>> {
    const statuses = new Map<string, string>()
    const owner = (this.config.settings.projectOwner ?? '').trim()
    const projectNumber = Number(this.config.settings.projectNumber ?? '')
    if (owner.length === 0 || !Number.isSafeInteger(projectNumber) || projectNumber <= 0) return statuses
    const field = (this.config.settings.statusField ?? 'Status').trim() || 'Status'
    let cursor: string | undefined
    for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
      const data = await this.graphql(PROJECT_ITEMS_QUERY, { login: owner, num: projectNumber, cursor: cursor ?? null }, signal)
      const ownerNode = data.repositoryOwner as Record<string, unknown> | undefined
      const project = ownerNode?.projectV2 as Record<string, unknown> | undefined
      const items = project?.items as { pageInfo?: { hasNextPage?: unknown; endCursor?: unknown }; nodes?: unknown } | undefined
      const nodes = Array.isArray(items?.nodes) ? items.nodes : []
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue
        const entry = node as { content?: { number?: unknown; repository?: { nameWithOwner?: unknown } }; fieldValues?: { nodes?: unknown } }
        const number = entry.content?.number
        const repo = entry.content?.repository?.nameWithOwner
        if (typeof number !== 'number' || !Number.isSafeInteger(number)) continue
        if (typeof repo !== 'string' || repo.length === 0) continue
        const values = Array.isArray(entry.fieldValues?.nodes) ? entry.fieldValues.nodes : []
        for (const value of values) {
          if (!value || typeof value !== 'object') continue
          const fieldValue = value as { name?: unknown; field?: { name?: unknown } }
          if (fieldValue.field?.name !== field) continue
          if (typeof fieldValue.name === 'string' && fieldValue.name.length > 0) {
            statuses.set(`${repo}#${number}`, fieldValue.name)
          }
        }
      }
      const hasNext = items?.pageInfo?.hasNextPage === true
      const endCursor = items?.pageInfo?.endCursor
      if (!hasNext || typeof endCursor !== 'string' || endCursor.length === 0) break
      cursor = endCursor
    }
    return statuses
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
    // Project Status is fetched once per sync; a failed query degrades to no mapping.
    const statuses = await this.projectStatuses(signal).catch((error: unknown) => {
      // Degrade instead of failing the whole import, but say so: a silent
      // fallback hid an invalid Project query for a whole sync round.
      console.warn('[dsh-taskboard] GitHub Project Status unavailable; importing without status mapping:', error instanceof Error ? error.message : String(error))
      return new Map<string, string>()
    })
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
        const item = this.normalize(projectId, record, statuses)
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
    const statuses = await this.projectStatuses(signal).catch((error: unknown) => {
      // Degrade instead of failing the whole import, but say so: a silent
      // fallback hid an invalid Project query for a whole sync round.
      console.warn('[dsh-taskboard] GitHub Project Status unavailable; importing without status mapping:', error instanceof Error ? error.message : String(error))
      return new Map<string, string>()
    })
    return this.normalize(projectId, record, statuses)
  }

  private sinceQuery(): string {
    const since = this.config.since?.trim() ?? ''
    if (!since) return ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error('invalid GitHub since date')
    return `&since=${encodeURIComponent(`${since}T00:00:00Z`)}`
  }

  private normalize(projectId: string, raw: Record<string, unknown>, statuses?: ReadonlyMap<string, string>): ExternalItem {
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
      ...(statuses?.has(`${projectId}#${number}`) === true ? { projectStatus: statuses.get(`${projectId}#${number}`)! } : {}),
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
