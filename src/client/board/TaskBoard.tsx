/**
 * The main board view: toolbar (project filter, urgency chips, secondary tab,
 * composer), five status columns, the detail pane, and the new-task modal.
 *
 * @module dsh-taskboard/client/board/TaskBoard
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { BoardController, ControllerState } from '../controller.ts'
import type { TaskRecord, TaskStatus, Urgency } from '../../shared/protocol.ts'
import { MAIN_STATUSES, canTransition, completedDisplayLimitOf } from '../../shared/protocol.ts'
import { PLUGIN_VERSION } from '../../shared/version.ts'
import { COLUMN_COLLAPSE_KEYS, COLUMN_EXPAND_KEYS, COLUMN_KEYS, URGENCY_KEYS, columnLabel } from './labels.ts'
import { githubStatusMapOf } from '../../shared/github-status-map.ts'
import { externalIssueRef, isDescendantOf, parentsByIssue } from '../../shared/external.ts'
import type { ExternalSyncStatus } from '../../shared/external.ts'
import { externalRequest } from '../external-api.ts'
import { useT } from '../i18n/runtime.ts'
import { localizeBuiltinName, localizeBuiltinTask } from '../i18n/templates.ts'
import { categoryLabel, groupTemplatesByCategory } from '../template-categories.ts'
import { fmtTime, isStaleClaim } from './format.ts'
import { humanWaiting } from '../../shared/human-wait.ts'
import { DRAG_TYPE, TaskCard } from './TaskCard.tsx'
import { TaskDetail } from './TaskDetail.tsx'
import { TaskFormModal } from './TaskFormModal.tsx'
import { SettingsModal } from './SettingsModal.tsx'
import { ImportModal } from './ImportModal.tsx'
import { TemplateManager } from './TemplateManager.tsx'
import { EmployeesModal } from './EmployeesModal.tsx'
import { useAlert } from './AlertModal.tsx'

/** Urgency sort rank (urgent first). */
const URGENCY_RANK: Record<Urgency, number> = { urgent: 0, normal: 1, relaxed: 2 }

/** Apply the active filters + search + sort to a task list. */
export function filterTasks(state: ControllerState, tasks: TaskRecord[]): TaskRecord[] {
  const q = state.search.trim().toLowerCase()
  const filtered = tasks.filter(t =>
    (state.filters.workspaceId === undefined || t.workspaceId === state.filters.workspaceId)
    && (state.filters.urgencies.length === 0 || state.filters.urgencies.includes(t.urgency))
    && (state.filters.externalOnly !== true || t.external !== undefined)
    && (q.length === 0 || t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q)))
  if (state.sortBy === 'default') return filtered
  const sorted = [...filtered]
  if (state.sortBy === 'updated') sorted.sort((a, b) => b.updatedAt - a.updatedAt)
  else if (state.sortBy === 'created') sorted.sort((a, b) => b.createdAt - a.createdAt)
  else if (state.sortBy === 'urgency') sorted.sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || b.updatedAt - a.updatedAt)
  else if (state.sortBy === 'title') sorted.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }))
  return sorted
}

/** Sort completed tasks newest-first by update/settle time (fallback to created time, then id). */
export function sortDoneTasks(tasks: TaskRecord[]): TaskRecord[] {
  return [...tasks].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || b.id.localeCompare(a.id))
}

export interface WorkspaceTaskGroup {
  workspaceId: string | undefined
  workspaceName: string
  tasks: TaskRecord[]
}

/** Resolve display name for a workspace. */
export function resolveWorkspaceName(
  workspaceId: string | undefined,
  workspaces: Array<{ id: string; title?: string; path?: string }>,
  unassignedLabel: string,
): string {
  if (!workspaceId) return unassignedLabel
  const ws = workspaces.find(w => w.id === workspaceId)
  if (ws?.title && ws.title.trim().length > 0) return ws.title.trim()
  if (ws?.path && ws.path.trim().length > 0) {
    const trimmed = ws.path.trim().replace(/[/\\]+$/, '')
    const base = trimmed.split(/[/\\]/).filter(Boolean).pop()
    return base || trimmed
  }
  return workspaceId.slice(0, 8)
}

export type GroupSortOrder = 'name' | 'latestTask' | 'updated' | 'created' | 'urgency'

