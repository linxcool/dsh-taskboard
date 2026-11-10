/**
 * Employee catalog (P3 v2): every DSH agent preset is a card whose ROLE and
 * default PERMISSION are explicit data on the board's employee table — never
 * inferred from the preset's name.
 *
 * Four states per card: bound+enabled, bound+disabled, unassigned (no row
 * yet), stale (a row whose preset is gone). Roles and permissions are edited
 * right here; the table is a whole-table write through the controller.
 *
 * @module dsh-taskboard/client/board/EmployeesModal
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { BoardController } from '../controller.ts'
import type { CatalogPresetItem } from '../../shared/api.ts'
import {
  permissionForCreate, type EmployeeBinding, type EmployeeRole,
  type PermissionMode, type TaskRecord,
} from '../../shared/protocol.ts'
import { useT } from '../i18n/runtime.ts'

/** Main-board statuses whose cards can be reviewed. */
const REVIEWABLE: ReadonlyArray<TaskRecord['status']> = ['in_progress', 'in_review']

const PERMISSIONS: ReadonlyArray<{ value: PermissionMode; key: string }> = [
  { value: 'workspace-write', key: 'form.perm.write' },
  { value: 'read-only', key: 'form.perm.readOnly' },
  { value: 'danger-full-access', key: 'form.perm.fullAccess' },
]

