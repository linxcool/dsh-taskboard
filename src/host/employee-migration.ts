/**
 * One-shot migration from the old preset-name inference (P3) to explicit
 * reviewer bindings.
 *
 * Before the employee table existed the board guessed a role from the preset's
 * id/name (`review|审查|评审|…`). This keeps that outcome for existing users
 * exactly once — the marker is written even when nothing matched, so a later
 * preset rename cannot resurrect the guess — and never touches a table the
 * user already has.
 *
 * @module dsh-taskboard/host/employee-migration
 */
import type { CatalogPresetItem } from '../shared/api.ts'
import { asEmployeeBindings, type TaskLedger } from '../shared/protocol.ts'

/** The retired inference, kept here only to build the initial table. */
const LEGACY_REVIEWER_PATTERN = /review|reviewer|audit|审查|评审|验收|审核/i

/**
 * Build the migrated ledger, or `undefined` when this ledger needs no work
 * (already migrated, already has a table, or the catalog is unavailable).
 *
 * The input is never mutated: the caller applies the result inside its own
 * store mutation.
 * @param ledger - the current ledger.
 * @param presets - the live preset catalog.
 * @param now - ISO timestamp for the marker.
 */
export function migrateEmployeeBindings(
  ledger: TaskLedger,
  presets: readonly CatalogPresetItem[],
  now: () => string,
): TaskLedger | undefined {
  if (ledger.employees !== undefined || ledger.employeesMigratedAt !== undefined) return undefined
  if (presets.length === 0) return undefined
  const matched = presets
    .filter(preset => LEGACY_REVIEWER_PATTERN.test(`${preset.id} ${preset.name ?? ''}`))
    .map(preset => ({ presetId: preset.id, role: 'reviewer' as const, enabled: true }))
  return {
    ...ledger,
    employees: asEmployeeBindings(matched),
    employeesMigratedAt: now(),
  }
}
