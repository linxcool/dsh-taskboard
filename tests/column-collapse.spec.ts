// @vitest-environment jsdom
/**
 * Column collapse state: one list of collapsed columns replaces the three
 * per-column booleans, the canceled column starts collapsed, and a previous
 * browser's legacy keys still migrate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateCollapsedColumns } from '../src/client/controller.ts'

describe('migrateCollapsedColumns', () => {
  it('turns the legacy booleans into a list and keeps canceled closed', () => {
    expect(migrateCollapsedColumns({ backlogCollapsed: true, todoCollapsed: false, doneCollapsed: true }))
      .toEqual(['backlog', 'done', 'canceled'])
  })

  it('defaults a fresh view to the canceled column closed', () => {
    expect(migrateCollapsedColumns({})).toEqual(['canceled'])
  })

  it('keeps an explicit list authoritative', () => {
    expect(migrateCollapsedColumns({ collapsedColumns: ['todo'] })).toEqual(['todo'])
  })

  it('drops entries that are not board statuses', () => {
    expect(migrateCollapsedColumns({ collapsedColumns: ['todo', 'nope', 42] })).toEqual(['todo'])
  })
})

const jsonResponse = (value: unknown) => new Response(JSON.stringify({ ok: true, value }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

class EventSourceMock {
  onerror: (() => void) | null = null
  close(): void { /* no-op */ }
  addEventListener(): void { /* no-op */ }
}

describe('canceled column collapse', () => {
  const mkTask = (id: string, status: string) => ({
    id, title: id, description: '', prompt: '', workspaceId: 'ws-a',
    urgency: 'normal' as const, status: status as never, blocked: false,
    execution: { mode: 'claim' as const }, version: 1, createdAt: 0, updatedAt: 0,
    createdBy: { kind: 'user' as const }, updatedBy: { kind: 'user' as const },
    comments: [], executions: [],
  })

  beforeEach(() => {
    localStorage.clear()
    document.documentElement.lang = 'zh-CN'
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('starts collapsed and expands on demand', async () => {
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { BoardController } = await import('../src/client/controller.ts')
    const { TaskBoard } = await import('../src/client/board/TaskBoard.tsx')

    const tasks = [mkTask('t-1', 'todo'), mkTask('t-2', 'canceled')]
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith('/dsh-taskboard/state')) return jsonResponse({ schemaVersion: 1, revision: 1, tasks })
      if (path.endsWith('/dsh-taskboard/workspaces')) return jsonResponse([])
      throw new Error(`unexpected fetch ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', EventSourceMock as unknown as typeof EventSource)
    const client = {
      state: async () => ({ schemaVersion: 1, revision: 1, tasks }),
      workspaces: async () => [],
      stream: () => () => {},
    }
    const controller = new BoardController(client as never)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    root.render(React.createElement(TaskBoard, { controller }))
    controller.start()
    await new Promise(resolve => setTimeout(resolve, 40))

    const collapsed = () => Array.from(host.querySelectorAll<HTMLElement>('.dsh-atb-column[data-collapsed="true"]'))
      .map(column => column.querySelector('.dsh-atb-dot')?.getAttribute('data-status'))
    expect(collapsed()).toEqual(['canceled'])

    // Persisted as a list once the view changes, not the legacy booleans.
    const bar = host.querySelector<HTMLElement>('.dsh-atb-column[data-collapsed="true"] .dsh-atb-col-collapsed-bar')
    bar?.click()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(collapsed()).toEqual([])

    const stored = JSON.parse(localStorage.getItem('dsh-taskboard-view-v1') ?? '{}') as Record<string, unknown>
    expect(stored.collapsedColumns).toEqual([])
    expect(stored.backlogCollapsed).toBeUndefined()

    root.unmount()
  })
})
