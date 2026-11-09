import type { ExternalConfig } from '../shared/external.ts'
import { parseStatusMap } from '../shared/github-status-map.ts'
import { newCommentId, normalizeBody, type TaskRecord, type TaskStatus } from '../shared/protocol.ts'
import type { TaskStore } from './store.ts'

/**
 * GitHub Project write-back (P2). Board moves on tasks imported from GitHub
 * update the issue's ProjectV2 Status field (GraphQL) and/or post an issue
 * comment (REST), depending on the connection's `writebackMode` setting.
 *
 * The service is deliberately self-contained: it never throws into the
 * store's move path, skips unchanged statuses (idempotent), and records
 * failures as host comments on the task instead of blocking the move.
 */

const DEFAULT_BASE_URL = 'https://api.github.com'
const GITHUB_API_VERSION = '2022-11-28'
const MODES = ['off', 'status', 'comment', 'both'] as const
type Mode = (typeof MODES)[number]

const LOOKUP_QUERY = `query TaskboardIssueStatus($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      id
      projectItems(first: 50) {
        nodes {
          id
          project { id number owner { ... on User { login } ... on Organization { login } } }
          fieldValues(first: 100) {
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
}`

const FIELD_QUERY = `query TaskboardStatusField($projectId: ID!, $field: String!) {
  node(id: $projectId) {
    ... on ProjectV2 {
      field(name: $field) {
        ... on ProjectV2SingleSelectField { id name options { id name } }
      }
    }
  }
}`

const SET_STATUS_MUTATION = `mutation TaskboardSetStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId } }) {
    projectV2Item { id }
  }
}`

type WritePlan = {
  mode: Mode
  baseUrl: string
  token: string
  repo: string
  issueNumber: number
  projectNumber: number
  projectOwner: string
  statusField: string
  targetStatus: string
}

