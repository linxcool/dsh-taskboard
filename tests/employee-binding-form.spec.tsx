// @vitest-environment jsdom
/**
 * Create form × employee bindings: the permission follows the selected
 * preset's binding until the human picks one, and the form always says where
 * the effective value came from.
 */
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BoardController } from '../src/client/controller.ts'
import { TaskFormModal } from '../src/client/board/TaskFormModal.tsx'
import type { UpdateTaskBody } from '../src/shared/api.ts'
import type { EmployeeBinding } from '../src/shared/protocol.ts'
import { disposeI18n } from '../src/client/i18n/runtime.ts'
import { waitFor } from './wait-for.ts'

const cleanups: Array<() => void> = []
beforeEach(() => { localStorage.clear(); document.documentElement.lang = 'zh-CN'; disposeI18n() })
afterEach(() => { cleanups.splice(0).reverse().forEach(dispose => dispose()); localStorage.clear() })

async function setup(employees: EmployeeBinding[], settings: Record<string, unknown> = {}) {
  const created: unknown[] = []
  const updated: UpdateTaskBody[] = []
  const controller = new BoardController({
    state: async () => ({ schemaVersion: 1, revision: 1, tasks: [], employees, settings }),
    workspaces: async () => [{ id: 'ws-a', path: '/p/a', title: 'A', sessionCount: 0 }],
    stream: () => () => {},
    create: async (body: unknown) => { created.push(body); return { id: 'new-task', version: 1 } },
    update: async (_id: string, body: UpdateTaskBody) => { updated.push(body); return { id: 'x', version: 2 } },
  } as never)
  controller.installModelCatalog(async () => [])
  controller.installPresetRoster(async () => ({ presets: [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }], defaultId: 'p1' }))
  controller.start()
  cleanups.push(() => controller.dispose())
  await waitFor(() => controller.getSnapshot().workspaces.length === 1)

  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  cleanups.push(() => { root.unmount(); host.remove() })
  // Start from a known preset so the assertion does not depend on the
  // deployment default arriving asynchronously.
  root.render(React.createElement(TaskFormModal, { controller }))

  const permission = (): HTMLSelectElement => host.querySelector<HTMLSelectElement>('.dsh-atb-permission-select')!
  const preset = (): HTMLSelectElement => Array.from(host.querySelectorAll<HTMLSelectElement>('select'))
    .find(select => [...select.options].some(option => option.value === 'p2'))!
  const source = (): string => host.querySelector('.dsh-atb-perm-source')?.textContent ?? ''
  const pick = async (select: HTMLSelectElement, value: string) => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await React.act(async () => {
      setValue.call(select, value)
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }
  return { host, controller, created, updated, permission, preset, source, pick }
}

const binding = (presetId: string, permission: EmployeeBinding['permission']): EmployeeBinding =>
  ({ presetId, role: 'maker', enabled: true, ...(permission !== undefined ? { permission } : {}) })

describe('create form follows employee bindings', () => {
  it('starts from the binding permission and says so', async () => {
    const view = await setup([binding('p1', 'read-only')])
    await waitFor(() => view.host.querySelector('.dsh-atb-permission-select') !== null)
    // The roster default preset arrives asynchronously, then the value follows it.
    await waitFor(() => view.permission().value === 'read-only')
    expect(view.source()).toContain('员工绑定')
  })

  it('re-follows the binding when the preset changes', async () => {
    const view = await setup([binding('p1', 'read-only'), binding('p2', 'danger-full-access')])
    await waitFor(() => view.permission().value === 'read-only')
    await view.pick(view.preset(), 'p2')
    await waitFor(() => view.permission().value === 'danger-full-access')
    expect(view.source()).toContain('员工绑定')
  })

  it('falls back to the board default for an unbound preset', async () => {
    const view = await setup([binding('p1', 'read-only')])
    await waitFor(() => view.permission().value === 'read-only')
    await view.pick(view.preset(), 'p2')
    await waitFor(() => view.permission().value === 'workspace-write')
    expect(view.source()).toContain('看板默认')
  })

  it('stops following once the human picks a permission', async () => {
    const view = await setup([binding('p1', 'read-only'), binding('p2', 'danger-full-access')])
    await waitFor(() => view.permission().value === 'read-only')
    const options = [...view.permission().options].map(option => option.value)
    await view.pick(view.permission(), options.find(value => value === 'workspace-write')!)
    expect(view.source()).toContain('覆盖员工绑定')
    await view.pick(view.preset(), 'p2')
    // An explicit choice wins over the new preset's binding.
    expect(view.permission().value).toBe('workspace-write')
  })

  it('explains what 立即执行 skips', async () => {
    const view = await setup([])
    await waitFor(() => view.host.querySelector('.dsh-atb-permission-select') !== null)
    expect(view.host.querySelector('[data-kind="run-now"]')?.textContent).toContain('不预览正文')
  })
})
