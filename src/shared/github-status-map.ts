/**
 * Board-column → GitHub Project Status option mapping, shared by the host
 * write-back service and the client column headers.
 *
 * The mapping is the single vocabulary source: `parseStatusMap` turns the
 * connection's `column=option` string into a lookup, and the board renders
 * those option names as its column headers when a GitHub connection is
 * configured. Without a connection the caller falls back to i18n labels.
 *
 * @module dsh-taskboard/shared/github-status-map
 */
import type { TaskStatus } from './protocol.ts'

/** Statuses that carry a GitHub Project Status option (archived does not). */
export const WRITEBACK_STATUSES: readonly TaskStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled']

/** Default board-column → Project Status option names. */
export const DEFAULT_STATUS_MAP: Readonly<Partial<Record<TaskStatus, string>>> = {
  backlog: '待澄清', todo: '就绪', in_progress: '执行中', in_review: '待你验收', done: '完成', canceled: '取消',
}

/** The subset of an external connection this module needs. */
export type StatusMapSource = { provider?: string; settings?: Record<string, string> } | undefined

/** Parse `column=option,column=option`; unknown columns are ignored. */
export function parseStatusMap(raw: string | undefined): Partial<Record<TaskStatus, string>> {
  const map: Partial<Record<TaskStatus, string>> = { ...DEFAULT_STATUS_MAP }
  for (const entry of (raw ?? '').split(',')) {
    const separator = entry.indexOf('=')
    if (separator < 0) continue
    const key = entry.slice(0, separator).trim() as TaskStatus
    const value = entry.slice(separator + 1).trim()
    if (!WRITEBACK_STATUSES.includes(key) || !value) continue
    map[key] = value
  }
  return map
}

/**
 * The column vocabulary for a configured GitHub connection, or `undefined`
 * when there is none (or write-back is off) — callers then use i18n labels.
 */
export function githubStatusMapOf(config: StatusMapSource): Partial<Record<TaskStatus, string>> | undefined {
  if (config?.provider !== 'github') return undefined
  const mode = (config.settings?.writebackMode ?? 'off').toLowerCase()
  if (mode === 'off') return undefined
  return parseStatusMap(config.settings?.statusMap)
}
