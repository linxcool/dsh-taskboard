// @vitest-environment jsdom
/**
 * Epic filter: epics never become cards; the toolbar lists them from the sync
 * record and selecting one shows descendants at any depth.
 */
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoardController } from '../src/client/controller.ts'
import { TaskBoard } from '../src/client/board/TaskBoard.tsx'
import type { TaskRecord } from '../src/shared/protocol.ts'
import type { ExternalEpic, ExternalSource } from '../src/shared/external.ts'
import { disposeI18n } from '../src/client/i18n/runtime.ts'
import { waitFor } from './wait-for.ts'

const cleanups: Array<() => void> = []
beforeEach(() => { localStorage.clear(); document.documentElement.lang = 'zh-CN'; disposeI18n() })
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); vi.unstubAllGlobals(); localStorage.clear() })

const external = (id: string, parentNumber?: number): ExternalSource => ({
  connectionId: 'c', provider: 'github', syncedAt: 1, conflicts: [],
  item: {
    projectId: 'acme/repo', type: 'issue', id, title: `Issue ${id}`, description: '',
    urgency: 'normal', priority: '', status: 'open', assignedTo: '', closed: false,
    url: `https://github.com/acme/repo/issues/${id}`,
    ...(parentNumber !== undefined ? { parentNumber } : {}),
  },
})

const task = (id: string, issueId: string, parentNumber?: number): TaskRecord => ({
  id, title: `Issue ${issueId}`, description: '', prompt: '', workspaceId: 'ws-a',
  urgency: 'normal', status: 'todo', blocked: false, execution: { mode: 'claim' },
  version: 1, createdAt: 0, updatedAt: 0,
  createdBy: { kind: 'user' }, updatedBy: { kind: 'user' },
  comments: [], executions: [], external: external(issueId, parentNumber),
} as TaskRecord)

const epics: ExternalEpic[] = [
  { key: 'c-16', repo: 'acme/repo', number: 16, title: 'M2 里程碑', children: 3 },
  { key: 'c-17', repo: 'acme/repo', number: 17, title: 'M3 里程碑', children: 1 },
]

async function mount() {
  const tasks = [
    task('t-5', '5', 16),
    task('t-8', '8', 5), // grandchild of #16
    task('t-9', '9', 5), // grandchild of #16
    task('t-20', '20', 17),
  ]
  const controller = new BoardController({
    state: async () => ({
      schemaVersion: 1,
      revision: 1,
      tasks,
      externalSync: { c: { links: {}, ignored: [], epics } },
    }),
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
  await waitFor(() => host.querySelectorAll('.dsh-atb-card').length === 4)
  const openScope = async () => {
    await React.act(async () => { host.querySelector<HTMLButtonElement>('[data-kind="scope"]')!.click() })
    await waitFor(() => host.querySelector('[data-kind="scope-menu"]') !== null)
    return host.querySelector('[data-kind="scope-menu"]')!
  }
  const pickEpic = async (value: string) => {
    const menu = await openScope()
    const option = menu.querySelector<HTMLButtonElement>(`[data-scope="epic"][data-value="${value}"]`)!
    await React.act(async () => { option.click() })
  }
  const titles = () => [...host.querySelectorAll('.dsh-atb-card')].map(card => card.textContent ?? '')
  return { host, controller, openScope, pickEpic, titles }
}

describe('epic filter', () => {
  it('lists the epics from the sync record', async () => {
    const view = await mount()
    const menu = await view.openScope()
    const values = [...menu.querySelectorAll<HTMLButtonElement>('[data-scope="epic"]')].map(button => button.dataset.value)
    expect(values).toEqual(['', '16', '17'])
    expect(menu.textContent).toContain('M2 里程碑')
  })

  it('shows every card by default and only descendants once an epic is chosen', async () => {
    const view = await mount()
    expect(view.titles()).toHaveLength(4)

    await view.pickEpic('16')
    // #5 plus its grandchildren #8/#9; #20 belongs to the other epic.
    await waitFor(() => view.titles().length === 3)
    expect(view.controller.getSnapshot().parentFilter).toBe(16)
    expect(view.titles().some(text => text.includes('Issue 20'))).toBe(false)

    await view.pickEpic('')
    await waitFor(() => view.titles().length === 4)
  })
})