/** The employee catalog modal. */
export function EmployeesModal({ controller }: { controller: BoardController }) {
  const t = useT()
  const state = useSyncExternalStore(
    cb => controller.subscribe(cb),
    () => controller.getSnapshot(),
  )
  const [presets, setPresets] = useState<CatalogPresetItem[]>()
  const [defaultId, setDefaultId] = useState<string>()
  const [error, setError] = useState<string>()
  /** Preset awaiting a review source-task choice. */
  const [picking, setPicking] = useState<string>()

  useEffect(() => {
    let cancelled = false
    void controller.fetchPresetCatalog()
      .then(roster => {
        if (cancelled) return
        setPresets(roster.presets)
        setDefaultId(roster.defaultId)
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        setError(reason instanceof Error ? reason.message : String(reason))
        setPresets([])
      })
    return () => { cancelled = true }
  }, [controller])

  const employees = state.ledger.employees ?? []
  const globalRow = (presetId: string): EmployeeBinding | undefined =>
    employees.find(row => row.presetId === presetId && row.projectId === undefined)

  /** Replace the global row for one preset (or drop it when `undefined`). */
  const write = (presetId: string, row: EmployeeBinding | undefined): void => {
    const rest = employees.filter(entry => !(entry.presetId === presetId && entry.projectId === undefined))
    void controller.saveBindings(row === undefined ? rest : [...rest, row])
  }

  const cycleRole = (presetId: string, row: EmployeeBinding): void => {
    const next: EmployeeBinding = { ...row, role: row.role === 'maker' ? 'reviewer' : 'maker' }
    // A maker can never be the default reviewer.
    delete next.defaultReviewer
    write(presetId, next)
  }

  const setPermission = (presetId: string, row: EmployeeBinding, value: string): void => {
    const next: EmployeeBinding = { ...row }
    if (value === '') delete next.permission
    else next.permission = value as PermissionMode
    write(presetId, next)
  }

  const setEnabled = (presetId: string, row: EmployeeBinding, enabled: boolean): void => {
    const next: EmployeeBinding = { ...row, enabled }
    if (!enabled) delete next.defaultReviewer
    write(presetId, next)
  }

  const star = (presetId: string, row: EmployeeBinding): void => {
    // Exactly one starred reviewer: starring one un-stars every other row.
    const next = employees.map(entry => {
      const copy: EmployeeBinding = { ...entry }
      delete copy.defaultReviewer
      if (entry.presetId === presetId && entry.projectId === undefined && row.defaultReviewer !== true) {
        copy.defaultReviewer = true
      }
      return copy
    })
    void controller.saveBindings(next)
  }

  const assign = (presetId: string, role: EmployeeRole): void => {
    write(presetId, { presetId, role, enabled: true })
  }

  const unbind = (presetId: string): void => { write(presetId, undefined) }

  /** The most recent execution session for this preset (derived, never stored). */
  const latestSession = (presetId: string): string | undefined => {
    let best: { sessionId: string; at: number } | undefined
    for (const task of state.ledger.tasks) {
      if (task.presetId !== presetId) continue
      for (const execution of task.executions) {
        if (execution.sessionId === undefined) continue
        const at = execution.startedAt ?? execution.endedAt ?? 0
        if (best === undefined || at > best.at) best = { sessionId: execution.sessionId, at }
      }
    }
    return best?.sessionId
  }

  const reviewCandidates = state.ledger.tasks.filter(task =>
    task.trashedAt === undefined && REVIEWABLE.includes(task.status))

  const dispatchMaker = (preset: CatalogPresetItem): void => {
    controller.closeEmployees()
    controller.newFromTemplate({
      presetId: preset.id,
      permission: permissionForCreate(state.ledger, preset.id),
      urgency: 'normal',
    })
  }

  const dispatchReviewer = (preset: CatalogPresetItem, source: TaskRecord): void => {
    controller.closeEmployees()
    controller.newFromTemplate({
      presetId: preset.id,
      permission: 'read-only',
      urgency: 'normal',
      title: t('employees.reviewTitle', { title: source.title }).slice(0, 200),
      reviewOf: source.id,
    })
  }

  /** One catalog card (bound / disabled / unassigned). */
  const renderPreset = (preset: CatalogPresetItem) => {
    const row = globalRow(preset.id)
    const cardState = row === undefined ? 'unassigned' : row.enabled ? 'bound' : 'disabled'
    const session = latestSession(preset.id)
    return (
      <article
        key={preset.id}
        className="dsh-atb-employee"
        data-employee-id={preset.id}
        data-role={row?.role ?? 'none'}
        data-state={cardState}
      >
        <div className="dsh-atb-employee-head">
          <strong>{preset.name ?? preset.id}</strong>
          {preset.id === defaultId && <span className="dsh-atb-employee-badge">{t('employees.default')}</span>}
          {cardState === 'disabled' && <span className="dsh-atb-emp-state">{t('employees.disabled')}</span>}
          {cardState === 'unassigned' && <span className="dsh-atb-emp-state">{t('employees.unassigned')}</span>}
        </div>
        <code className="dsh-atb-employee-id">{preset.id}</code>

        {row === undefined
          ? (
            <div className="dsh-atb-emp-row">
              <select
                className="dsh-atb-emp-perm"
                aria-label={t('employees.assign')}
                value=""
                onChange={event => { if (event.target.value !== '') assign(preset.id, event.target.value as EmployeeRole) }}
              >
                <option value="">{t('employees.assign')}</option>
                <option value="maker">{t('employees.roleMaker')}</option>
                <option value="reviewer">{t('employees.roleReviewer')}</option>
              </select>
            </div>
          )
          : (
            <>
              <div className="dsh-atb-emp-row">
                <span className="dsh-atb-emp-label">{t('employees.roleLabel')}</span>
                <button
                  type="button"
                  className="dsh-atb-emp-role"
                  data-role={row.role}
                  title={t('employees.roleToggle')}
                  onClick={() => cycleRole(preset.id, row)}
                >{t(row.role === 'reviewer' ? 'employees.roleReviewer' : 'employees.roleMaker')}</button>
                {row.role === 'reviewer' && (
                  <button
                    type="button"
                    className="dsh-atb-emp-star"
                    data-on={row.defaultReviewer === true ? 'true' : 'false'}
                    title={t('employees.setDefaultReviewer')}
                    onClick={() => star(preset.id, row)}
                  >{row.defaultReviewer === true ? '★' : '☆'}</button>
                )}
              </div>
              <div className="dsh-atb-emp-row">
                <span className="dsh-atb-emp-label">{t('employees.permissionLabel')}</span>
                <select
                  className="dsh-atb-emp-perm"
                  aria-label={t('employees.permissionLabel')}
                  value={row.permission ?? ''}
                  onChange={event => setPermission(preset.id, row, event.target.value)}
                >
                  <option value="">{t('employees.permissionFollowBoard')}</option>
                  {PERMISSIONS.map(option => (
                    <option key={option.value} value={option.value}>{t(option.key)}</option>
                  ))}
                </select>
              </div>
              <div className="dsh-atb-emp-row">
                <span className="dsh-atb-emp-label">{t('employees.sessionLabel')}</span>
                {session === undefined
                  ? <span className="dsh-atb-emp-session" data-empty="true">{t('employees.sessionNone')}</span>
                  : (
                    <button
                      type="button"
                      className="dsh-atb-emp-session"
                      title={t('employees.sessionJump')}
                      onClick={() => { void controller.openSession(session) }}
                    >{`🤖 ${session.slice(0, 8)}`}</button>
                  )}
              </div>
            </>
          )}

        <div className="dsh-atb-emp-actions">
          {cardState !== 'unassigned' && (
            <label className="dsh-atb-emp-toggle">
              <input
                type="checkbox"
                checked={row!.enabled}
                onChange={event => setEnabled(preset.id, row!, event.target.checked)}
              />
              {t('employees.enabledLabel')}
            </label>
          )}
          {cardState === 'unassigned' ? null : row!.role === 'reviewer'
            ? (
              <button
                type="button"
                className="dsh-atb-btn"
                data-primary="true"
                disabled={!row!.enabled || reviewCandidates.length === 0}
                title={!row!.enabled ? t('employees.disabled') : reviewCandidates.length === 0 ? t('employees.noSourceTask') : t('employees.reviewAction')}
                onClick={() => setPicking(picking === preset.id ? undefined : preset.id)}
              >{t('employees.reviewAction')}</button>
            )
            : (
              <button
                type="button"
                className="dsh-atb-btn"
                data-primary="true"
                disabled={!row!.enabled}
                title={!row!.enabled ? t('employees.disabled') : t('employees.use')}
                onClick={() => dispatchMaker(preset)}
              >{t('employees.use')}</button>
            )}
          {cardState !== 'unassigned' && (
            <button type="button" className="dsh-atb-btn" onClick={() => unbind(preset.id)}>
              {t('employees.unbind')}
            </button>
          )}
        </div>

        {picking === preset.id && (
          <div className="dsh-atb-emp-sources">
            <span className="dsh-atb-emp-label">{t('employees.pickSource')}</span>
            {reviewCandidates.map(source => (
              <button
                key={source.id}
                type="button"
                className="dsh-atb-emp-source"
                onClick={() => dispatchReviewer(preset, source)}
              >{`🧪 ${source.title}`}</button>
            ))}
          </div>
        )}
      </article>
    )
  }

  /** A binding whose preset vanished from the catalog. */
  const renderStale = (row: EmployeeBinding) => (
    <article key={`stale-${row.presetId}`} className="dsh-atb-employee" data-employee-id={row.presetId} data-role={row.role} data-state="stale">
      <div className="dsh-atb-employee-head">
        <strong>{row.presetId}</strong>
        <span className="dsh-atb-emp-state">{t('employees.stale')}</span>
      </div>
      <p className="dsh-atb-employee-role">{t('employees.staleHint')}</p>
      <div className="dsh-atb-emp-actions">
        <button type="button" className="dsh-atb-btn" onClick={() => unbind(row.presetId)}>{t('employees.unbind')}</button>
      </div>
    </article>
  )

  const catalogIds = new Set((presets ?? []).map(preset => preset.id))
  const staleRows = employees.filter(row => row.projectId === undefined && !catalogIds.has(row.presetId))

  return (
    <div
      className="dsh-atb-modal-backdrop"
      onClick={event => { if (event.target === event.currentTarget) controller.closeEmployees() }}
    >
      <div className="dsh-atb-modal dsh-atb-employees" role="dialog" aria-modal="true" aria-label={t('employees.title')}>
        <div className="dsh-atb-modal-head">
          <span className="dsh-atb-modal-headicon" aria-hidden>👥</span>
          <div className="dsh-atb-modal-headtext">
            <h3>{t('employees.title')}</h3>
            <p>{t('employees.hint')}</p>
          </div>
          <button type="button" className="dsh-atb-modal-close" aria-label={t('shared.close')} onClick={() => controller.closeEmployees()}>✕</button>
        </div>
        <div className="dsh-atb-modal-body dsh-atb-employees-body">
          {error !== undefined && <div className="dsh-atb-error" role="alert">{t('employees.error', { error })}</div>}
          {presets === undefined && error === undefined && <p className="dsh-atb-employees-note">{t('employees.loading')}</p>}
          {presets !== undefined && presets.length === 0 && error === undefined && (
            <p className="dsh-atb-employees-note">{t('employees.empty')}</p>
          )}
          {presets !== undefined && (presets.length > 0 || staleRows.length > 0) && (
            <div className="dsh-atb-employees-grid">
              {presets.map(renderPreset)}
              {staleRows.map(renderStale)}
            </div>
          )}
        </div>
        <div className="dsh-atb-modal-foot">
          <span className="dsh-atb-modal-hint">{t('employees.scopeHint')}</span>
          <span className="dsh-atb-modal-footbtns">
            <button type="button" className="dsh-atb-btn" onClick={() => controller.closeEmployees()}>{t('shared.close')}</button>
          </span>
        </div>
      </div>
    </div>
  )
}
