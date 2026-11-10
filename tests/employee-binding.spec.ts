/**
 * Employee bindings: the board's explicit role/permission table over DSH
 * presets. Presets stay the single configuration source; a binding only says
 * what that preset is in THIS board, and what permission a new card starts with.
 */
import { describe, expect, it } from 'vitest'
import {
  asEmployeeBindings, defaultReviewerBinding, employeeBindingFor, emptyLedger, permissionForCreate,
  type EmployeeBinding, type TaskLedger,
} from '../src/shared/protocol.ts'

const ledgerWith = (employees: unknown[]): TaskLedger => ({ ...emptyLedger(), employees: asEmployeeBindings(employees) })

describe('asEmployeeBindings', () => {
  it('rejects an unknown role', () => {
    expect(() => asEmployeeBindings([{ presetId: 'x', role: 'boss', enabled: true }])).toThrow()
  })

  it('rejects more than the row cap', () => {
    const rows = Array.from({ length: 201 }, (_, i) => ({ presetId: `p${i}`, role: 'maker', enabled: true }))
    expect(() => asEmployeeBindings(rows)).toThrow()
  })

  it('keeps only the first default reviewer', () => {
    const out = asEmployeeBindings([
      { presetId: 'a', role: 'reviewer', enabled: true, defaultReviewer: true },
      { presetId: 'b', role: 'reviewer', enabled: true, defaultReviewer: true },
    ])
    expect(out.filter(b => b.defaultReviewer === true)).toHaveLength(1)
    expect(out[0]!.defaultReviewer).toBe(true)
  })

  it('dedupes by (projectId, presetId) with the last row winning', () => {
    const out = asEmployeeBindings([
      { presetId: 'a', role: 'maker', enabled: true },
      { presetId: 'a', role: 'reviewer', enabled: true },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.role).toBe('reviewer')
  })

  it('keeps the same preset twice when the project differs, and accepts an empty table', () => {
    const out = asEmployeeBindings([
      { presetId: 'a', role: 'maker', enabled: true },
      { presetId: 'a', projectId: 'ws-1', role: 'reviewer', enabled: true },
    ])
    expect(out).toHaveLength(2)
    expect(asEmployeeBindings([])).toEqual([])
  })

  it('rejects a non-boolean enabled flag and an invalid permission', () => {
    expect(() => asEmployeeBindings([{ presetId: 'a', role: 'maker', enabled: 'yes' }])).toThrow()
    expect(() => asEmployeeBindings([{ presetId: 'a', role: 'maker', enabled: true, permission: 'root' }])).toThrow()
  })
})

describe('permissionForCreate', () => {
  it('explicit beats binding beats board default', () => {
    const ledger = ledgerWith([{ presetId: 'std', role: 'maker', enabled: true, permission: 'read-only' }])
    expect(permissionForCreate(ledger, 'std', 'danger-full-access')).toBe('danger-full-access')
    expect(permissionForCreate(ledger, 'std', undefined)).toBe('read-only')
    expect(permissionForCreate(ledger, 'unbound', undefined)).toBe('workspace-write')
    expect(permissionForCreate(undefined, 'std', undefined)).toBe('workspace-write')
  })

  it('gives a reviewer with no explicit permission the board default, not read-only', () => {
    const ledger = ledgerWith([{ presetId: 'rev', role: 'reviewer', enabled: true }])
    expect(permissionForCreate(ledger, 'rev', undefined)).toBe('workspace-write')
  })

  it('follows the board default when settings set one', () => {
    const ledger: TaskLedger = { ...ledgerWith([{ presetId: 'rev', role: 'reviewer', enabled: true }]), settings: { defaultPermission: 'danger-full-access' } }
    expect(permissionForCreate(ledger, 'rev', undefined)).toBe('danger-full-access')
  })
})

describe('employeeBindingFor', () => {
  it('ignores disabled bindings', () => {
    const ledger = ledgerWith([{ presetId: 'std', role: 'maker', enabled: false, permission: 'read-only' }])
    expect(employeeBindingFor(ledger, 'std')).toBeUndefined()
    expect(permissionForCreate(ledger, 'std', undefined)).toBe('workspace-write')
  })

  it('prefers a project-scoped binding over the global one', () => {
    const ledger = ledgerWith([
      { presetId: 'std', role: 'maker', enabled: true, permission: 'read-only' },
      { presetId: 'std', projectId: 'ws-1', role: 'maker', enabled: true, permission: 'danger-full-access' },
    ])
    expect(employeeBindingFor(ledger, 'std', 'ws-1')?.permission).toBe('danger-full-access')
    expect(employeeBindingFor(ledger, 'std', 'ws-2')?.permission).toBe('read-only')
  })
})

describe('defaultReviewerBinding', () => {
  const first = (rows: unknown[]): EmployeeBinding | undefined => {
    const l = ledgerWith(rows)
    return defaultReviewerBinding(l)
  }

  it('prefers the starred reviewer', () => {
    expect(first([
      { presetId: 'a', role: 'reviewer', enabled: true },
      { presetId: 'b', role: 'reviewer', enabled: true, defaultReviewer: true },
    ])?.presetId).toBe('b')
  })

  it('falls back to the first enabled reviewer, and to undefined when none', () => {
    expect(first([{ presetId: 'a', role: 'reviewer', enabled: true }])?.presetId).toBe('a')
    expect(first([])).toBeUndefined()
    expect(first([{ presetId: 'a', role: 'maker', enabled: true }])).toBeUndefined()
    expect(first([{ presetId: 'a', role: 'reviewer', enabled: false }])).toBeUndefined()
  })
})