/** Narrow JSON helpers; every malformed shape fails with a stable message. */
function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
function arrayOf(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

export class GithubWritebackService {
  private disposed = false
  private readonly request: typeof fetch
  constructor(private readonly deps: {
    store: TaskStore
    /** Host-only connection snapshot (includes credentials). */
    connection: () => ExternalConfig | undefined
    request?: typeof fetch
    now?: () => number
  }) {
    this.request = deps.request ?? fetch
  }

  private now(): number { return this.deps.now?.() ?? Date.now() }

  /** Fire-and-forget wrapper for the store's move observer. */
  afterMove(task: TaskRecord, from: TaskStatus, to: TaskStatus): void {
    if (this.disposed) return
    void this.handleMove(task, from, to).catch(error => {
      console.warn('[dsh-taskboard] GitHub write-back hook failed:', error)
    })
  }

  /** Awaitable implementation (tests and host integration). */
  async handleMove(task: TaskRecord, from: TaskStatus, to: TaskStatus): Promise<void> {
    if (this.disposed) return
    const plan = this.plan(task, from, to)
    if (plan === undefined) return
    try {
      await this.apply(plan, from, to)
    } catch (error) {
      await this.note(task.id, error)
    }
  }

  dispose(): void { this.disposed = true }

  /** Resolve whether this move needs GitHub work; undefined = no-op. */
  private plan(task: TaskRecord, from: TaskStatus, to: TaskStatus): WritePlan | undefined {
    if (from === to) return undefined
    const external = task.external
    if (external === undefined || external.provider !== 'github' || external.item.type !== 'issue') return undefined
    const connection = this.deps.connection()
    if (connection === undefined || connection.provider !== 'github' || connection.id !== external.connectionId) return undefined
    if (!/^\d+$/.test(external.item.id)) return undefined
    const settings = connection.settings ?? {}
    const mode = String(settings.writebackMode ?? 'off').toLowerCase() as Mode
    if (!MODES.includes(mode) || mode === 'off') return undefined
    const statusMap = parseStatusMap(settings.statusMap)
    const targetStatus = statusMap[to]
    if (targetStatus === undefined) return undefined
    const projectNumber = Number(settings.projectNumber ?? '')
    if (!Number.isSafeInteger(projectNumber) || projectNumber <= 0) return undefined
    const repo = external.item.projectId
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return undefined
    const projectOwner = (settings.projectOwner ?? '').trim() || repo.split('/')[0]!
    const token = connection.credentials.token ?? ''
    if (!token) return undefined
    const baseUrl = (connection.baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '')
    if (!/^https?:\/\//.test(baseUrl)) return undefined
    return {
      mode, baseUrl, token, repo, issueNumber: Number(external.item.id), projectNumber, projectOwner,
      statusField: (settings.statusField ?? '').trim() || 'Status', targetStatus,
    }
  }

  private async apply(plan: WritePlan, from: TaskStatus, to: TaskStatus): Promise<void> {
    const [owner, name] = plan.repo.split('/') as [string, string]
    const lookup = await this.graphql(plan, LOOKUP_QUERY, { owner, name, number: plan.issueNumber })
    const repository = objectOf(lookup.repository)
    const issue = objectOf(repository?.issue)
    const nodes = arrayOf(objectOf(issue?.projectItems)?.nodes) ?? []
    const items = nodes.map(objectOf).filter((node): node is Record<string, unknown> => node !== undefined)
    const item = items.find(node => {
      const project = objectOf(node.project)
      const ownerLogin = objectOf(project?.owner)?.login
      return Number(project?.number) === plan.projectNumber
        && typeof ownerLogin === 'string' && ownerLogin.toLowerCase() === plan.projectOwner.toLowerCase()
    })
    if (item === undefined) throw new Error(`Issue ${plan.repo}#${plan.issueNumber} is not on GitHub Project #${plan.projectNumber}`)
    const itemId = typeof item.id === 'string' ? item.id : undefined
    if (itemId === undefined) throw new Error('invalid GitHub Project item identity')
    const projectId = typeof objectOf(item.project)?.id === 'string' ? objectOf(item.project)!.id as string : undefined
    if (projectId === undefined) throw new Error('invalid GitHub Project identity')
    const currentStatus = this.currentStatus(item, plan.statusField)
    if (currentStatus === plan.targetStatus) return
    if (plan.mode === 'status' || plan.mode === 'both') {
      const field = await this.graphql(plan, FIELD_QUERY, { projectId, field: plan.statusField })
      const node = objectOf(field.node)
      const fieldNode = objectOf(node?.field)
      const fieldId = typeof fieldNode?.id === 'string' ? fieldNode.id : undefined
      const option = (arrayOf(fieldNode?.options) ?? []).map(objectOf)
        .find(entry => entry !== undefined && entry.name === plan.targetStatus)
      const optionId = typeof option?.id === 'string' ? option.id : undefined
      if (fieldId === undefined || optionId === undefined) {
        throw new Error(`GitHub Project 状态选项「${plan.targetStatus}」不存在（字段 ${plan.statusField}）`)
      }
      await this.graphql(plan, SET_STATUS_MUTATION, { projectId, itemId, fieldId, optionId })
    }
    if (plan.mode === 'comment' || plan.mode === 'both') {
      const body = `[dsh-taskboard] 看板状态：${from} → ${to}（GitHub Project Status：${plan.targetStatus}）`
      const response = await this.request(`${plan.baseUrl}/repos/${plan.repo}/issues/${plan.issueNumber}/comments`, {
        method: 'POST',
        headers: this.headers(plan, 'application/json'),
        body: JSON.stringify({ body }),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      })
      if (!response.ok) throw new Error(`GitHub comment request failed (HTTP ${response.status})`)
    }
  }

  private currentStatus(item: Record<string, unknown>, fieldName: string): string | undefined {
    for (const entry of arrayOf(objectOf(item.fieldValues)?.nodes) ?? []) {
      const value = objectOf(entry)
      const field = objectOf(value?.field)
      if (field !== undefined && field.name === fieldName && typeof value?.name === 'string') return value.name
    }
    return undefined
  }

  private headers(plan: WritePlan, contentType: string): Record<string, string> {
    return {
      Authorization: `Bearer ${plan.token}`,
      Accept: 'application/json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'User-Agent': 'dsh-taskboard-github',
      ...(contentType === 'application/json' ? { 'Content-Type': 'application/json' } : {}),
    }
  }

  private async graphql(plan: WritePlan, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.request(`${plan.baseUrl}/graphql`, {
      method: 'POST',
      headers: this.headers(plan, 'application/json'),
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    })
    if (!response.ok) throw new Error(`GitHub GraphQL request failed (HTTP ${response.status})`)
    let payload: unknown
    try { payload = await response.json() } catch { throw new Error('GitHub GraphQL returned invalid JSON') }
    const body = objectOf(payload)
    if (body === undefined) throw new Error('invalid GitHub GraphQL response')
    const errors = arrayOf(body.errors)
    if (errors !== undefined && errors.length > 0) {
      const first = objectOf(errors[0])
      const message = first !== undefined && typeof first.message === 'string' ? first.message : 'unknown error'
      throw new Error(`GitHub GraphQL error: ${message.slice(0, 300)}`)
    }
    const data = objectOf(body.data)
    if (data === undefined) throw new Error('invalid GitHub GraphQL response')
    return data
  }

  /** Record a write-back failure as a host comment; never throws. */
  private async note(taskId: string, error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error)
    const body = `[dsh-taskboard] GitHub 回写失败：${reason.slice(0, 500)}`
    try {
      await this.deps.store.mutate('comment-added', ledger => {
        const index = ledger.tasks.findIndex(task => task.id === taskId)
        if (index < 0) return undefined
        const fresh = ledger.tasks[index]!
        if (fresh.trashedAt !== undefined) return undefined
        const next = structuredClone(fresh)
        next.comments.push({ id: newCommentId(), body: normalizeBody(body), threadId: 'host', version: 1, createdAt: this.now() })
        next.version = fresh.version + 1
        next.updatedAt = this.now()
        ledger.tasks[index] = next
        return [next]
      })
    } catch { /* failure reporting must never surface */ }
  }
}
