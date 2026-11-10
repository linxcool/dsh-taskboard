// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EmployeesModal } from '../src/client/board/EmployeesModal.tsx'
import type { BoardController, ControllerState } from '../src/client/controller.ts'
import { disposeI18n } from '../src/client/i18n/runtime.ts'
import { asEmployeeBindings, emptyLedger, type EmployeeBinding, type TaskRecord } from '../src/shared/protocol.ts'
import { waitFor } from './wait-for.ts'

/** Stable snapshot for mocks: useSyncExternalStore loops on a fresh object each call. */
const STATE = { ledger: emptyLedger(), workspaces: [], filters: { urgencies: [] } } as unknown as ControllerState

let root: Root | undefined
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  document.documentElement.lang = 'zh-CN'
  disposeI18n()
})
afterEach(async () => { await act(async () => { root?.unmount() }); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals() })

const task = (id: string, status: TaskRecord['status'], presetId?: string): TaskRecord => ({
  id, title: id, description: '', prompt: '', workspaceId: 'ws-a',
  urgency: 'normal', status, blocked: false, execution: { mode: 'claim' },
  version: 1, createdAt: 0, updatedAt: 0,
  createdBy: { kind: 'user' }, updatedBy: { kind: 'user' },
  comments: [], executions: [],
  ...(presetId !== undefined ? { presetId } : {}),
} as TaskRecord)

function controllerFor(
  presets: Array<{ id: string; name?: string }>,
  options: { employees?: unknown[]; tasks?: TaskRecord[]; defaultId?: string } = {},
): BoardController {
  const state = {
    ledger: {
      ...emptyLedger(),
      tasks: options.tasks ?? [],
      ...(options.employees !== undefined ? { employees: asEmployeeBindings(options.employees) } : {}),
    },
    workspaces: [],
    filters: { urgencies: [] },
  } as unknown as ControllerState
  return {
    fetchPresetCatalog: vi.fn(async () => ({ presets, defaultId: options.defaultId })),
    closeEmployees: vi.fn(),
    newFromTemplate: vi.fn(),
    saveBindings: vi.fn(async () => true),
    openSession: vi.fn(async () => ({ ok: true })),
    getSnapshot: () => state,
    subscribe: () => () => {},
  } as unknown as BoardController
}

async function render(controller: BoardController): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(createElement(EmployeesModal, { controller })) })
  return host
}

