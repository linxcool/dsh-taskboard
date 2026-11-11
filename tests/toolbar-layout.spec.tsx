// @vitest-environment jsdom
/**
 * Toolbar layout A (one row + popovers): view segments, a merged scope picker
 * (project + epic), a filter popover with a count badge, removable filter chips,
 * and an overflow menu holding the admin actions and the version.
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

const task = (id: string, issueId: string, extra: Partial<TaskRecord> = {}, parentNumber?: number): TaskRecord => ({
  id, title: `Issue ${issueId}`, description: '', prompt: '', workspaceId: 'ws-a',
  urgency: 'normal', status: 'todo', blocked: false, execution: { mode: 'claim' },
  version: 1, createdAt: 0, updatedAt: 0,
  createdBy: { kind: 'user' }, updatedBy: { kind: 'user' },
  comments: [], executions: [], external: external(issueId, parentNumber),
  ...extra,
} as TaskRecord)

const epics: ExternalEpic[] = [
  { key: 'c-16', repo: 'acme/repo', number: 16, title: 'M2 里程碑', children: 3 },
  { key: 'c-17', repo: 'acme/repo', number: 17, title: 'M3 里程碑', children: 1 },
]

async function mount() {
  const tasks = [
    task('t-5', '5', { urgency: 'urgent' }, 16),
    task('t-8', '8', {}, 5),
    task('t-20', '20', {}, 17),
    task('t-99', '99', { waitingForHuman: true, waitingReason: '确认目标' }, 16),
  ]
  const controller = new BoardController({
    state: async () => ({ schemaVersion: 1, revision: 7, tasks, externalSync: { c: { links: {}, ignored: [], epics } } }),
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
  const click = async (element: Element | null) => {
    expect(element).not.toBeNull()
    await React.act(async () => { (element as HTMLElement).click() })
  }
  return { host, controller, click, cards: () => host.querySelectorAll('.dsh-atb-card').length }
}

describe('toolbar layout A', () => {
  it('keeps the title and the controls on ONE row', async () => {
    const view = await mount()
    expect(view.host.querySelector('[data-kind="header"]')).toBeNull()
    const toolbar = view.host.querySelector('.dsh-atb-toolbar')!
    expect(toolbar.textContent).toContain('AGENT')
    expect(toolbar.textContent).toContain('rev 7')
    expect(toolbar.querySelector('.dsh-atb-title')).not.toBeNull()
    for (const control of ['view-board', 'scope', 'more-filter', 'more-actions']) {
      expect(toolbar.querySelector(`[data-kind="${control}"]`)).not.toBeNull()
    }
    expect(toolbar.querySelector('[data-kind="search"]')).not.toBeNull()
  })

  it('shows the version only inside the overflow menu', async () => {
    const view = await mount()
    expect(view.host.textContent).not.toMatch(/V0\.\d/)
    await view.click(view.host.querySelector('[data-kind="more-actions"]'))
    await waitFor(() => view.host.querySelector('[data-kind="more-actions-menu"]') !== null)
    const menu = view.host.querySelector('[data-kind="more-actions-menu"]')!
    expect(menu.querySelector('[data-kind="version"]')?.textContent).toMatch(/0\.9|0\.1/)
    for (const action of ['employees', 'settings', 'diag', 'import', 'export-json', 'export-csv']) {
      expect(menu.querySelector(`[data-action="${action}"]`)).not.toBeNull()
    }
    // The labels already carry their icon: a second prefix rendered "👥 👥 员工".
    for (const entry of menu.querySelectorAll('[data-action]')) {
      expect(entry.textContent ?? '').not.toMatch(/(👥|⚙|🩺|⬆|⬇|🐙|🙋)\s*\1/)
    }
    // Every row reserves the same icon column so the LABELS line up, and each
    // row actually has an icon (export used to be the only pair without one).
    for (const entry of menu.querySelectorAll('[data-action]')) {
      expect(entry.querySelector('.dsh-atb-opt-icon')?.textContent?.trim()).toBeTruthy()
      expect(entry.querySelector('.dsh-atb-opt-text')?.textContent?.trim()).toBeTruthy()
      // Nothing here is selectable: a check column would just indent every icon
      // away from the version line at the bottom.
      expect(entry.querySelector('.dsh-atb-opt-check')).toBeNull()
    }
  })

  it('reserves the icon column in the scope menu too', async () => {
    const view = await mount()
    await view.click(view.host.querySelector('[data-kind="scope"]'))
    await waitFor(() => view.host.querySelector('[data-kind="scope-menu"]') !== null)
    const rows = view.host.querySelectorAll('[data-scope]')
    expect(rows.length).toBeGreaterThan(2)
    for (const row of rows) {
      expect(row.querySelector('.dsh-atb-opt-icon')).not.toBeNull()
      expect(row.querySelector('.dsh-atb-opt-text')?.textContent?.trim()).toBeTruthy()
      // Selectable rows keep the check column so a ✓ never shifts the label.
      expect(row.querySelector('.dsh-atb-opt-check')).not.toBeNull()
    }
  })

  it('drives the views from one segmented control', async () => {
    const view = await mount()
    const needs = view.host.querySelector('[data-kind="needs-human-filter"]')!
    expect(needs.textContent).toContain('待我处理')
    await view.click(needs)
    await waitFor(() => view.cards() === 1)
    await view.click(view.host.querySelector('[data-kind="view-board"]'))
    await waitFor(() => view.cards() === 4)
  })

  it('names the sort/filter drawer 排序', async () => {
    const view = await mount()
    const button = view.host.querySelector('[data-kind="more-filter"]')!
    expect(button.textContent).toContain('排序')
    expect(button.textContent).not.toContain('更多筛选')
  })

  it('merges project and epic into one scope picker and shows a removable chip', async () => {
    const view = await mount()
    await view.click(view.host.querySelector('[data-kind="scope"]'))
    await waitFor(() => view.host.querySelector('[data-kind="scope-menu"]') !== null)
    const menu = view.host.querySelector('[data-kind="scope-menu"]')!
    expect(menu.querySelectorAll('[data-scope="epic"]').length).toBe(3) // 全部 + 两个史诗
    await view.click(menu.querySelector('[data-scope="epic"][data-value="16"]'))
    await waitFor(() => view.controller.getSnapshot().parentFilter === 16)
    // #5 (child of 16), #8 (grandchild) and #99; #20 belongs to the other epic.
    await waitFor(() => view.cards() === 3)

    const chip = view.host.querySelector('[data-kind="filter-chip"][data-chip="epic"]')!
    expect(chip.textContent).toContain('#16')
    await view.click(chip.querySelector('button'))
    await waitFor(() => view.controller.getSnapshot().parentFilter === undefined)
    await waitFor(() => view.cards() === 4)
  })

  it('turns the urgency filter into a chip and clears every filter at once', async () => {
    const view = await mount()
    await view.click(view.host.querySelector('[data-kind="more-filter"]'))
    await waitFor(() => view.host.querySelector('[data-kind="more-menu"]') !== null)
    await view.click(view.host.querySelector('[data-urgency="urgent"]'))
    await waitFor(() => view.controller.getSnapshot().filters.urgencies.includes('urgent'))
    await waitFor(() => view.host.querySelector('[data-kind="filter-chip"][data-chip="urgency:urgent"]') !== null)
    expect(view.host.querySelector('[data-kind="more-filter"]')!.textContent).toContain('1')
    await view.click(view.host.querySelector('[data-kind="filter-clear"]'))
    await waitFor(() => view.controller.getSnapshot().filters.urgencies.length === 0)
    expect(view.host.querySelector('[data-kind="filter-chip"]')).toBeNull()
  })

  it('keeps the search field collapsed behind an icon', async () => {
    const view = await mount()
    const wrapper = view.host.querySelector('[data-kind="search"]')!
    expect(wrapper.getAttribute('data-expanded')).toBe('false')
    expect(view.host.querySelector('.dsh-atb-search')).not.toBeNull()
    await view.click(view.host.querySelector('[data-kind="search-toggle"]'))
    await waitFor(() => view.host.querySelector('[data-kind="search"]')!.getAttribute('data-expanded') === 'true')
    // Typing still drives the controller filter.
    const input = view.host.querySelector<HTMLInputElement>('.dsh-atb-search')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await React.act(async () => {
      setValue.call(input, 'Issue 20')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await waitFor(() => view.controller.getSnapshot().search === 'Issue 20')
    await waitFor(() => view.cards() === 1)
  })
})
