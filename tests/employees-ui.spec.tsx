// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EmployeesModal } from '../src/client/board/EmployeesModal.tsx'
import type { BoardController } from '../src/client/controller.ts'
import { waitFor } from './wait-for.ts'

let root: Root | undefined
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(async () => { await act(async () => { root?.unmount() }); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals() })

function controllerFor(presets: Array<{ id: string; name?: string }>, defaultId?: string): BoardController {
  return {
    fetchPresetCatalog: vi.fn(async () => ({ presets, defaultId })),
    closeEmployees: vi.fn(),
    newFromTemplate: vi.fn(),
  } as unknown as BoardController
}

async function render(controller: BoardController): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(createElement(EmployeesModal, { controller })) })
  return host
}

describe('employee catalog (agent preset cards)', () => {
  it('renders presets, marks the default, and dispatches role-appropriate task prefill', async () => {
    const controller = controllerFor([{ id: 'maker', name: 'Maker' }, { id: 'reviewer', name: 'Reviewer' }], 'maker')
    const host = await render(controller)
    await waitFor(() => host.querySelectorAll('[data-employee-id]').length === 2)
    const cards = [...host.querySelectorAll<HTMLElement>('[data-employee-id]')]
    expect(cards.map(card => card.dataset.employeeId)).toEqual(['maker', 'reviewer'])
    expect(cards[0]!.dataset.role).toBe('maker')
    expect(cards[1]!.dataset.role).toBe('reviewer')
    expect(cards[0]!.textContent).toContain('Maker')
    expect(cards[1]!.textContent).toContain('Reviewer')
    expect(host.querySelectorAll('.dsh-atb-employee-badge')).toHaveLength(1)
    await act(async () => { cards[1]!.querySelector('button')!.click() })
    expect(controller.closeEmployees).toHaveBeenCalledTimes(1)
    expect(controller.newFromTemplate).toHaveBeenCalledWith({ presetId: 'reviewer', permission: 'read-only', urgency: 'normal' })
  })

  it('prefills write access for maker-style presets and keeps the preset id', async () => {
    const controller = controllerFor([{ id: 'impl', name: 'Implementation' }])
    const host = await render(controller)
    await waitFor(() => host.querySelector('[data-employee-id]') !== null)
    await act(async () => { host.querySelector<HTMLElement>('[data-employee-id]')!.querySelector('button')!.click() })
    expect(controller.newFromTemplate).toHaveBeenCalledWith({ presetId: 'impl', permission: 'workspace-write', urgency: 'normal' })
  })

  it('shows an empty-state note when no presets exist', async () => {
    const host = await render(controllerFor([]))
    await waitFor(() => host.querySelector('.dsh-atb-employees-note') !== null)
    expect(host.querySelectorAll('[data-employee-id]')).toHaveLength(0)
    expect(host.querySelector('.dsh-atb-employees-note')!.textContent).toBeTruthy()
  })

  it('surfaces catalog failures without breaking the modal', async () => {
    const controller = { fetchPresetCatalog: vi.fn(async () => { throw new Error('preset roster unavailable') }), closeEmployees: vi.fn(), newFromTemplate: vi.fn() } as unknown as BoardController
    const host = await render(controller)
    await waitFor(() => host.querySelector('[role=alert]') !== null)
    expect(host.querySelector('[role=alert]')!.textContent).toContain('preset roster unavailable')
    expect(host.querySelector('.dsh-atb-employees-note')).toBeNull()
  })
})
