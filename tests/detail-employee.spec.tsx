// @vitest-environment jsdom
/**
 * Detail pane: the executing employee is assigned here, so imported and
 * existing cards can be handed to an employee without opening the edit form.
 */
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BoardController } from '../src/client/controller.ts'
import { TaskDetail } from '../src/client/board/TaskDetail.tsx'
import type { UpdateTaskBody } from '../src/shared/api.ts'
import type { TaskRecord } from '../src/shared/protocol.ts'
import { disposeI18n } from '../src/client/i18n/runtime.ts'
import { waitFor } from './wait-for.ts'

const cleanups: Array<() => void> = []
beforeEach(() => { localStorage.clear(); document.documentElement.lang = 'zh-CN'; disposeI18n() })
afterEach(() => { cleanups.splice(0).reverse().forEach(dispose => dispose()); localStorage.clear() })

const makeTask = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  id: 't-emp', title: '导入的任务', description: '', prompt: '', workspaceId: 'ws-a',
  urgency: 'normal', status: 'todo', blocked: false, execution: { mode: 'claim' },
  version: 3, createdAt: 1, updatedAt: 2,
  createdBy: { kind: 'user' }, updatedBy: { kind: 'user' },
  comments: [], executions: [],
  ...overrides,
} as TaskRecord)

async function setup(task: TaskRecord) {
  const updated: UpdateTaskBody[] = []
  const controller = new BoardController({
    state: async () => ({ schemaVersion: 1, revision: 1, tasks: [task] }),
    workspaces: async () => [{ id: 'ws-a', path: '/p/a', title: 'A', sessionCount: 0 }],
    stream: () => () => {},
    update: async (_id: string, body: UpdateTaskBody) => { updated.push(body); return { id: task.id, version: task.version + 1 } },
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
  root.render(React.createElement(TaskDetail, { controller, task }))
  await waitFor(() => host.querySelector('.dsh-atb-emp-pick select') !== null)
  return { host, updated, picker: () => host.querySelector<HTMLSelectElement>('.dsh-atb-emp-pick select')! }
}

const change = async (select: HTMLSelectElement, value: string) => {
  const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  await React.act(async () => {
    setValue.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('detail pane: executing employee', () => {
  it('shows the current employee and reassigns it', async () => {
    const view = await setup(makeTask({ presetId: 'p1' }))
    expect(view.picker().value).toBe('p1')
    await waitFor(() => [...view.picker().options].some(option => option.value === 'p2'))
    await change(view.picker(), 'p2')
    await waitFor(() => view.updated.length === 1)
    expect(view.updated[0]).toEqual({ ifVersion: 3, presetId: 'p2' })
  })

  it('clears the assignment back to the deployment default', async () => {
    const view = await setup(makeTask({ presetId: 'p1' }))
    await change(view.picker(), '')
    await waitFor(() => view.updated.length === 1)
    expect(view.updated[0]).toEqual({ ifVersion: 3, presetId: null })
  })

  it('keeps an unknown preset visible instead of silently dropping it', async () => {
    const view = await setup(makeTask({ presetId: 'legacy-x' }))
    expect(view.picker().value).toBe('legacy-x')
    expect([...view.picker().options].some(option => option.value === 'legacy-x')).toBe(true)
  })
})