const cards = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[data-employee-id]')]
const card = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-employee-id="${id}"]`)!

describe('employee catalog: four states', () => {
  it('renders bound, disabled, unassigned and stale cards', async () => {
    const controller = controllerFor(
      [{ id: 'std', name: 'Standard' }, { id: 'aud', name: 'Auditor' }, { id: 'new', name: 'New' }],
      {
        employees: [
          { presetId: 'std', role: 'maker', enabled: true },
          { presetId: 'aud', role: 'reviewer', enabled: false },
          { presetId: 'gone', role: 'reviewer', enabled: true },
        ],
      },
    )
    const host = await render(controller)
    await waitFor(() => cards(host).length === 4)
    expect(card(host, 'std').dataset.state).toBe('bound')
    expect(card(host, 'aud').dataset.state).toBe('disabled')
    expect(card(host, 'new').dataset.state).toBe('unassigned')
    expect(card(host, 'gone').dataset.state).toBe('stale')
    // Unassigned cards offer only the role dropdown.
    expect(card(host, 'new').querySelector('select')).not.toBeNull()
    expect(card(host, 'new').querySelector('[data-primary]')).toBeNull()
  })

  it('assigns a role through the dropdown', async () => {
    const controller = controllerFor([{ id: 'new', name: 'New' }])
    const host = await render(controller)
    await waitFor(() => cards(host).length === 1)
    const select = card(host, 'new').querySelector<HTMLSelectElement>('select')!
    await act(async () => {
      select.value = 'reviewer'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(controller.saveBindings).toHaveBeenCalledWith([{ presetId: 'new', role: 'reviewer', enabled: true }])
  })

  it('edits role, permission, enabled and the default reviewer in place', async () => {
    const controller = controllerFor([{ id: 'rev', name: 'Rev' }], {
      employees: [
        { presetId: 'rev', role: 'reviewer', enabled: true, defaultReviewer: true },
        { presetId: 'other', role: 'reviewer', enabled: true },
      ],
    })
    const host = await render(controller)
    await waitFor(() => cards(host).length === 2)

    // Star another reviewer → exactly one stays starred.
    const star = card(host, 'rev').querySelector<HTMLButtonElement>('.dsh-atb-emp-star')!
    await act(async () => { star.click() })
    expect(controller.saveBindings).toHaveBeenLastCalledWith([
      { presetId: 'rev', role: 'reviewer', enabled: true },
      { presetId: 'other', role: 'reviewer', enabled: true },
    ])

    // Permission select writes the value onto the row.
    const selects = [...card(host, 'rev').querySelectorAll<HTMLSelectElement>('select')]
    const permission = selects[selects.length - 1]!
    await act(async () => {
      permission.value = 'read-only'
      permission.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const written = (controller.saveBindings as unknown as { mock: { calls: Array<[EmployeeBinding[]]> } }).mock.calls.at(-1)![0]
    expect(written.find(row => row.presetId === 'rev')?.permission).toBe('read-only')
  })

  it('uses the binding permission for a maker dispatch, not the preset name', async () => {
    const controller = controllerFor([{ id: 'code-auditor-v2', name: 'Code Auditor v2' }], {
      employees: [{ presetId: 'code-auditor-v2', role: 'maker', enabled: true, permission: 'danger-full-access' }],
    })
    const host = await render(controller)
    await waitFor(() => cards(host).length === 1)
    await act(async () => { card(host, 'code-auditor-v2').querySelector<HTMLButtonElement>('[data-primary]')!.click() })
    expect(controller.newFromTemplate).toHaveBeenCalledWith({
      presetId: 'code-auditor-v2',
      permission: 'danger-full-access',
      urgency: 'normal',
    })
  })

  it('offers a review flow for reviewers, and disables it with nothing in flight', async () => {
    const controller = controllerFor([{ id: 'rev', name: 'Rev' }], {
      employees: [{ presetId: 'rev', role: 'reviewer', enabled: true }],
      tasks: [task('t-do', 'in_progress')],
    })
    const host = await render(controller)
    await waitFor(() => cards(host).length === 1)
    const action = () => card(host, 'rev').querySelector<HTMLButtonElement>('[data-primary]')!
    expect(action().textContent).toBe('用它发起评审')

    await act(async () => { action().click() })
    const source = card(host, 'rev').querySelector<HTMLButtonElement>('.dsh-atb-emp-source')!
    await act(async () => { source.click() })
    expect(controller.newFromTemplate).toHaveBeenCalledWith(expect.objectContaining({
      presetId: 'rev',
      permission: 'read-only',
      reviewOf: 't-do',
    }))
  })

  it('disables the review action when no card is in flight', async () => {
    const controller = controllerFor([{ id: 'rev', name: 'Rev' }], {
      employees: [{ presetId: 'rev', role: 'reviewer', enabled: true }],
      tasks: [task('t-done', 'done')],
    })
    const host = await render(controller)
    await waitFor(() => cards(host).length === 1)
    expect(card(host, 'rev').querySelector<HTMLButtonElement>('[data-primary]')!.disabled).toBe(true)
  })

  it('shows the latest execution session and opens it', async () => {
    const controller = controllerFor([{ id: 'std', name: 'Standard' }], {
      employees: [{ presetId: 'std', role: 'maker', enabled: true }],
      tasks: [{
        ...task('t-run', 'in_progress', 'std'),
        executions: [
          { id: 'e1', trigger: 'manual', outcome: 'succeeded', startedAt: 10, sessionId: 'session-old' },
          { id: 'e2', trigger: 'manual', outcome: 'running', startedAt: 20, sessionId: 'session-new' },
        ],
      } as TaskRecord],
    })
    const host = await render(controller)
    await waitFor(() => cards(host).length === 1)
    const chip = card(host, 'std').querySelector<HTMLButtonElement>('.dsh-atb-emp-session')!
    expect(chip.textContent).toContain('session-')
    await act(async () => { chip.click() })
    expect(controller.openSession).toHaveBeenCalledWith('session-new')
  })

  it('shows the binding scope hint in the footer', async () => {
    const host = await render(controllerFor([{ id: 'std', name: 'Standard' }]))
    await waitFor(() => cards(host).length === 1)
    expect(host.querySelector('.dsh-atb-modal-hint')!.textContent).toContain('只影响之后新建的任务')
  })

  it('shows an empty-state note when no presets exist', async () => {
    const host = await render(controllerFor([]))
    await waitFor(() => host.querySelector('.dsh-atb-employees-note') !== null)
    expect(cards(host)).toHaveLength(0)
  })

  it('surfaces catalog failures without breaking the modal', async () => {
    const controller = {
      fetchPresetCatalog: vi.fn(async () => { throw new Error('preset roster unavailable') }),
      closeEmployees: vi.fn(),
      newFromTemplate: vi.fn(),
      saveBindings: vi.fn(),
      getSnapshot: () => STATE,
      subscribe: () => () => {},
    } as unknown as BoardController
    const host = await render(controller)
    await waitFor(() => host.querySelector('[role=alert]') !== null)
    expect(host.querySelector('[role=alert]')!.textContent).toContain('preset roster unavailable')
  })
})
