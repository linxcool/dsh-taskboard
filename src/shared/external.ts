/** Platform-neutral external work item contract. IDs are opaque strings. */
export type ProviderDescriptor = {
  id: string
  name: string
  scopeLabel: string
  defaultBaseUrl: string
  settingsFields?: Array<{ key: string; label: string; defaultValue: string }>
  authModes: Array<{ id: string; label: string; fields: Array<{ key: string; label: string; secret?: boolean }> }>
  capabilities: { itemTypes: string[]; projectDiscovery: boolean; accountDiscovery: boolean; pagination: 'page' | 'cursor'; incremental: boolean }
}
export type ExternalConnection = {
  id: string; provider: string; baseUrl: string; account: string; authMode: string
  itemTypes: string[]; mappings: Array<{ projectId: string; workspaceId: string }>
  settings: Record<string, string>
  since: string; intervalMinutes: number
  importStatus?: 'backlog' | 'todo'
  mappingMode?: 'project' | 'execution'
  includeUnmapped?: boolean
}
export type ExternalConfig = ExternalConnection & { credentials: Record<string, string> }
export type ExternalProject = { id: string; name: string }
export type ExternalAccount = { account: string; name?: string }
export type SyncResult = { created: number; updated: number; unchanged: number; conflicts: number; ignored: number; at: number }

/**
 * A root work item that HAS children — an epic.
 *
 * Epics do not become cards: they are the board's filter dimension. The
 * descriptor keeps just enough to render a filter option (title + the tracker's
 * own status) without storing a task for it.
 */
export type ExternalEpic = { key: string; repo: string; number: number; title: string; status?: string; children: number }
export type ExternalSyncRecord = {
  links: Record<string, string>; ignored: string[]; lastResult?: SyncResult; lastError?: string; lastAttemptAt?: number
  /** Root items with children seen during the last sync (filter facets). */
  epics?: ExternalEpic[]
}
export function normalizeExternalSyncRecords(raw: unknown): Record<string, ExternalSyncRecord> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw).flatMap(([id, value]) => {
    if (!id || !value || typeof value !== 'object' || Array.isArray(value)) return []
    const e = value as Record<string, unknown>
    const links = e.links && typeof e.links === 'object' && !Array.isArray(e.links)
      ? Object.fromEntries(Object.entries(e.links).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}
    const ignored = Array.isArray(e.ignored) ? [...new Set(e.ignored.filter((v): v is string => typeof v === 'string'))] : []
    const r = e.lastResult as Record<string, unknown> | undefined
    const lastResult = r && typeof r === 'object' && ['created', 'updated', 'unchanged', 'conflicts', 'ignored', 'at'].every(k => typeof r[k] === 'number' && Number.isFinite(r[k]) && (r[k] as number) >= 0)
      ? { created: r.created as number, updated: r.updated as number, unchanged: r.unchanged as number, conflicts: r.conflicts as number, ignored: r.ignored as number, at: r.at as number } : undefined
    const epics = Array.isArray(e.epics) ? e.epics.flatMap((entry): ExternalEpic[] => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
      const epic = entry as Record<string, unknown>
      if (typeof epic.key !== 'string' || typeof epic.repo !== 'string' || typeof epic.title !== 'string') return []
      if (typeof epic.number !== 'number' || !Number.isSafeInteger(epic.number)) return []
      if (typeof epic.children !== 'number' || !Number.isSafeInteger(epic.children) || epic.children <= 0) return []
      return [{ key: epic.key, repo: epic.repo, number: epic.number, title: epic.title, children: epic.children,
        ...(typeof epic.status === 'string' && epic.status.length > 0 ? { status: epic.status } : {}) }]
    }) : undefined
    return [[id, { links, ignored, ...(lastResult ? { lastResult } : {}),
      ...(epics !== undefined && epics.length > 0 ? { epics } : {}),
      ...(typeof e.lastError === 'string' ? { lastError: e.lastError } : {}),
      ...(typeof e.lastAttemptAt === 'number' && Number.isFinite(e.lastAttemptAt) ? { lastAttemptAt: e.lastAttemptAt } : {}) }]]
  }))
}
export type ExternalSyncStatus = {
  config?: ExternalConnection; credentialPresent: Record<string, boolean>; running: boolean
  credentialValues?: Record<string, string>
  providers: ProviderDescriptor[]; lastResult?: SyncResult; lastError?: string; ignoredCount: number
  lastAttemptAt?: number
  requiresMappingReview?: boolean
}
export type ExternalFields = { title: string; description: string; urgency: 'urgent' | 'normal' | 'relaxed' }
export type ExternalItem = ExternalFields & {
  projectId: string
  type: string
  id: string
  url: string
  status: string
  priority: string
  assignedTo: string
  assignees?: string[]
  closed: boolean
  /**
   * The item's option name in the tracker's board (GitHub Project Status).
   * Absent when the source has no such field; the sync maps it back to a board
   * column through the connection's statusMap.
   */
  projectStatus?: string
  /**
   * The parent work item's number in the SAME project scope (GitHub sub-issue).
   * Absent for root items — those with children are epics, not cards.
   */
  parentNumber?: number
  /** How many sub-items this item has (0/absent = a leaf). */
  childCount?: number
}
export type ExternalSource = {
  providerName?: string
  connectionId: string
  provider: string
  item: ExternalItem
  syncedAt: number
  conflicts: Array<keyof ExternalFields>
}

