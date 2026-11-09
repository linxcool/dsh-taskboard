// @vitest-environment jsdom
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BoardController } from '../src/client/controller.ts'
import { TaskBoard, sortDoneTasks, groupAndSortTasksByWorkspace } from '../src/client/board/TaskBoard.tsx'
import { MAIN_STATUSES, type TaskRecord, type BoardSettings } from '../src/shared/protocol.ts'
import { waitFor } from './wait-for.ts'
import { disposeI18n } from '../src/client/i18n/runtime.ts'

const cleanups: Array<() => void> = []
beforeEach(() => {
  localStorage.clear()
  document.documentElement.lang = 'zh-CN'
  disposeI18n()
})
afterEach(() => {
  cleanups.splice(0).reverse().forEach(d => d())
  localStorage.clear()
})

function makeTask(id: string, index: number, status: TaskRecord['status'] = 'done'): TaskRecord {
  return {
    id,
    title: `Task ${id}`,
    description: '',
    prompt: '',
    workspaceId: 'ws-a',
    urgency: 'normal',
    status,
    blocked: false,
    execution: { mode: 'claim' },
    version: 1,
    createdAt: 1000 + index,
    updatedAt: 1000 + index,
    createdBy: { kind: 'user' },
    updatedBy: { kind: 'user' },
    comments: [],
    executions: [],
  }
}

async function renderBoard(tasks: TaskRecord[], settings: BoardSettings = {}) {
  const controller = new BoardController({
    state: async () => ({ schemaVersion: 1, revision: 1, tasks, settings }),
    workspaces: async () => [{ id: 'ws-a', path: '/p/a', title: 'A', sessionCount: 0 }],
    stream: () => () => {},
  } as never)
  controller.start()
  cleanups.push(() => controller.dispose())
  await waitFor(() => controller.getSnapshot().workspaces.length === 1)

  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  cleanups.push(() => { root.unmount(); host.remove() })

  root.render(React.createElement(TaskBoard, { controller }))
  return { controller, host }
}

