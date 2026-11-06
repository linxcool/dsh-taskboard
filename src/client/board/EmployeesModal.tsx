/**
 * Employee catalog (P3): every DSH agent preset is presented as a hireable
 * "employee" card. Choosing one opens the normal create-task form prefilled
 * with that preset and a role-appropriate default permission. The plugin owns
 * no employee data — presets stay the single configuration source.
 *
 * @module dsh-taskboard/client/board/EmployeesModal
 */
import { useEffect, useState } from 'react'
import type { BoardController } from '../controller.ts'
import type { CatalogPresetItem } from '../../shared/api.ts'
import { useT } from '../i18n/runtime.ts'

/** Reviewer-ish presets get read-only execution by default. */
const REVIEW_PATTERN = /review|reviewer|audit|审查|评审|验收|审核/i
const isReviewer = (preset: CatalogPresetItem): boolean => REVIEW_PATTERN.test(`${preset.id} ${preset.name ?? ''}`)

/** The employee catalog modal. */
export function EmployeesModal({ controller }: { controller: BoardController }) {
  const t = useT()
  const [presets, setPresets] = useState<CatalogPresetItem[]>()
  const [defaultId, setDefaultId] = useState<string>()
  const [error, setError] = useState<string>()

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

  const dispatch = (preset: CatalogPresetItem): void => {
    controller.closeEmployees()
    controller.newFromTemplate({
      presetId: preset.id,
      permission: isReviewer(preset) ? 'read-only' : 'workspace-write',
      urgency: 'normal',
    })
  }

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
          {presets !== undefined && presets.length > 0 && (
            <div className="dsh-atb-employees-grid">
              {presets.map(preset => {
                const reviewer = isReviewer(preset)
                return (
                  <article
                    key={preset.id}
                    className="dsh-atb-employee"
                    data-employee-id={preset.id}
                    data-role={reviewer ? 'reviewer' : 'maker'}
                  >
                    <div className="dsh-atb-employee-head">
                      <strong>{preset.name ?? preset.id}</strong>
                      {preset.id === defaultId && <span className="dsh-atb-employee-badge">{t('employees.default')}</span>}
                    </div>
                    <code className="dsh-atb-employee-id">{preset.id}</code>
                    <p className="dsh-atb-employee-role">{reviewer ? t('employees.roleReviewer') : t('employees.roleMaker')}</p>
                    <button type="button" className="dsh-atb-btn" data-primary="true" onClick={() => dispatch(preset)}>
                      {t('employees.use')}
                    </button>
                  </article>
                )
              })}
            </div>
          )}
        </div>
        <div className="dsh-atb-modal-foot">
          <span className="dsh-atb-modal-hint">{t('employees.footHint')}</span>
          <span className="dsh-atb-modal-footbtns">
            <button type="button" className="dsh-atb-btn" onClick={() => controller.closeEmployees()}>{t('shared.close')}</button>
          </span>
        </div>
      </div>
    </div>
  )
}
