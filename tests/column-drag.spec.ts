// @vitest-environment jsdom
/**
 * Dragging onto the canceled column: it goes through the same transition gate
 * as every other column (in-flight cards can be cancelled, finished ones
 * cannot), and the menu path still cancels.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const DRAG = 'application/x-dsh-atb-task'
const json = (value: unknown) => new Response(JSON.stringify({ ok: true, value }), {
  status: 200, headers: { 'content-type': 'application/json' },
})

class EventSourceMock {
  onerror: (() => void) | null = null
  close(): void { /* no-op */ }
  addEventListener(): void { /* no-op */ }
}

const mkTask = (id: string, status: string) => ({
  id, title: id, description: '', prompt: '', workspaceId: 'ws-a',
  urgency: 'normal' as const, status: status as never, blocked: false,
  execution: { mode: 'claim' as const }, version: 7, createdAt: 0, updatedAt: 0,
  createdBy: { kind: 'user' as const }, updatedBy: { kind: 'user' as const },
  comments: [], executions: [],
})

describe('canceled column drop', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.lang = 'zh-CN'
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  const render = async (tasks: unknown[]) => {
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { BoardController } = await import('../src/client/controller.ts')
    const { TaskBoard } = await import('../src/client/board/TaskBoard.tsx')
    const moves: Array<{ id: string; version: number; status: string }> = []
    const client = {
      state: async () => ({ schemaVersion: 1, revision: 1, tasks }),
      workspaces: async () => [],
      stream: () => () => {},
      move: async (id: string, body: { ifVersion: number; status: string }) => {
        moves.push({ id, version: body.ifVersion, status: body.status })
        return {}
      },
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith('/dsh-taskboard/state')) return json({ schemaVersion: 1, revision: 1, tasks })
      if (path.endsWith('/dsh-taskboard/workspaces')) return json([])
      throw new Error(`unexpected fetch ${path}`)
    }))
    vi.stubGlobal('EventSource', EventSourceMock as unknown as typeof EventSource)
    const controller = new BoardController(client as never)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    root.render(React.createElement(TaskBoard, { controller }))
    controller.start()
    await new Promise(resolve => setTimeout(resolve, 40))
    return { host, root, moves, controller }
  }

  const drop = (target: Element, id: string): Event => {
    const dataTransfer = { types: [DRAG], getData: () => id, dropEffect: 'none' }
    const over = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(over, 'dataTransfer', { value: dataTransfer })
    target.dispatchEvent(over)
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
    target.dispatchEvent(event)
    return event
  }

  it('cancels an in-flight card dropped on the collapsed canceled column', async () => {
    const { host, root, moves } = await render([mkTask('t-doing', 'in_progress')])
    const canceled = Array.from(host.querySelectorAll<HTMLElement>('.dsh-atb-column'))
      .find(column => column.querySelector('.dsh-atb-dot[data-status="canceled"]') !== null)!
    expect(canceled.getAttribute('data-collapsed')).toBe('true')
    drop(canceled, 't-doing')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(moves).toEqual([{ id: 't-doing', version: 7, status: 'canceled' }])
    root.unmount()
  })

  it('refuses a finished card dropped on the canceled column', async () => {
    const { host, root, moves } = await render([mkTask('t-done', 'done')])
    const canceled = Array.from(host.querySelectorAll<HTMLElement>('.dsh-atb-column'))
      .find(column => column.querySelector('.dsh-atb-dot[data-status="canceled"]') !== null)!
    drop(canceled, 't-done')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(moves).toEqual([])
    root.unmount()
  })

  it('still offers cancel from the detail pane', async () => {
    const { host, root, moves, controller } = await render([mkTask('t-doing', 'in_progress')])
    controller.select('t-doing')
    await new Promise(resolve => setTimeout(resolve, 30))
    const cancelBtn = Array.from(host.querySelectorAll<HTMLButtonElement>('.dsh-atb-movebtn'))
      .find(button => button.dataset.to === 'canceled')
    expect(cancelBtn).toBeDefined()
    cancelBtn!.click()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(moves).toEqual([{ id: 't-doing', version: 7, status: 'canceled' }])
    root.unmount()
  })
})