describe('TaskBoard completed tasks display limit and foldbar', () => {
  it('truncates done column to default 50 when there are 60 done tasks', async () => {
    const tasks: TaskRecord[] = Array.from({ length: 60 }, (_, i) => makeTask(`done-${i}`, i))
    const { host } = await renderBoard(tasks)

    // Locate the done column
    await waitFor(() => host.querySelectorAll('.dsh-atb-column').length === MAIN_STATUSES.length)
    const columns = Array.from(host.querySelectorAll('.dsh-atb-column'))
    const doneCol = columns[4]! // backlog, todo, in_progress, in_review, done

    // Total count in column header should reflect real count (60)
    const countEl = doneCol.querySelector('.dsh-atb-colcount')
    expect(countEl?.textContent).toBe('60')

    // Only 50 cards rendered
    const cards = doneCol.querySelectorAll('.dsh-atb-card')
    expect(cards.length).toBe(50)

    // Foldbar appears with fold tip and expand button
    const foldBar = doneCol.querySelector('.dsh-atb-done-foldbar')
    expect(foldBar).toBeTruthy()
    expect(foldBar?.textContent).toContain('已折叠较早的 10 条已完成任务')
    const expandBtn = foldBar?.querySelector<HTMLButtonElement>('.dsh-atb-done-foldbtn')
    expect(expandBtn?.textContent).toBe('展开全部')
  })

  it('respects completedDisplayLimit from board settings', async () => {
    const tasks: TaskRecord[] = Array.from({ length: 30 }, (_, i) => makeTask(`done-${i}`, i))
    const { host } = await renderBoard(tasks, { completedDisplayLimit: 20 })

    await waitFor(() => host.querySelectorAll('.dsh-atb-column').length === MAIN_STATUSES.length)
    const doneCol = host.querySelectorAll('.dsh-atb-column')[4]!

    expect(doneCol.querySelector('.dsh-atb-colcount')?.textContent).toBe('30')
    const cards = doneCol.querySelectorAll('.dsh-atb-card')
    expect(cards.length).toBe(20)

    const foldBar = doneCol.querySelector('.dsh-atb-done-foldbar')
    expect(foldBar?.textContent).toContain('已折叠较早的 10 条已完成任务')
  })

  it('expands all tasks on click and can be collapsed again', async () => {
    const tasks: TaskRecord[] = Array.from({ length: 55 }, (_, i) => makeTask(`done-${i}`, i))
    const { host } = await renderBoard(tasks)

    await waitFor(() => host.querySelectorAll('.dsh-atb-column').length === MAIN_STATUSES.length)
    const doneCol = host.querySelectorAll('.dsh-atb-column')[4]!
    expect(doneCol.querySelectorAll('.dsh-atb-card').length).toBe(50)

    const expandBtn = doneCol.querySelector<HTMLButtonElement>('.dsh-atb-done-foldbtn')!
    expect(expandBtn.textContent).toBe('展开全部')

    // Click expand all
    expandBtn.click()
    await waitFor(() => doneCol.querySelectorAll('.dsh-atb-card').length === 55)

    const collapseBtn = doneCol.querySelector<HTMLButtonElement>('.dsh-atb-done-foldbtn')!
    expect(collapseBtn.textContent).toBe('收起')

    // Click collapse
    collapseBtn.click()
    await waitFor(() => doneCol.querySelectorAll('.dsh-atb-card').length === 50)
  })

  it('exempts truncation when search keyword is active', async () => {
    const tasks: TaskRecord[] = Array.from({ length: 60 }, (_, i) => makeTask(`done-${i}`, i))
    const { host, controller } = await renderBoard(tasks)

    await waitFor(() => host.querySelectorAll('.dsh-atb-column').length === MAIN_STATUSES.length)
    const doneCol = host.querySelectorAll('.dsh-atb-column')[4]!
    expect(doneCol.querySelectorAll('.dsh-atb-card').length).toBe(50)

    // Type search matching all tasks
    controller.setSearch('done')
    await waitFor(() => doneCol.querySelectorAll('.dsh-atb-card').length === 60)

    // Foldbar should not be shown during search
    expect(doneCol.querySelector('.dsh-atb-done-foldbar')).toBeNull()

    // Clear search restores fold
    controller.setSearch('')
    await waitFor(() => doneCol.querySelectorAll('.dsh-atb-card').length === 50)
    expect(doneCol.querySelector('.dsh-atb-done-foldbar')).toBeTruthy()
  })

  it('renders completed tasks newest-first (time descending order)', async () => {
    // 3 tasks completed at different times; passed in oldest-first order
    const taskOld = makeTask('done-old', 0)
    taskOld.updatedAt = 1000
    const taskMid = makeTask('done-mid', 1)
    taskMid.updatedAt = 2000
    const taskNew = makeTask('done-new', 2)
    taskNew.updatedAt = 3000

    const { host } = await renderBoard([taskOld, taskMid, taskNew])

    await waitFor(() => host.querySelectorAll('.dsh-atb-column').length === MAIN_STATUSES.length)
    const doneCol = host.querySelectorAll('.dsh-atb-column')[4]!
    const cards = Array.from(doneCol.querySelectorAll('.dsh-atb-card'))

    expect(cards.length).toBe(3)
    // The newest completed task should be placed first
    expect(cards[0]?.textContent).toContain('Task done-new')
    expect(cards[1]?.textContent).toContain('Task done-mid')
    expect(cards[2]?.textContent).toContain('Task done-old')
  })

  it('when truncated, retains the newest completed tasks and folds the older ones', async () => {
    // 60 tasks, index 0..59, updatedAt = 1000 + i (so done-59 is the newest)
    const tasks: TaskRecord[] = Array.from({ length: 60 }, (_, i) => makeTask(`done-${i}`, i))
    const { host } = await renderBoard(tasks)

    await waitFor(() => host.querySelectorAll('.dsh-atb-column').length === MAIN_STATUSES.length)
    const doneCol = host.querySelectorAll('.dsh-atb-column')[4]!
    const cards = Array.from(doneCol.querySelectorAll('.dsh-atb-card'))

    expect(cards.length).toBe(50)
    // First card displayed is the newest completed task
    expect(cards[0]?.textContent).toContain('Task done-59')
    // 50th card displayed is done-10
    expect(cards[49]?.textContent).toContain('Task done-10')

    // Older tasks (done-9 through done-0) are folded
    const foldBar = doneCol.querySelector('.dsh-atb-done-foldbar')
    expect(foldBar?.textContent).toContain('已折叠较早的 10 条已完成任务')

    // Expanding all shows newest (done-59) to oldest (done-0)
    const expandBtn = foldBar?.querySelector<HTMLButtonElement>('.dsh-atb-done-foldbtn')!
    expandBtn.click()
    await waitFor(() => doneCol.querySelectorAll('.dsh-atb-card').length === 60)
    const allCards = Array.from(doneCol.querySelectorAll('.dsh-atb-card'))
    expect(allCards[0]?.textContent).toContain('Task done-59')
    expect(allCards[59]?.textContent).toContain('Task done-0')
  })

  it('sortDoneTasks unit: sorts by updatedAt desc, ties broken by createdAt desc, then id desc', () => {
    const t1 = { ...makeTask('t1', 1), updatedAt: 200, createdAt: 100 }
    const t2 = { ...makeTask('t2', 2), updatedAt: 300, createdAt: 150 }
    const t3 = { ...makeTask('t3', 3), updatedAt: 200, createdAt: 120 }
    const t4 = { ...makeTask('t4', 4), updatedAt: 200, createdAt: 120 }

    const sorted = sortDoneTasks([t1, t2, t3, t4])
    expect(sorted.map(t => t.id)).toEqual(['t2', 't4', 't3', 't1'])
  })

  it('groupAndSortTasksByWorkspace unit: sorts groups and internal tasks properly', () => {
    const ws = [
      { id: 'ws-a', title: 'Alpha' },
      { id: 'ws-z', title: 'Zebra' },
    ]
    const tA1 = { ...makeTask('t-a1', 1), workspaceId: 'ws-a', updatedAt: 1000 }
    const tZ1 = { ...makeTask('t-z1', 2), workspaceId: 'ws-z', updatedAt: 3000 }
    const tZ2 = { ...makeTask('t-z2', 3), workspaceId: 'ws-z', updatedAt: 2000 }

    // In latestTask mode, Zebra has the latest task (3000) so it must come first
    const groupsLatest = groupAndSortTasksByWorkspace([tA1, tZ1, tZ2], ws, 'Unassigned', 'latestTask')
    expect(groupsLatest.map(g => g.workspaceId)).toEqual(['ws-z', 'ws-a'])
    // Inside Zebra, tasks must be descending by updatedAt
    expect(groupsLatest[0]?.tasks.map(t => t.id)).toEqual(['t-z1', 't-z2'])

    // In name mode, Alpha must come before Zebra
    const groupsName = groupAndSortTasksByWorkspace([tA1, tZ1, tZ2], ws, 'Unassigned', 'name')
    expect(groupsName.map(g => g.workspaceId)).toEqual(['ws-a', 'ws-z'])
  })

  it('renders completed tasks across multiple workspaces with newest completed workspace on top', async () => {
    const ws = [
      { id: 'ws-alpha', path: '/p/alpha', title: 'Alpha Project', sessionCount: 0 },
      { id: 'ws-zebra', path: '/p/zebra', title: 'Zebra Project', sessionCount: 0 },
    ]
    // Alpha has older completed task (1000)
    const taskAlpha = makeTask('alpha-1', 0)
    taskAlpha.workspaceId = 'ws-alpha'
    taskAlpha.updatedAt = 1000

    // Zebra has newest completed task (5000) and an older one (2000)
    const taskZebraOld = makeTask('zebra-1', 1)
    taskZebraOld.workspaceId = 'ws-zebra'
    taskZebraOld.updatedAt = 2000

    const taskZebraNew = makeTask('zebra-2', 2)
    taskZebraNew.workspaceId = 'ws-zebra'
    taskZebraNew.updatedAt = 5000

    const controller = new BoardController({
      state: async () => ({ schemaVersion: 1, revision: 1, tasks: [taskAlpha, taskZebraOld, taskZebraNew], settings: {} }),
      workspaces: async () => ws,
      stream: () => () => {},
    } as never)
    controller.start()
    cleanups.push(() => controller.dispose())
    await waitFor(() => controller.getSnapshot().workspaces.length === 2)

    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)
    cleanups.push(() => { root.unmount(); host.remove() })

    root.render(React.createElement(TaskBoard, { controller }))

    await waitFor(() => host.querySelectorAll('.dsh-atb-column').length === MAIN_STATUSES.length)
    const doneCol = host.querySelectorAll('.dsh-atb-column')[4]!

    // The first workspace group must be Zebra Project because it contains the newest completed task
    const groupHeads = Array.from(doneCol.querySelectorAll('.dsh-atb-ws-group-head'))
    expect(groupHeads.length).toBe(2)
    expect(groupHeads[0]?.textContent).toContain('Zebra Project')
    expect(groupHeads[1]?.textContent).toContain('Alpha Project')

    // The very first card in the Done column must be the newest completed task (zebra-2)
    const cards = Array.from(doneCol.querySelectorAll('.dsh-atb-card'))
    expect(cards.length).toBe(3)
    expect(cards[0]?.textContent).toContain('Task zebra-2')
    expect(cards[1]?.textContent).toContain('Task zebra-1')
    expect(cards[2]?.textContent).toContain('Task alpha-1')
  })
})
