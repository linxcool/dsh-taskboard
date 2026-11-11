/**
 * Outbound creation (P6): a board-created task becomes a GitHub issue, added to
 * the configured Project board with the card's status.
 *
 * Failure policy: the ISSUE is the thing that must not be duplicated. If the
 * issue is created but the Project attachment fails, the issue is kept and
 * `projectAttached: false` is reported — the caller links the card and leaves a
 * host comment instead of retrying and creating a second issue.
 *
 * @module dsh-taskboard/host/github-create
 */
import type { ExternalConfig } from '../shared/external.ts'
import type { TaskStatus } from '../shared/protocol.ts'
import { parseStatusMap } from '../shared/github-status-map.ts'

const DEFAULT_BASE_URL = 'https://api.github.com'
const GITHUB_API_VERSION = '2022-11-28'

export type CreateIssueResult = { number: number; url: string; projectAttached: boolean }

/**
 * The Project node id plus the Status field and its options.
 *
 * `repositoryOwner` has no `projectV2` field — the `ProjectV2Owner` fragment is
 * mandatory (a missing fragment silently invalidated the whole query once).
 */
const PROJECT_META_QUERY = `query TaskboardProjectMeta($login: String!, $number: Int!, $field: String!) {
  repositoryOwner(login: $login) {
    ... on ProjectV2Owner {
      projectV2(number: $number) {
        id
        field(name: $field) {
          ... on ProjectV2SingleSelectField { id options { id name } }
        }
      }
    }
  }
}`

const ADD_ITEM_MUTATION = `mutation TaskboardAddItem($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
    item { id }
  }
}`

const SET_STATUS_MUTATION = `mutation TaskboardSetCreatedStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId } }) {
    projectV2Item { id }
  }
}`

function headers(token: string, json: boolean): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': 'dsh-taskboard-github',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  }
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Create an issue for a task and attach it to the Project board.
 *
 * @param options - connection (with credentials), repo, content and card status.
 * @returns the created issue; `projectAttached` is false when the issue exists
 *          but could not be added to the Project.
 * @throws when the issue itself cannot be created.
 */
export async function createIssueFromTask(options: {
  config: ExternalConfig
  repo: string
  title: string
  body: string
  status: TaskStatus
  request?: typeof fetch
  now?: () => number
}): Promise<CreateIssueResult> {
  const request = options.request ?? fetch
  const token = options.config.credentials.token ?? ''
  if (token.length === 0) throw new Error('GitHub token is missing')
  const baseUrl = (options.config.baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(baseUrl)) throw new Error('GitHub API base URL must use http or https')

  const created = await request(`${baseUrl}/repos/${options.repo}/issues`, {
    method: 'POST',
    headers: headers(token, true),
    body: JSON.stringify({ title: options.title, body: options.body }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!created.ok) {
    await created.body?.cancel()
    throw new Error(`GitHub issue creation failed (HTTP ${created.status})`)
  }
  const issue = objectOf(await created.json())
  const number = issue?.number
  const url = issue?.html_url
  const nodeId = issue?.node_id
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || typeof url !== 'string') {
    throw new Error('GitHub issue creation returned an invalid payload')
  }

  const settings = options.config.settings ?? {}
  const projectNumber = Number(settings.projectNumber ?? '')
  const owner = (settings.projectOwner ?? '').trim()
  const result: CreateIssueResult = { number, url, projectAttached: false }
  if (owner.length === 0 || !Number.isSafeInteger(projectNumber) || projectNumber <= 0 || typeof nodeId !== 'string') {
    return result
  }

  const graphql = async (query: string, variables: Record<string, unknown>): Promise<Record<string, unknown> | undefined> => {
    const response = await request(`${baseUrl}/graphql`, {
      method: 'POST',
      headers: headers(token, true),
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      await response.body?.cancel()
      return undefined
    }
    const payload = objectOf(await response.json().catch(() => undefined))
    if (Array.isArray(payload?.errors) && payload!.errors.length > 0) return undefined
    return objectOf(payload?.data)
  }

  try {
    const fieldName = (settings.statusField ?? 'Status').trim() || 'Status'
    const meta = await graphql(PROJECT_META_QUERY, { login: owner, number: projectNumber, field: fieldName })
    const project = objectOf(objectOf(meta?.repositoryOwner)?.projectV2)
    const projectId = project?.id
    const field = objectOf(project?.field)
    const fieldId = field?.id
    if (typeof projectId !== 'string' || typeof fieldId !== 'string') return result

    const added = await graphql(ADD_ITEM_MUTATION, { projectId, contentId: nodeId })
    const itemId = objectOf(added?.addProjectV2ItemById)?.item
    const itemNodeId = objectOf(itemId)?.id
    if (typeof itemNodeId !== 'string') return result
    result.projectAttached = true

    // Setting the status is a bonus: a board item without the right option is
    // better than a failed creation.
    const target = parseStatusMap(settings.statusMap)[options.status]
    const optionsList = Array.isArray(field?.options) ? field!.options : []
    const option = optionsList
      .map(objectOf)
      .find(entry => entry?.name === target)
    const optionId = option?.id
    if (typeof optionId === 'string') {
      await graphql(SET_STATUS_MUTATION, { projectId, itemId: itemNodeId, fieldId, optionId })
    }
    return result
  } catch {
    // Network/GraphQL failure after the issue exists: keep the issue.
    return result
  }
}