export function externalKey(connectionId: string, item: Pick<ExternalItem, 'projectId' | 'type' | 'id'>): string {
  return JSON.stringify([connectionId, item.projectId, item.type, item.id])
}

/** `repo#number` for an external issue — the only collision-free identity. */
export function externalIssueRef(projectId: string, number: number): string {
  return `${projectId}#${number}`
}

/**
 * `repo#issue` → parent issue number, for the cards on the board.
 *
 * Epics are not cards, so the chain ends at a number with no entry here; that
 * missing entry is the epic itself.
 */
export function parentsByIssue(tasks: readonly { external?: ExternalSource }[]): Map<string, number> {
  const parents = new Map<string, number>()
  for (const task of tasks) {
    const item = task.external?.item
    if (item?.parentNumber === undefined) continue
    parents.set(externalIssueRef(item.projectId, Number(item.id)), item.parentNumber)
  }
  return parents
}

/**
 * Whether a card belongs to the descendant tree of an epic (any depth).
 * @param task - the card.
 * @param epicNumber - the root issue number to test against.
 * @param parents - the map from {@link parentsByIssue}.
 */
export function isDescendantOf(task: { external?: ExternalSource }, epicNumber: number, parents: ReadonlyMap<string, number>): boolean {
  const item = task.external?.item
  if (item === undefined) return false
  let current = item.parentNumber
  // Guard against a malformed/cyclic chain from a broken source.
  for (let step = 0; current !== undefined && step < 64; step++) {
    if (current === epicNumber) return true
    current = parents.get(externalIssueRef(item.projectId, current))
  }
  return false
}

/** Explicit reconstruction also prevents credentials/unknown fields entering exports. */
export function normalizeExternalSource(raw: unknown): ExternalSource | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const e = raw as Record<string, unknown>
  if (typeof e.connectionId !== 'string' || !e.connectionId || typeof e.provider !== 'string'
    || typeof e.syncedAt !== 'number' || !Number.isFinite(e.syncedAt) || !e.item || typeof e.item !== 'object') return undefined
  const i = e.item as Record<string, unknown>
  for (const field of ['projectId', 'type', 'id', 'url', 'status', 'priority', 'assignedTo', 'title', 'description']) {
    if (typeof i[field] !== 'string') return undefined
  }
  try { if (!['http:', 'https:'].includes(new URL(i.url as string).protocol)) return undefined } catch { return undefined }
  if (!['urgent', 'normal', 'relaxed'].includes(String(i.urgency)) || typeof i.closed !== 'boolean') return undefined
  const item: ExternalItem = {
    projectId: i.projectId as string, type: i.type as string, id: i.id as string,
    url: i.url as string, status: i.status as string, priority: i.priority as string,
    assignedTo: i.assignedTo as string, title: i.title as string, description: i.description as string,
    urgency: i.urgency as ExternalItem['urgency'], closed: i.closed,
    ...(Array.isArray(i.assignees) ? { assignees: i.assignees.filter((v): v is string => typeof v === 'string') } : {}),
    ...(typeof i.projectStatus === 'string' && i.projectStatus.length > 0 ? { projectStatus: i.projectStatus } : {}),
    ...(typeof i.parentNumber === 'number' && Number.isSafeInteger(i.parentNumber) && i.parentNumber > 0 ? { parentNumber: i.parentNumber } : {}),
    ...(typeof i.childCount === 'number' && Number.isSafeInteger(i.childCount) && i.childCount > 0 ? { childCount: i.childCount } : {}),
  }
  return { connectionId: e.connectionId, provider: e.provider, ...(typeof e.providerName === 'string' ? { providerName: e.providerName } : {}), syncedAt: e.syncedAt, item,
    conflicts: Array.isArray(e.conflicts) ? e.conflicts.filter((v): v is keyof ExternalFields => ['title', 'description', 'urgency'].includes(v)) : [] }
}

/** Three-way merge; unresolved conflicts persist across unchanged syncs. */
export function mergeExternalFields(local: ExternalFields, previous: ExternalSource, incoming: ExternalItem, frozen: boolean): {
  fields: ExternalFields; conflicts: Array<keyof ExternalFields>
} {
  const fields = { title: local.title, description: local.description, urgency: local.urgency }
  const conflicts: Array<keyof ExternalFields> = []
  for (const key of ['title', 'description', 'urgency'] as const) {
    if (local[key] === incoming[key]) continue
    const remoteChanged = incoming[key] !== previous.item[key]
    if (!remoteChanged && !previous.conflicts.includes(key)) continue
    if (!frozen && local[key] === previous.item[key] && !previous.conflicts.includes(key)) {
      if (key === 'urgency') fields.urgency = incoming.urgency
      else fields[key] = incoming[key]
    } else conflicts.push(key)
  }
  return { fields, conflicts }
}
