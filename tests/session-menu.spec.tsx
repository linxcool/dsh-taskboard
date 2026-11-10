// @vitest-environment jsdom
/**
 * Card conversation slot: aggregated session list when the card has runs, and
 * the open-session composer (preview → edit → send) when it has none.
 */
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionMenu } from '../src/client/board/SessionMenu.tsx'
import type { BoardController } from '../src/client/controller.ts'
import { sessionsOf, type TaskRecord } from '../src/shared/protocol.ts'
import { disposeI18n } from '../src/client/i18n/runtime.ts'
import { waitFor } from './wait-for.ts'

const cleanups: Array<() => void> = []
beforeEach(() => {
  localStorage.clear()
  document.documentElement.lang = 'zh-CN'
  disposeI18n()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})
afterEach(async () => {
  cleanups.splice(0).reverse().forEach(dispose => dispose())
  localStorage.clear()
  vi.unstubAllGlobals()
})

const makeTask = (executions: TaskRecord['executions'] = []): TaskRecord => ({
  id: 't-1', title: '任务', description: '', prompt: '', workspaceId: 'ws-a',
  urgency: 'normal', status: 'todo', blocked: false, execution: { mode: 'claim' },
  version: 1, createdAt: 0, updatedAt: 0,
  createdBy: { kind: 'user' }, updatedBy: { kind: 'user' },
  comments: [], executions,
} as TaskRecord)

const execution = (id: string, sessionId: string, startedAt: number, outcome: TaskRecord['executions'][number]['outcome'] = 'succeeded') => ({
  id, trigger: 'manual' as const, outcome, startedAt, sessionId,
})

async function render(task: TaskRecord, overrides: Partial<Record<keyof BoardController, unknown>> = {}) {
  const controller = {
    openingBodyFor: vi.fn(async () => '标题\n\n描述'),
    startWithOpeningBody: vi.fn(async () => true),
    openSession: vi.fn(async () => 'opened'),
    select: vi.fn(),
    ...overrides,
  } as unknown as BoardController
  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  cleanups.push(() => { root.unmount(); host.remove() })
  root.render(React.createElement(SessionMenu, { controller, task }))
  return { host, controller }
}

describe('sessionsOf', () => {
  it('aggregates executions by session, newest first, with round counts', () => {
    const task = makeTask([
      execution('e1', 's-1', 10),
      execution('e2', 's-1', 30),
      execution('e3', 's-2', 20),
    ])
    const sessions = sessionsOf(task)
    expect(sessions.map(session => session.sessionId)).toEqual(['s-1', 's-2'])
    expect(sessions[0]!.rounds).toBe(2)
    expect(sessions[0]!.lastAt).toBe(30)
  })

  it('ignores executions without a session and returns nothing for a fresh card', () => {
    expect(sessionsOf(makeTask([{ id: 'e', trigger: 'manual', outcome: 'running' } as never]))).toEqual([])
    expect(sessionsOf(makeTask())).toEqual([])
  })
})

describe('SessionMenu', () => {
  it('offers the composer when the card has no session and sends the edited body', async () => {
    const { host, controller } = await render(makeTask())
    await waitFor(() => host.querySelector('.dsh-atb-sess-slot') !== null)
    const slot = host.querySelector<HTMLButtonElement>('.dsh-atb-sess-slot')!
    expect(slot.dataset.empty).toBe('true')
    slot.click()
    await waitFor(() => host.querySelector('.dsh-atb-sess-text') !== null)
    const textarea = host.querySelector<HTMLTextAreaElement>('.dsh-atb-sess-text')!
    await waitFor(() => textarea.value.length > 0)
    expect(controller.openingBodyFor).toHaveBeenCalledWith('t-1')

    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setValue.call(textarea, '我改过的正文')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))

    const send = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '发送并创建会话')!
    send.click()
    await waitFor(() => (controller.startWithOpeningBody as unknown as { mock: { calls: unknown[][] } }).mock.calls.length === 1)
    expect(controller.startWithOpeningBody).toHaveBeenCalledWith('t-1', '我改过的正文')
  })

  it('copies without starting anything', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const { host, controller } = await render(makeTask())
    await waitFor(() => host.querySelector('.dsh-atb-sess-slot') !== null)
    host.querySelector<HTMLButtonElement>('.dsh-atb-sess-slot')!.click()
    await waitFor(() => host.querySelector('.dsh-atb-sess-text') !== null)
    const textarea = host.querySelector<HTMLTextAreaElement>('.dsh-atb-sess-text')!
    await waitFor(() => textarea.value.length > 0)
    const copy = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '只复制')!
    copy.click()
    expect(writeText).toHaveBeenCalledWith('标题\n\n描述')
    expect(controller.startWithOpeningBody).not.toHaveBeenCalled()
  })

  it('lists every conversation and opens one', async () => {
    const task = makeTask([execution('e1', 's-1', 10), execution('e2', 's-1', 30), execution('e3', 's-2', 20)])
    const { host, controller } = await render(task)
    await waitFor(() => host.querySelector('.dsh-atb-sess-slot') !== null)
    const slot = host.querySelector<HTMLButtonElement>('.dsh-atb-sess-slot')!
    expect(slot.textContent).toContain('s-1')
    slot.click()
    await waitFor(() => host.querySelectorAll('.dsh-atb-sess-row').length === 2)
    const rows = [...host.querySelectorAll<HTMLButtonElement>('.dsh-atb-sess-row')]
    expect(rows[0]!.textContent).toContain('2 轮')
    rows[1]!.click()
    expect(controller.openSession).toHaveBeenCalledWith('s-2')
  })
})
