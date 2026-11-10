/**
 * One-shot migration from the old preset-name inference to explicit reviewer
 * bindings. Runs once per ledger: the marker is written even when nothing
 * matched, so a later rename of a preset cannot resurrect the guess.
 */
import { describe, expect, it } from 'vitest'
import { migrateEmployeeBindings } from '../src/host/employee-migration.ts'
import { asEmployeeBindings, emptyLedger, type TaskLedger } from '../src/shared/protocol.ts'

const presets = [
  { id: 'reviewer', name: 'Reviewer' },
  { id: 'code-auditor', name: 'Code Auditor' },
  { id: 'std', name: '标准模式' },
]
const stamp = () => '2026-11-10T00:00:00.000Z'

describe('migrateEmployeeBindings', () => {
  it('turns name matches into reviewer bindings and stamps the marker', () => {
    const next = migrateEmployeeBindings(emptyLedger(), presets, stamp)!
    expect(next).toBeDefined()
    expect(next.employees).toEqual(asEmployeeBindings([
      { presetId: 'reviewer', role: 'reviewer', enabled: true },
      { presetId: 'code-auditor', role: 'reviewer', enabled: true },
    ]))
    expect(next.employeesMigratedAt).toBe('2026-11-10T00:00:00.000Z')
  })

  it('writes only the marker when no preset looks like a reviewer', () => {
    const next = migrateEmployeeBindings(emptyLedger(), [{ id: 'std', name: '标准模式' }], stamp)!
    expect(next.employees).toEqual([])
    expect(next.employeesMigratedAt).toBe('2026-11-10T00:00:00.000Z')
  })

  it('never runs twice and never overwrites an existing table', () => {
    const migrated: TaskLedger = { ...emptyLedger(), employeesMigratedAt: 'earlier' }
    expect(migrateEmployeeBindings(migrated, presets, stamp)).toBeUndefined()
    const explicit: TaskLedger = { ...emptyLedger(), employees: asEmployeeBindings([{ presetId: 'std', role: 'maker', enabled: true }]) }
    expect(migrateEmployeeBindings(explicit, presets, stamp)).toBeUndefined()
  })

  it('skips an empty catalog so a failed preset lookup is retried later', () => {
    expect(migrateEmployeeBindings(emptyLedger(), [], stamp)).toBeUndefined()
  })

  it('does not mutate the input ledger', () => {
    const ledger = emptyLedger()
    migrateEmployeeBindings(ledger, presets, stamp)
    expect(ledger.employees).toBeUndefined()
    expect(ledger.employeesMigratedAt).toBeUndefined()
  })
})