/** Group a list of tasks by workspace and sort the groups according to the given order. */
export function groupAndSortTasksByWorkspace(
  tasks: TaskRecord[],
  workspaces: Array<{ id: string; title?: string; path?: string }>,
  unassignedLabel: string,
  sortOrder: GroupSortOrder = 'name',
): WorkspaceTaskGroup[] {
  const map = new Map<string, WorkspaceTaskGroup>()

  for (const task of tasks) {
    const key = task.workspaceId || ''
    let group = map.get(key)
    if (group === undefined) {
      const name = resolveWorkspaceName(task.workspaceId, workspaces, unassignedLabel)
      group = {
        workspaceId: task.workspaceId,
        workspaceName: name,
        tasks: [],
      }
      map.set(key, group)
    }
    group.tasks.push(task)
  }

  const list = Array.from(map.values())

  // Ensure tasks inside each group are properly sorted according to sortOrder
  if (sortOrder === 'latestTask' || sortOrder === 'updated') {
    for (const group of list) {
      group.tasks.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || b.id.localeCompare(a.id))
    }
  } else if (sortOrder === 'created') {
    for (const group of list) {
      group.tasks.sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
    }
  }

  list.sort((a, b) => {
    if (sortOrder === 'latestTask' || sortOrder === 'updated') {
      const aTime = a.tasks.length > 0 ? Math.max(...a.tasks.map(t => t.updatedAt)) : 0
      const bTime = b.tasks.length > 0 ? Math.max(...b.tasks.map(t => t.updatedAt)) : 0
      if (bTime !== aTime) return bTime - aTime
      if (!a.workspaceId && b.workspaceId) return 1
      if (a.workspaceId && !b.workspaceId) return -1
      return a.workspaceName.localeCompare(b.workspaceName, undefined, { numeric: true, sensitivity: 'base' })
    }

    if (sortOrder === 'created') {
      const aTime = a.tasks.length > 0 ? Math.max(...a.tasks.map(t => t.createdAt)) : 0
      const bTime = b.tasks.length > 0 ? Math.max(...b.tasks.map(t => t.createdAt)) : 0
      if (bTime !== aTime) return bTime - aTime
      if (!a.workspaceId && b.workspaceId) return 1
      if (a.workspaceId && !b.workspaceId) return -1
      return a.workspaceName.localeCompare(b.workspaceName, undefined, { numeric: true, sensitivity: 'base' })
    }

    if (sortOrder === 'urgency') {
      const aRank = a.tasks.length > 0 ? Math.min(...a.tasks.map(t => URGENCY_RANK[t.urgency])) : 999
      const bRank = b.tasks.length > 0 ? Math.min(...b.tasks.map(t => URGENCY_RANK[t.urgency])) : 999
      if (aRank !== bRank) return aRank - bRank
      const aTime = a.tasks.length > 0 ? Math.max(...a.tasks.map(t => t.updatedAt)) : 0
      const bTime = b.tasks.length > 0 ? Math.max(...b.tasks.map(t => t.updatedAt)) : 0
      if (bTime !== aTime) return bTime - aTime
      if (!a.workspaceId && b.workspaceId) return 1
      if (a.workspaceId && !b.workspaceId) return -1
      return a.workspaceName.localeCompare(b.workspaceName, undefined, { numeric: true, sensitivity: 'base' })
    }

    // Default 'name' sort: alphabetical by workspace name, unassigned pinned to the bottom
    if (!a.workspaceId && b.workspaceId) return 1
    if (a.workspaceId && !b.workspaceId) return -1
    return a.workspaceName.localeCompare(b.workspaceName, undefined, { numeric: true, sensitivity: 'base' })
  })

  return list
}

/**
 * The board view root.
 * @param controller - the controller.
 */
