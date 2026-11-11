// @vitest-environment jsdom
/**
 * Toolbar declutter: the urgency filters and the GitHub-only toggle live in a
 * "more filters" popover instead of taking four chips of bar width. The bar
 * itself must not render them until the popover opens.
 */
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoardController } from '../src/client/controller.ts'
import { TaskBoard } from '../src/client/board/TaskBoard.tsx'
import type { TaskRecord } from '../src/shared/protocol.ts'
import { disposeI18n } from '../src/client/i18n/runtime.ts'
import { waitFor } from './wait-for.ts'

const cleanups: Array<() => void> = []
beforeEach(() => { localStorage.clear(); document.documentElement.lang = 'zh-CN'; disposeI18n() })
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); vi.unstubAllGlobals(); localStorage.clear() })

const task = (id: string, urgency: TaskRecord['urgency'], external = false): TaskRecord => ({
  id, title: `任务 ${id}`, description: '', prompt: '', workspaceId: 'ws-a',
  urgency, status: 'todo', blocked: false, execution: { mode: 'claim' },
  version: 1, createdAt: 0, updatedAt: 0,
  createdBy: { kind: 'user' }, updatedBy: { kind: 'user' },
  comments: [], executions: [],
  ...(external
    ? {
        external: {
          connectionId: 'c', provider: 'github', syncedAt: 1, conflicts: [],
          item: {
            projectId: 'acme/repo', type: 'issue', id, title: `Issue ${id}`, description: '',
            urgency, priority: '', status: 'open', assignedTo: '', closed: false,
            url: `https://github.com/acme/repo/issues/${id}`,
          },
        },
      }
    : {}),
} as TaskRecord)

async function mount() {
  const controller = new BoardController({
    state: async () => ({ schemaVersion: 1, revision: 1, tasks: [task('1', 'urgent'), task('2', 'normal', true), task('3', 'relaxed')] }),
    workspaces: async () => [{ id: 'ws-a', path: '/p/a', title: 'A', sessionCount: 0 }],
    stream: () => () => {},
  } as never)
  controller.start()
  cleanups.push(() => controller.dispose())
  await waitFor(() => controller.getSnapshot().workspaces.length === 1)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, value: { providers: [], running: false, ignoredCount: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } })))
  vi.stubGlobal('EventSource', class { onerror = null; close() {}; addEventListener() {} } as unknown as typeof EventSource)

  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  cleanups.push(() => { root.unmount(); host.remove() })
  root.render(React.createElement(TaskBoard, { controller }))
  await waitFor(() => host.querySelectorAll('.dsh-atb-card').length === 3)
  const button = () => host.querySelector<HTMLButtonElement>('[data-kind="more-filter"]')
  return { host, controller, button }
}

describe('toolbar more-filters popover', () => {
  it('keeps the urgency chips out of the bar until opened', async () => {
    const view = await mount()
    expect(view.button()).not.toBeNull()
    // Cards also carry data-urgency; scope the assertion to the toolbar.
    expect(view.host.querySelector('.dsh-atb-toolbar [data-urgency]')).toBeNull()
    expect(view.host.querySelector('.dsh-atb-toolbar [data-kind="external-filter"]')).toBeNull()
  })

  it('filters by urgency from inside the popover and counts active filters', async () => {
    const view = await mount()
    view.button()!.click()
    await waitFor(() => view.host.querySelector('[data-kind="more-menu"]') !== null)
    const urgent = view.host.querySelector<HTMLButtonElement>('[data-urgency="urgent"]')!
    urgent.click()
    await waitFor(() => view.controller.getSnapshot().filters.urgencies.includes('urgent'))
    await waitFor(() => view.host.querySelectorAll('.dsh-atb-card').length === 1)
    expect(view.button()!.textContent).toContain('1')
  })

  it('toggles the GitHub-only filter from the popover', async () => {
    const view = await mount()
    view.button()!.click()
    await waitFor(() => view.host.querySelector('[data-kind="external-filter"]') !== null)
    view.host.querySelector<HTMLButtonElement>('[data-kind="external-filter"]')!.click()
    await waitFor(() => view.controller.getSnapshot().filters.externalOnly === true)
    await waitFor(() => view.host.querySelectorAll('.dsh-atb-card').length === 1)
  })
})
