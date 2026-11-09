// @vitest-environment jsdom
/**
 * Six-column board: `canceled` is a main column (the GitHub Project Status
 * vocabulary has six options), and the secondary tab keeps only archived and
 * trashed cards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ALL_STATUSES, MAIN_STATUSES, SECONDARY_STATUSES, canTransition,
} from '../src/shared/protocol.ts'

const jsonResponse = (value: unknown) => new Response(JSON.stringify({ ok: true, value }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

class EventSourceMock {
  onerror: (() => void) | null = null
  close(): void { /* no-op */ }
  addEventListener(): void { /* no-op */ }
}

describe('status sets', () => {
  it('main board has six columns ending with canceled', () => {
    expect(MAIN_STATUSES).toEqual(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled'])
  })

  it('secondary holds only archived', () => {
    expect(SECONDARY_STATUSES).toEqual(['archived'])
  })

  it('every status still appears exactly once across both sets', () => {
    expect([...MAIN_STATUSES, ...SECONDARY_STATUSES].sort()).toEqual([...ALL_STATUSES].sort())
  })

  it('done cannot transition to canceled', () => {
    expect(canTransition('done', 'canceled')).toBe(false)
  })

  it('an in-flight card can be canceled', () => {
    expect(canTransition('in_progress', 'canceled')).toBe(true)
  })
})

describe('board rendering', () => {
  beforeEach(() => {
    // No DSH locale service in this fake context: pin the fallback to zh so
    // the column labels asserted below are the shipped Chinese copy.
    document.documentElement.lang = 'zh-CN'
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  const mkTask = (id: string, status: string, trashed = false) => ({
    id, title: id, description: '', prompt: '', workspaceId: 'ws-a',
    urgency: 'normal' as const, status: status as never, blocked: false,
    execution: { mode: 'claim' as const }, version: 1, createdAt: 0, updatedAt: 0,
    createdBy: { kind: 'user' as const }, updatedBy: { kind: 'user' as const },
    comments: [], executions: [],
    ...(trashed ? { trashedAt: 1 } : {}),
  })

  it('renders a canceled task in the main canceled column, not in the secondary tab', async () => {
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { BoardController } = await import('../src/client/controller.ts')
    const { TaskBoard } = await import('../src/client/board/TaskBoard.tsx')

    const tasks = [mkTask('t-1', 'todo'), mkTask('t-2', 'canceled'), mkTask('t-3', 'archived')]
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
    await new Promise(resolve => setTimeout(resolve, 30))

    // Main view: six column heads, the last one carrying the canceled dot.
    const heads = () => Array.from(host.querySelectorAll<HTMLElement>('.dsh-atb-colhead'))
    expect(heads()).toHaveLength(MAIN_STATUSES.length)
    const dots = Array.from(host.querySelectorAll<HTMLElement>('.dsh-atb-colhead .dsh-atb-dot'))
    expect(dots[dots.length - 1]?.dataset.status).toBe('canceled')
    // The canceled card is inside the canceled column, not hidden away.
    const canceledColumn = Array.from(host.querySelectorAll<HTMLElement>('.dsh-atb-column'))
      .find(column => column.querySelector('.dsh-atb-dot[data-status="canceled"]') !== null)
    expect(canceledColumn).toBeDefined()
    expect(canceledColumn?.textContent ?? '').toContain('t-2')

    // Secondary tab: no canceled group any more; archived and trashed remain.
    controller.toggleSecondary()
    await new Promise(resolve => setTimeout(resolve, 60))
    const secondaryHeads = Array.from(host.querySelectorAll<HTMLElement>('.dsh-atb-column'))
      .map(column => column.querySelector('.dsh-atb-colhead')?.textContent ?? '')
      .filter(text => text.length > 0)
    expect(secondaryHeads.join('|')).not.toContain('已取消')
    expect(secondaryHeads.join('|')).toMatch(/归档|已归档/)
    expect(secondaryHeads.join('|')).toMatch(/回收站|已删除/)

    root.unmount()
  })
})