export function TaskBoard({ controller }: { controller: BoardController }) {
  const t = useT()
  const state = useSyncExternalStore(
    cb => controller.subscribe(cb),
    () => controller.getSnapshot(),
  )
  // Minute ticker: re-renders stale-claim highlights even without ledger changes.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  const [onlyNeedsHuman, setOnlyNeedsHuman] = useState(false)
  // Urgency + GitHub-only filters live behind one "more" popover: four chips of
  // permanent toolbar width for filters most sessions never touch.
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false)
  // Column vocabulary: a configured GitHub connection carries its project's
  // Status option names; without one the shipped i18n copy is used. Fetched
  // once per mount — the connection is edited in settings, not per render.
  const [statusMap, setStatusMap] = useState<Partial<Record<TaskStatus, string>>>()
  useEffect(() => {
    let cancelled = false
    void externalRequest<ExternalSyncStatus>('')
      .then(status => { if (!cancelled) setStatusMap(githubStatusMapOf(status.config)) })
      .catch(() => { /* no connection (or route unavailable) → i18n labels */ })
    return () => { cancelled = true }
  }, [])
  const allLive = filterTasks(state, state.ledger.tasks.filter(t => t.trashedAt === undefined))
  const needsHumanCount = allLive.filter(task => humanWaiting(task).needs).length
  const live = onlyNeedsHuman ? allLive.filter(task => humanWaiting(task).needs) : allLive
  // Epic filter (P1 v2): epics are not cards, so the toolbar offers them as a
  // filter dimension; selecting one keeps its descendants at ANY depth.
  const epicOptions = (() => {
    const seen = new Map<string, { repo: string; number: number; title: string; children: number }>()
    for (const record of Object.values(state.ledger.externalSync ?? {})) {
      for (const epic of record.epics ?? []) {
        const key = externalIssueRef(epic.repo, epic.number)
        if (!seen.has(key)) seen.set(key, epic)
      }
    }
    return [...seen.values()].sort((a, b) => a.number - b.number)
  })()
  const parentMap = state.parentFilter === undefined ? undefined : parentsByIssue(state.ledger.tasks)
  const activeFilterCount = state.filters.urgencies.length + (state.filters.externalOnly === true ? 1 : 0)
  // The scope button shows the current narrowing without opening the menu.
  const scopeActive = state.filters.workspaceId !== undefined || state.parentFilter !== undefined
  const scopeLabelText = state.filters.workspaceId !== undefined
    ? (state.workspaces.find(ws => ws.id === state.filters.workspaceId)?.title || state.filters.workspaceId)
    : state.parentFilter !== undefined
      ? `#${state.parentFilter}`
      : ''
  const visibleLive = state.parentFilter === undefined || parentMap === undefined
    ? live
    : live.filter(task => isDescendantOf(task, state.parentFilter!, parentMap))
  const selected = state.selectedId === undefined ? undefined : state.ledger.tasks.find(t => t.id === state.selectedId)
  const detailPanelRef = useRef<HTMLDivElement>(null)

  // Click-outside-to-dismiss: clicking outside the detail panel deselects the task.
  useEffect(() => {
    if (selected === undefined) return

    const onPointerDown = (e: PointerEvent | MouseEvent): void => {
      const panel = detailPanelRef.current
      if (panel === null) return

      const target = e.target as HTMLElement | null
      if (target === null) return

      // Inside detail panel: never dismiss
      if (panel.contains(target)) return

      // Clicking another task card: let card's onClick handle selection switch directly
      if (target.closest('.dsh-atb-card')) return

      // Modals, dropdown menus, context menus: keep existing modal behaviors untouched
      if (target.closest('.dsh-atb-modal, .dsh-atb-modal-backdrop, .dsh-atb-newmenu-backdrop, .dsh-atb-newmenu, .dsh-atb-dropdown, .dsh-atb-btn-menu')) return

      controller.select(undefined)
    }

    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [selected, controller])
  const { alert: showAlert, el: alertEl } = useAlert()
  // + 新建任务 ▼ dropdown (0.4.0): blank / templates / manage / import.
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const closeMenu = (): void => setNewMenuOpen(false)
  // Layout A: one scope picker (project + epic), an overflow menu, and a
  // search field that stays collapsed behind an icon until asked for.
  const [scopeOpen, setScopeOpen] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(state.search.trim().length > 0)
  const searchRef = useRef<HTMLInputElement>(null)
  // Fold/expand toggle for completed tasks (0.8.8)
  const [doneExpanded, setDoneExpanded] = useState(false)

  // Filter chips: everything currently narrowing the board, each removable.
  const activeChips: Array<{ key: string; label: string; value: string; onRemove: () => void }> = []
  if (state.filters.workspaceId !== undefined) {
    const ws = state.workspaces.find(candidate => candidate.id === state.filters.workspaceId)
    activeChips.push({
      key: 'project', label: t('board.chip.project'), value: ws?.title || ws?.path || state.filters.workspaceId,
      onRemove: () => controller.setWorkspaceFilter(undefined),
    })
  }
  if (state.parentFilter !== undefined) {
    const epic = epicOptions.find(candidate => candidate.number === state.parentFilter)
    activeChips.push({
      key: 'epic', label: t('board.chip.parent'), value: epic === undefined ? `#${state.parentFilter}` : `#${epic.number} ${epic.title}`,
      onRemove: () => controller.setParentFilter(undefined),
    })
  }
  for (const urgency of state.filters.urgencies) {
    activeChips.push({
      key: `urgency:${urgency}`, label: t('board.chip.urgency'), value: t(URGENCY_KEYS[urgency]),
      onRemove: () => controller.toggleUrgency(urgency),
    })
  }
  if (state.filters.externalOnly === true) {
    activeChips.push({ key: 'source', label: t('board.chip.source'), value: t('board.filter.external'), onRemove: () => controller.toggleExternalOnly() })
  }
  const clearAllFilters = (): void => {
    controller.setWorkspaceFilter(undefined)
    controller.setParentFilter(undefined)
    for (const urgency of [...state.filters.urgencies]) controller.toggleUrgency(urgency)
    if (state.filters.externalOnly === true) controller.toggleExternalOnly()
  }

  return (
    <div className="dsh-atb-board">
      <div className="dsh-atb-toolbar">
        <h2 className="dsh-atb-title">{t('board.title')}</h2>
        <span className="dsh-atb-count">{visibleLive.length}</span>
        <span className="dsh-atb-rev" title={t('board.rev.title', { rev: state.ledger.revision })}>rev {state.ledger.revision}</span>
        {/* Layout A: the three VIEWS are one segmented control, separate from filters. */}
        <div className="dsh-atb-seg" role="group" aria-label={t('board.view.title')}>
          <button
            type="button"
            data-kind="view-board"
            data-on={!onlyNeedsHuman && !state.secondaryOpen}
            onClick={() => {
              if (state.secondaryOpen) controller.toggleSecondary()
              if (onlyNeedsHuman) setOnlyNeedsHuman(false)
            }}
          >{t('board.view.board')}</button>
          <button
            type="button"
            data-kind="needs-human-filter"
            data-on={onlyNeedsHuman}
            aria-pressed={onlyNeedsHuman}
            title={t('board.filter.needsHumanTitle')}
            onClick={() => {
              if (!onlyNeedsHuman && state.secondaryOpen) controller.toggleSecondary()
              setOnlyNeedsHuman(!onlyNeedsHuman)
            }}
          >{t('board.filter.needsHuman')}{needsHumanCount > 0 ? ` (${needsHumanCount})` : ''}</button>
          <button
            type="button"
            data-kind="view-other"
            data-on={state.secondaryOpen}
            onClick={() => controller.toggleSecondary()}
          >{t('board.action.otherTasks')}</button>
        </div>
        <div className="dsh-atb-newmenu dsh-atb-new-task">
          <button
            type="button"
            className="dsh-atb-btn"
            data-primary="true"
            onClick={() => {
              const next = !newMenuOpen
              setNewMenuOpen(next)
              if (next) controller.prepareTemplateMenu()
            }}
          >
            {t('board.action.newTask')}
          </button>
          {newMenuOpen && (
            <>
              <div className="dsh-atb-newmenu-backdrop" onClick={closeMenu} />
              <div className="dsh-atb-newmenu-list">
                <button type="button" className="dsh-atb-newmenu-opt" onClick={() => { closeMenu(); controller.setComposer(true) }}>{t('board.action.blankTask')}</button>
                {groupTemplatesByCategory(state.templates).map(group => (
                  <div key={group.category ?? '\u0000'} className="dsh-atb-newmenu-catgroup">
                    <div className="dsh-atb-newmenu-cat">{categoryLabel(group.category, t)} ({group.templates.length})</div>
                    {group.templates.map(tpl => {
                      const name = localizeBuiltinName(tpl)
                      const spec = localizeBuiltinTask(tpl)
                      return (
                        <button
                          key={tpl.id}
                          type="button"
                          className="dsh-atb-newmenu-opt"
                          title={spec.description !== undefined && spec.description.length > 0 ? spec.description.slice(0, 120) : name}
                          onClick={() => { closeMenu(); controller.newFromTemplate(spec) }}
                        >
                          {name}
                        </button>
                      )
                    })}
                  </div>
                ))}
                <div className="dsh-atb-newmenu-sep" />
                <button type="button" className="dsh-atb-newmenu-opt" onClick={() => { closeMenu(); controller.openTemplateManager() }}>{t('board.action.manageTemplates')}</button>
              </div>
            </>
          )}
        </div>
        <div className="dsh-atb-spacer" />
        {/* Search collapses to an icon (layout A). The input stays mounted so
            typing state and tests do not depend on the animation finishing. */}
        <div className="dsh-atb-searchwrap" data-kind="search" data-expanded={searchOpen}>
          <button
            type="button"
            className="dsh-atb-btn"
            data-kind="search-toggle"
            title={t('board.search.toggle')}
            onClick={() => {
              setSearchOpen(true)
              queueMicrotask(() => searchRef.current?.focus())
            }}
          >🔍</button>
          <input
            ref={searchRef}
            className="dsh-atb-input dsh-atb-search"
            value={state.search}
            placeholder={t('board.search.placeholder')}
            spellCheck={false}
            onChange={e => controller.setSearch(e.target.value)}
            onBlur={() => { if (state.search.trim().length === 0) setSearchOpen(false) }}
          />
        </div>
        {/* Scope = project + epic in ONE picker (layout A). */}
        <div className="dsh-atb-newmenu">
          <button
            type="button"
            className="dsh-atb-btn"
            data-kind="scope"
            data-on={state.filters.workspaceId !== undefined || state.parentFilter !== undefined}
            aria-expanded={scopeOpen}
            onClick={() => setScopeOpen(open => !open)}
          >{t('board.filter.scope')}{scopeActive ? `：${scopeLabelText}` : ''} <span className="dsh-atb-caret">▾</span></button>
          {scopeOpen && (
            <>
              <div className="dsh-atb-newmenu-backdrop" onClick={() => setScopeOpen(false)} />
              <div className="dsh-atb-newmenu-menu" data-kind="scope-menu">
                <div className="dsh-atb-menu-label">{t('board.filter.scopeProject')}</div>
                <button
                  type="button"
                  className="dsh-atb-newmenu-opt"
                  data-scope="project"
                  data-value=""
                  data-selected={state.filters.workspaceId === undefined}
                  onClick={() => { setScopeOpen(false); controller.setWorkspaceFilter(undefined) }}
                >{t('board.filter.allProjects')}</button>
                {state.workspaces.map(ws => (
                  <button
                    key={ws.id}
                    type="button"
                    className="dsh-atb-newmenu-opt"
                    data-scope="project"
                    data-value={ws.id}
                    data-selected={state.filters.workspaceId === ws.id}
                    onClick={() => { setScopeOpen(false); controller.setWorkspaceFilter(ws.id) }}
                  >{ws.title || ws.path}</button>
                ))}
                {epicOptions.length > 0 && (
                  <>
                    <div className="dsh-atb-menu-label" title={t('board.filter.parentTitle')}>{t('board.filter.scopeEpic')}</div>
                    <button
                      type="button"
                      className="dsh-atb-newmenu-opt"
                      data-scope="epic"
                      data-value=""
                      data-selected={state.parentFilter === undefined}
                      onClick={() => { setScopeOpen(false); controller.setParentFilter(undefined) }}
                    >{t('board.filter.parentAll')}</button>
                    {epicOptions.map(epic => (
                      <button
                        key={externalIssueRef(epic.repo, epic.number)}
                        type="button"
                        className="dsh-atb-newmenu-opt"
                        data-scope="epic"
                        data-value={String(epic.number)}
                        data-selected={state.parentFilter === epic.number}
                        onClick={() => { setScopeOpen(false); controller.setParentFilter(epic.number) }}
                      >{`#${epic.number} ${epic.title}`}</button>
                    ))}
                  </>
                )}
              </div>
            </>
          )}
        </div>
        <div className="dsh-atb-newmenu">
          <button
            type="button"
            className="dsh-atb-btn"
            data-kind="more-filter"
            data-on={activeFilterCount > 0}
            aria-expanded={moreFiltersOpen}
            title={t('board.filter.moreTitle')}
            onClick={() => setMoreFiltersOpen(open => !open)}
          >
            🧰 {t('board.filter.more')}
            {activeFilterCount > 0 ? ` ${activeFilterCount}` : ''}
          </button>
          {moreFiltersOpen && (
            <>
              <div className="dsh-atb-newmenu-backdrop" onClick={() => setMoreFiltersOpen(false)} />
              <div className="dsh-atb-newmenu-menu dsh-atb-more-menu" data-kind="more-menu">
                <div className="dsh-atb-more-row">
                  {(['urgent', 'normal', 'relaxed'] as const).map(u => (
                    <button
                      key={u}
                      type="button"
                      className="dsh-atb-chip"
                      data-urgency={u}
                      data-on={state.filters.urgencies.includes(u)}
                      onClick={() => controller.toggleUrgency(u)}
                    >
                      <span className="dsh-atb-dot" data-urgency={u} />
                      {t(URGENCY_KEYS[u])}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="dsh-atb-chip"
                  data-kind="external-filter"
                  data-on={state.filters.externalOnly === true}
                  aria-pressed={state.filters.externalOnly === true}
                  title={t('board.filter.externalTitle')}
                  onClick={() => controller.toggleExternalOnly()}
                >
                  🐙 {t('board.filter.external')}
                </button>
                <div className="dsh-atb-menu-label">{t('board.sort.title')}</div>
                {(['default', 'updated', 'urgency', 'created', 'title'] as const).map(key => (
                  <button
                    key={key}
                    type="button"
                    className="dsh-atb-newmenu-opt"
                    data-sort={key}
                    data-selected={state.sortBy === key}
                    onClick={() => controller.setSortBy(key)}
                  >{t(`board.sort.${key === 'title' ? 'byTitle' : key}`)}</button>
                ))}
              </div>
            </>
          )}
        </div>
        {/* Overflow: admin actions and the version live here, not on the bar. */}
        <div className="dsh-atb-newmenu">
          <button
            type="button"
            className="dsh-atb-btn dsh-atb-btn-icon"
            data-kind="more-actions"
            title={t('board.menu.more')}
            onClick={() => setActionsOpen(open => !open)}
          >⋯</button>
          {actionsOpen && (
            <>
              <div className="dsh-atb-newmenu-backdrop" onClick={() => setActionsOpen(false)} />
              <div className="dsh-atb-newmenu-menu" data-kind="more-actions-menu">
                <button type="button" className="dsh-atb-newmenu-opt" data-action="employees" title={t('board.action.employeesTitle')} onClick={() => { setActionsOpen(false); controller.openEmployees() }}>👥 {t('board.action.employees')}</button>
                <button type="button" className="dsh-atb-newmenu-opt" data-action="settings" title={t('board.action.settingsTitle')} onClick={() => { setActionsOpen(false); controller.openSettings() }}>⚙ {t('board.action.settings')}</button>
                <button type="button" className="dsh-atb-newmenu-opt" data-action="diag" title={t('board.action.diagTitle')} onClick={() => { setActionsOpen(false); controller.openDiagnostics() }}>🩺 {t('board.action.diag')}</button>
                <div className="dsh-atb-newmenu-sep" />
                <button type="button" className="dsh-atb-newmenu-opt" data-action="import" title={t('board.action.importTitle')} onClick={() => { setActionsOpen(false); controller.openImport() }}>⬆ {t('board.action.import')}</button>
                <button type="button" className="dsh-atb-newmenu-opt" data-action="export-json" title={t('board.export.jsonTitle')} onClick={() => { setActionsOpen(false); void controller.exportJson() }}>⬇ {t('board.export.json')}</button>
                <button type="button" className="dsh-atb-newmenu-opt" data-action="export-csv" title={t('board.export.csvTitle')} onClick={() => { setActionsOpen(false); void controller.exportCsv() }}>⬇ {t('board.export.csv')}</button>
                <div className="dsh-atb-newmenu-sep" />
                <div className="dsh-atb-menu-label" data-kind="version">
                  <a className="dsh-atb-ver" href="https://github.com/cloader/dsh-taskboard" target="_blank" rel="noopener noreferrer">V{PLUGIN_VERSION}</a>
                </div>
              </div>
            </>
          )}
        </div>

      </div>

      {activeChips.length > 0 && (
        <div className="dsh-atb-filterbar" data-kind="filter-bar">
          {activeChips.map(chip => (
            <span key={chip.key} className="dsh-atb-filterchip" data-kind="filter-chip" data-chip={chip.key}>
              <span className="dsh-atb-filterchip-label">{chip.label}</span> <b>{chip.value}</b>
              <button type="button" className="dsh-atb-filterchip-x" aria-label={t('board.chip.remove')} onClick={chip.onRemove}>×</button>
            </span>
          ))}
          <button type="button" className="dsh-atb-filterclear" data-kind="filter-clear" onClick={clearAllFilters}>{t('board.chip.clear')}</button>
        </div>
      )}

      {state.error !== undefined && <div className="dsh-atb-error">{state.error}</div>}

      {state.secondaryOpen
        ? <SecondaryTab controller={controller} tasks={filterTasks(state, state.ledger.tasks)} />
        : (
          <div className="dsh-atb-columns">
            {MAIN_STATUSES.map(status => {
              const rawColumnTasks = visibleLive.filter(t => t.status === status)
              const isBacklog = status === 'backlog'
              const isTodo = status === 'todo'
              const isDone = status === 'done'
              const columnTasks = isDone && state.sortBy !== 'title'
                ? sortDoneTasks(rawColumnTasks)
                : rawColumnTasks

              const onDragOver = (e: React.DragEvent<HTMLElement>) => {
                if (e.dataTransfer.types.includes(DRAG_TYPE)) {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  e.currentTarget.dataset.dragover = 'true'
                }
              }
              const onDragLeave = (e: React.DragEvent<HTMLElement>) => {
                delete e.currentTarget.dataset.dragover
              }
              const onDrop = (e: React.DragEvent<HTMLElement>) => {
                e.preventDefault()
                delete e.currentTarget.dataset.dragover
                const id = e.dataTransfer.getData(DRAG_TYPE)
                if (id.length === 0) return
                const task = state.ledger.tasks.find(t => t.id === id)
                if (task === undefined || task.status === status) return
                if (!canTransition(task.status, status)) {
                  showAlert(t('board.drag.forbidden', { from: columnLabel(t, task.status, statusMap), to: columnLabel(t, status, statusMap) }))
                  return
                }
                void controller.move(id, task.version, status)
              }

              const isCollapsed = state.collapsedColumns.includes(status)
              if (isCollapsed) {
                const expandTitle = t(COLUMN_EXPAND_KEYS[status] ?? COLUMN_KEYS[status])
                const onExpand = () => { controller.setColumnCollapsed(status, false) }
                const count = isDone ? (state.doneCount ?? columnTasks.length) : columnTasks.length

                return (
                  <div
                    className="dsh-atb-column"
                    key={status}
                    data-collapsed="true"
                    onDragOver={onDragOver}
                    onDragLeave={onDragLeave}
                    onDrop={onDrop}
                  >
                    <div
                      className="dsh-atb-col-collapsed-bar"
                      title={expandTitle}
                      onClick={onExpand}
                    >
                      <button
                        type="button"
                        className="dsh-atb-colfoldbtn"
                        title={expandTitle}
                        onClick={(e) => {
                          e.stopPropagation()
                          onExpand()
                        }}
                      >
                        <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                          <path d="M6 3.5a.5.5 0 0 1 .854-.354l4 4a.5.5 0 0 1 0 .708l-4 4A.5.5 0 0 1 6 11.5v-8z" />
                        </svg>
                      </button>
                      <div className="dsh-atb-col-collapsed-title">
                        <span className="dsh-atb-dot" data-status={status} />
                        <span className="dsh-atb-col-collapsed-text">{columnLabel(t, status, statusMap)}</span>
                      </div>
                      <span className="dsh-atb-colcount">{count}</span>
                    </div>
                  </div>
                )
              }

              const doneLimit = completedDisplayLimitOf(state.ledger.settings)
              const isSearching = state.search.trim().length > 0
              const isFolded = isDone && !isSearching && !doneExpanded && columnTasks.length > doneLimit
              const visibleTasks = isFolded ? columnTasks.slice(0, doneLimit) : columnTasks
              const foldedCount = columnTasks.length - visibleTasks.length
              const groupSortOrder: GroupSortOrder = isDone
                ? (state.sortBy === 'title' ? 'name' : 'latestTask')
                : (state.sortBy === 'updated' ? 'updated'
                    : state.sortBy === 'created' ? 'created'
                    : state.sortBy === 'urgency' ? 'urgency'
                    : 'name')
              const workspaceGroups = groupAndSortTasksByWorkspace(
                visibleTasks,
                state.workspaces,
                t('board.workspace.unassigned'),
                groupSortOrder,
              )

              return (
                <div
                  className="dsh-atb-column"
                  key={status}
                  onDragOver={onDragOver}
                  onDragLeave={onDragLeave}
                  onDrop={onDrop}
                >
                  <div className="dsh-atb-colhead">
                    <span className="dsh-atb-dot" data-status={status} />
                    {columnLabel(t, status, statusMap)}
                    <span className="dsh-atb-colcount">{columnTasks.length}</span>
                    {status === 'in_progress' && (
                      <button
                        type="button"
                        className="dsh-atb-queuechip"
                        title={t('queue.panel.title')}
                        data-bad={(state.queue?.depth ?? 0) > 0 ? 'true' : undefined}
                        onClick={() => controller.openQueuePanel()}
                      >{t('board.queue.chip', { n: state.queue?.depth ?? 0 })}</button>
                    )}
                    {COLUMN_COLLAPSE_KEYS[status] !== undefined && (
                      <button
                        type="button"
                        className="dsh-atb-colfoldbtn"
                        title={t(COLUMN_COLLAPSE_KEYS[status]!)}
                        onClick={() => controller.setColumnCollapsed(status, true)}
                      >
                        <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                          <path d="M10 3.5a.5.5 0 0 0-.854-.354l-4 4a.5.5 0 0 0 0 .708l4 4a.5.5 0 0 0 .854-.354v-8z" />
                        </svg>
                      </button>
                    )}
                  </div>
                  <div className="dsh-atb-cards">
                    {workspaceGroups.map(group => (
                      <div className="dsh-atb-ws-group" key={group.workspaceId ?? 'unassigned'}>
                        <button type="button" className="dsh-atb-ws-group-head"
                          aria-expanded={!controller.isWorkspaceGroupCollapsed(status, group.workspaceId)}
                          aria-label={t(controller.isWorkspaceGroupCollapsed(status, group.workspaceId) ? 'board.workspace.expand' : 'board.workspace.collapse', { name: group.workspaceName })}
                          title={group.workspaceName}
                          onClick={() => controller.toggleWorkspaceGroup(status, group.workspaceId)}>
                          <svg className="dsh-atb-ws-group-chevron" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m5 3 5 5-5 5" /></svg>
                          <span className="dsh-atb-ws-group-icon">
                            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M1.5 3.5a1 1 0 0 1 1-1h3.5a1 1 0 0 1 .8.4L8 4.5h5.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-8z" />
                            </svg>
                          </span>
                          <span className="dsh-atb-ws-group-name">{group.workspaceName}</span>
                          <span className="dsh-atb-ws-group-count">{group.tasks.length}</span>
                        </button>
                        <div className="dsh-atb-ws-group-cards" hidden={controller.isWorkspaceGroupCollapsed(status, group.workspaceId)}>
                          {group.tasks.map(task => (
                            <TaskCard
                              key={task.id}
                              task={task}
                              controller={controller}
                              draggable
                              now={now}
                              onAlert={showAlert}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                    {columnTasks.length === 0 && <div className="dsh-atb-empty">{t('board.empty')}</div>}
                    {isDone && !isSearching && columnTasks.length > doneLimit && (
                      <div className="dsh-atb-done-foldbar">
                        {!doneExpanded ? (
                          <>
                            <span className="dsh-atb-done-foldtip">{t('board.done.folded', { n: foldedCount })}</span>
                            <button
                              type="button"
                              className="dsh-atb-btn dsh-atb-done-foldbtn"
                              onClick={() => setDoneExpanded(true)}
                            >
                              {t('board.done.expandAll')}
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="dsh-atb-btn dsh-atb-done-foldbtn"
                            onClick={() => setDoneExpanded(false)}
                          >
                            {t('board.done.collapse')}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

      {selected !== undefined && (
        <div ref={detailPanelRef} className="dsh-atb-detailpanel">
          {/* key: remount per task — without it, confirm states and comment
              drafts leak across task switches (review P0). */}
          <TaskDetail key={selected.id} task={selected} controller={controller} now={now} />
        </div>
      )}

      {state.composerOpen && (
        <TaskFormModal
          controller={controller}
          task={state.editingId === undefined ? undefined : state.ledger.tasks.find(t => t.id === state.editingId)}
        />
      )}

      {state.diagOpen && <DiagnosticsPanel controller={controller} />}

      {state.queueOpen && <QueuePanel controller={controller} onAlert={showAlert} />}

      {state.settingsOpen && <SettingsModal controller={controller} />}

      {state.importOpen && <ImportModal controller={controller} />}

      {state.tplManagerOpen && <TemplateManager controller={controller} />}

      {state.employeesOpen && <EmployeesModal controller={controller} />}

      {alertEl}
    </div>
  )
}

/** 📋 Execution-queue popup (in-progress column chip): depth, oldest wait, and a
 *  double-confirm "clear queue" that drops every durable queue entry. */
function QueuePanel({ controller, onAlert }: { controller: BoardController; onAlert: (msg: string) => void }) {
  const t = useT()
  const state = controller.getSnapshot()
  const queue = state.queue
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const depth = queue?.depth ?? 0
  const wait = queue?.oldestWaitMinutes
  const clear = async (): Promise<void> => {
    if (!armed) { setArmed(true); return }
    setBusy(true)
    const result = await controller.clearQueue()
    setBusy(false)
    setArmed(false)
    if (result !== undefined) {
      onAlert(t('queue.cleared', { n: result.cleared }))
      controller.closeQueuePanel()
    }
  }
  return (
    <div className="dsh-atb-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) controller.closeQueuePanel() }}>
      <div className="dsh-atb-modal dsh-atb-queuepanel" role="dialog" aria-modal="true" aria-label={t('queue.panel.title')}>
        <div className="dsh-atb-modal-head">
          <span className="dsh-atb-modal-headicon">📋</span>
          <div className="dsh-atb-modal-headtext">
            <h3>{t('queue.panel.title')}</h3>
          </div>
          <button type="button" className="dsh-atb-modal-close" aria-label={t('shared.close')} onClick={() => controller.closeQueuePanel()}>✕</button>
        </div>
        <div className="dsh-atb-modal-body">
          <div className="dsh-atb-diag-grid">
            <div className="dsh-atb-diag-item" data-bad={depth > 0 ? 'true' : undefined}><b>{depth}</b><span>{t('queue.depth')}</span></div>
            <div className="dsh-atb-diag-item" data-bad={wait !== undefined && wait > 5 ? 'true' : undefined}><b>{wait ?? 0}m</b><span>{t('queue.wait')}</span></div>
          </div>
          <div className="dsh-atb-queuepanel-actions">
            <button
              type="button"
              className="dsh-atb-btn"
              disabled={depth === 0 || busy}
              data-armed={armed ? 'true' : undefined}
              onClick={() => { void clear() }}
            >{armed ? t('queue.confirm') : t('queue.clear')}</button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** ⚙ Health-diagnostics panel (plan §3.6): ledger basics + orphan worktrees + one-click cleanup. */
function DiagnosticsPanel({ controller }: { controller: BoardController }) {
  const t = useT()
  const state = controller.getSnapshot()
  const diag = state.diagnostics
  const wsName = (id: string): string => {
    const ws = state.workspaces.find(w => w.id === id)
    return ws?.title ?? ws?.path ?? id.slice(0, 8)
  }
  return (
    <div className="dsh-atb-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) controller.closeDiagnostics() }}>
      <div className="dsh-atb-modal dsh-atb-diag" role="dialog" aria-modal="true" aria-label={t('diag.title')}>
        <div className="dsh-atb-modal-head">
          <span className="dsh-atb-modal-headicon">⚙</span>
          <div className="dsh-atb-modal-headtext">
            <h3>{t('diag.title')}</h3>
            <p>{t('diag.subtitle')}</p>
          </div>
          <button type="button" className="dsh-atb-modal-close" aria-label={t('shared.close')} onClick={() => controller.closeDiagnostics()}>✕</button>
        </div>
        <div className="dsh-atb-modal-body">
          {diag === undefined
            ? <div className="dsh-atb-empty2">{t('shared.loading')}</div>
            : (
              <>
                <div className="dsh-atb-diag-grid">
                  <div className="dsh-atb-diag-item"><b>{diag.revision}</b><span>{t('diag.revision')}</span></div>
                  <div className="dsh-atb-diag-item"><b>{diag.tasks}</b><span>{t('diag.tasks')}</span></div>
                  <div className="dsh-atb-diag-item" data-bad={diag.staleRunning > 0 ? 'true' : undefined}><b>{diag.staleRunning}</b><span>{t('diag.running')}</span></div>
                  <div className="dsh-atb-diag-item" data-bad={diag.orphanWorktrees.length > 0 ? 'true' : undefined}><b>{diag.orphanWorktrees.length}</b><span>{t('diag.orphans')}</span></div>
                </div>
                <div className="dsh-atb-diag-sec">
                  <h4>{t('diag.orphans.heading')}</h4>
                  {diag.orphanWorktrees.length === 0
                    ? <div className="dsh-atb-empty2">{t('diag.orphans.none')}</div>
                    : (
                        <div className="dsh-atb-diag-orphans">
                          {diag.orphanWorktrees.map(o => (
                            <div key={o.path} className="dsh-atb-diag-orphan">
                              <span className="dsh-atb-diag-orphan-path" title={o.path}>{wsName(o.workspaceId)} · {o.taskId}</span>
                              <button type="button" className="dsh-atb-btn" data-danger="true" onClick={() => void controller.cleanupOrphan(o.workspaceId, o.taskId)}>{t('diag.orphans.cleanup')}</button>
                            </div>
                          ))}
                        </div>
                      )}
                  <div className="dsh-atb-empty2">{t('diag.orphans.hint')}</div>
                </div>
                <div className="dsh-atb-diag-sec">
                  <h4>{t('diag.gitignore.heading')}</h4>
                  {(diag.gitIgnoreSuggestions ?? []).length === 0
                    ? <div className="dsh-atb-empty2">{t('diag.gitignore.none')}</div>
                    : (
                        <div className="dsh-atb-diag-orphans">
                          {diag.gitIgnoreSuggestions.map(s => (
                            <div key={s.workspaceId} className="dsh-atb-diag-orphan">
                              <span className="dsh-atb-diag-orphan-path" title={s.workspacePath}>
                                {wsName(s.workspaceId)} · {t('diag.gitignore.suggestA')} <code>.dsh-worktrees/</code>{t('diag.gitignore.suggestB')}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                </div>
              </>
            )}
        </div>
      </div>
    </div>
  )
}

/** Secondary tab: tasks grouped into canceled / archived / trashed columns. */
function SecondaryTab({ controller, tasks }: { controller: BoardController; tasks: TaskRecord[] }) {
  const t = useT()
  /** Which column is in card-selection mode ('none' = checkboxes hidden everywhere). */
  const [selecting, setSelecting] = useState<'none' | 'trashArchived' | 'purgeTrashed'>('none')
  const [batchBusy, setBatchBusy] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  // Trashed takes precedence (a trashed task still carries its old status,
  // but what matters to the user is the pending purge).
  const trashed = tasks.filter(t => t.trashedAt !== undefined)
  const archived = tasks.filter(t => t.trashedAt === undefined && t.status === 'archived')

  const toggleSelected = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** Select-all toggle for one column: if everything is selected, clear the column; otherwise add all. */
  const toggleAll = (rows: TaskRecord[]) => {
    setSelected(prev => {
      const allSelected = rows.length > 0 && rows.every(r => prev.has(r.id))
      const next = new Set(prev)
      for (const r of rows) {
        if (allSelected) next.delete(r.id)
        else next.add(r.id)
      }
      return next
    })
  }

  /** Run a batch action on the selected tasks of the column; failures are skipped one by one. */
  const runBatch = async (kind: 'trashArchived' | 'purgeTrashed') => {
    const source = kind === 'trashArchived' ? archived : trashed
    const targets = source.filter(task => selected.has(task.id))
    setBatchBusy(true)
    try {
      for (const task of targets) {
        try { await controller.remove(task.id, task.version, kind === 'purgeTrashed') } catch { /* skip stale/conflicting/purge-refused card */ }
        setSelected(prev => {
          const next = new Set(prev)
          next.delete(task.id)
          return next
        })
      }
    } finally {
      setBatchBusy(false)
      setSelecting('none')
      setSelected(new Set())
    }
  }

  /** Exit selection mode and drop the current selection. */
  const cancelSelecting = () => {
    setSelecting('none')
    setSelected(new Set())
  }

  const groups: { label: string; dot: string; rows: TaskRecord[]; action?: 'trashArchived' | 'purgeTrashed' }[] = [
    { label: t('status.column.archived'), dot: 'archived', rows: archived, action: 'trashArchived' },
    { label: t('board.group.trashed'), dot: 'trashed', rows: trashed, action: 'purgeTrashed' },
  ]
  if (trashed.length + archived.length === 0) {
    return (
      <div className="dsh-atb-secondary">
        <div className="dsh-atb-empty">{t('board.secondary.empty')}</div>
      </div>
    )
  }
  return (
    <div className="dsh-atb-columns">
      {groups.map(group => {
        const selectingThis = selecting === group.action
        const selectedCount = selectingThis ? group.rows.filter(r => selected.has(r.id)).length : 0
        const allSelected = group.rows.length > 0 && selectedCount === group.rows.length
        return (
        <div className="dsh-atb-column" key={group.label}>
          <div className="dsh-atb-colhead">
            <span className="dsh-atb-dot" data-status={group.dot} />
            {group.label}
            <span className="dsh-atb-colcount">{group.rows.length}</span>
            {group.action && group.rows.length > 0 && (
              selectingThis ? (
                <>
                  <button
                    type="button"
                    className="dsh-atb-btn"
                    disabled={batchBusy}
                    title={t('board.batch.confirmCancelTip')}
                    onClick={cancelSelecting}
                  >{t('board.batch.cancel')}</button>
                  <button
                    type="button"
                    className="dsh-atb-btn"
                    data-danger="true"
                    disabled={batchBusy || selectedCount === 0}
                    title={selectedCount === 0 ? t('board.batch.noneSelected') : t('board.batch.confirmTip')}
                    onClick={() => { void runBatch(group.action!) }}
                  >{t('board.batch.confirm')}({selectedCount})</button>
                  <input
                    type="checkbox"
                    className="dsh-atb-selectall"
                    checked={allSelected}
                    disabled={batchBusy}
                    title={t('board.batch.selectAll')}
                    onClick={e => e.stopPropagation()}
                    onChange={() => toggleAll(group.rows)}
                  />
                </>
              ) : (
                <button
                  type="button"
                  className="dsh-atb-btn"
                  disabled={batchBusy}
                  title={group.action === 'trashArchived' ? t('board.batch.trashArchivedTip') : t('board.batch.purgeTrashedTip')}
                  onClick={() => { setSelecting(group.action!); setSelected(new Set()) }}
                >{group.action === 'trashArchived' ? t('board.batch.trashArchived') : t('board.batch.purgeTrashed')}</button>
              )
            )}
          </div>
          <div className="dsh-atb-cards">
            {(() => {
              const secSortBy = controller.getSnapshot().sortBy
              const secGroupSortOrder: GroupSortOrder = secSortBy === 'updated' ? 'updated'
                : secSortBy === 'created' ? 'created'
                : secSortBy === 'urgency' ? 'urgency'
                : 'name'
              return groupAndSortTasksByWorkspace(
                group.rows,
                controller.getSnapshot().workspaces,
                t('board.workspace.unassigned'),
                secGroupSortOrder,
              )
            })().map(wsGroup => (
              <div className="dsh-atb-ws-group" key={wsGroup.workspaceId ?? 'unassigned'}>
                <button type="button" className="dsh-atb-ws-group-head"
                          aria-expanded={!controller.isWorkspaceGroupCollapsed(group.dot, wsGroup.workspaceId)}
                          aria-label={t(controller.isWorkspaceGroupCollapsed(group.dot, wsGroup.workspaceId) ? 'board.workspace.expand' : 'board.workspace.collapse', { name: wsGroup.workspaceName })}
                          title={wsGroup.workspaceName}
                          onClick={() => controller.toggleWorkspaceGroup(group.dot, wsGroup.workspaceId)}>
                          <svg className="dsh-atb-ws-group-chevron" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m5 3 5 5-5 5" /></svg>
                  <span className="dsh-atb-ws-group-icon">
                    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M1.5 3.5a1 1 0 0 1 1-1h3.5a1 1 0 0 1 .8.4L8 4.5h5.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-8z" />
                    </svg>
                  </span>
                  <span className="dsh-atb-ws-group-name">{wsGroup.workspaceName}</span>
                  <span className="dsh-atb-ws-group-count">{wsGroup.tasks.length}</span>
                </button>
                <div className="dsh-atb-ws-group-cards" hidden={controller.isWorkspaceGroupCollapsed(group.dot, wsGroup.workspaceId)}>
                  {wsGroup.tasks.map(task => (
                    group.action && selectingThis ? (
                      <div className="dsh-atb-selrow" key={task.id}>
                        <input
                          type="checkbox"
                          className="dsh-atb-selbox"
                          checked={selected.has(task.id)}
                          disabled={batchBusy}
                          onClick={e => e.stopPropagation()}
                          onChange={() => toggleSelected(task.id)}
                        />
                        <TaskCard task={task} controller={controller} />
                      </div>
                    ) : (
                      <TaskCard key={task.id} task={task} controller={controller} />
                    )
                  ))}
                </div>
              </div>
            ))}
            {group.rows.length === 0 && <div className="dsh-atb-empty">{t('board.empty')}</div>}
          </div>
        </div>
        )
      })}
    </div>
  )
}
