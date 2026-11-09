// @vitest-environment jsdom
/**
 * Column labels: the connected GitHub Project's Status option names win; with
 * no connection (or a partial map) the i18n default copy is used per column.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { columnLabel } from '../src/client/board/labels.ts'

const zh: Record<string, string> = {
  'status.column.backlog': '待澄清',
  'status.column.todo': '就绪',
  'status.column.canceled': '取消',
}
const t = (key: string) => zh[key] ?? key

describe('columnLabel', () => {
  it('falls back to i18n without a map', () => {
    expect(columnLabel(t, 'backlog', undefined)).toBe('待澄清')
  })

  it('prefers the connection option name', () => {
    expect(columnLabel(t, 'backlog', { backlog: '待澄清（GitHub）' })).toBe('待澄清（GitHub）')
  })

  it('falls back per column when the map lacks it', () => {
    expect(columnLabel(t, 'canceled', { backlog: 'x' })).toBe('取消')
  })

  it('ignores an empty mapped name', () => {
    expect(columnLabel(t, 'todo', { todo: '' })).toBe('就绪')
  })
})

// Board render: the map is fetched from the live connection.
describe('board column headers', () => {
  const json = (value: unknown) => new Response(JSON.stringify({ ok: true, value }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('follows the connected status map', async () => {
    document.documentElement.lang = 'zh-CN'
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { BoardController } = await import('../src/client/controller.ts')
    const { TaskBoard } = await import('../src/client/board/TaskBoard.tsx')

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith('/dsh-taskboard/state')) return json({ schemaVersion: 1, revision: 1, tasks: [] })
      if (path.endsWith('/dsh-taskboard/workspaces')) return json([])
      if (path.endsWith('/dsh-taskboard/external')) {
        return json({ config: { provider: 'github', settings: { writebackMode: 'status', statusMap: 'todo=等你点头' } } })
      }
      throw new Error(`unexpected fetch ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', class { onerror = null; close() {}; addEventListener() {} } as unknown as typeof EventSource)

    const client = { state: async () => ({ schemaVersion: 1, revision: 1, tasks: [] }), workspaces: async () => [], stream: () => () => {} }
    const controller = new BoardController(client as never)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    root.render(React.createElement(TaskBoard, { controller }))
    controller.start()
    await new Promise(resolve => setTimeout(resolve, 60))

    const heads = Array.from(host.querySelectorAll<HTMLElement>('.dsh-atb-colhead')).map(head => head.textContent ?? '')
    expect(heads.some(text => text.includes('等你点头'))).toBe(true)
    // A column the map does not cover keeps the shipped copy.
    expect(heads.some(text => text.includes('待澄清'))).toBe(true)

    root.unmount()
  })
})
