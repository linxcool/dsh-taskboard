/**
 * The opening user message of a task execution.
 *
 * An execution submits TWO messages: the plugin framing line (task id, handoff
 * protocol, acceptance checklist, isolation notes — injected by the host and
 * never editable) and this user body. The body is what a human may preview and
 * edit before an execution starts, so it lives in `shared/` where both the
 * runner and the preview route use the same function.
 */
import { describe, expect, it } from 'vitest'
import { emptyLedger, openingBody, type TaskRecord } from '../src/shared/protocol.ts'

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 't-open-1',
    title: '标题',
    description: '描述',
    prompt: '提示',
    workspaceId: 'ws-a',
    urgency: 'normal',
    status: 'todo',
    blocked: false,
    execution: { mode: 'claim' },
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    createdBy: { kind: 'user' },
    updatedBy: { kind: 'user' },
    comments: [],
    executions: [],
    ...overrides,
  } as TaskRecord
}

describe('openingBody', () => {
  it('renders title, description and prompt in order', () => {
    expect(openingBody(makeTask())).toBe('标题\n\n描述\n\n提示')
  })

  it('drops the missing sections instead of leaving blank blocks', () => {
    expect(openingBody(makeTask({ description: '', prompt: '' }))).toBe('标题')
    expect(openingBody(makeTask({ prompt: '' }))).toBe('标题\n\n描述')
  })

  it('resolves the history placeholders', () => {
    const task = makeTask({
      prompt: '上一轮：{{lastExecution}}\n评论：{{lastComments}}',
      comments: [
        { id: 'c1', body: '第一条', version: 1, createdAt: 1 },
        { id: 'c2', body: '第二条', version: 1, createdAt: 2, threadId: 'th-1' },
      ] as TaskRecord['comments'],
      executions: [
        { id: 'e1', trigger: 'manual', outcome: 'succeeded', startedAt: 1_000, endedAt: 2_000 },
      ] as TaskRecord['executions'],
    })
    const text = openingBody(task)
    expect(text).not.toContain('{{lastExecution}}')
    expect(text).not.toContain('{{lastComments}}')
    expect(text).toContain('manual · succeeded')
    expect(text).toContain('[user] 第一条')
    expect(text).toContain('[agent] 第二条')
  })

  it('never includes the plugin framing line', () => {
    const text = openingBody(makeTask())
    expect(text).not.toContain('【任务看板】')
    expect(text).not.toContain('taskboard_execution_report')
  })

  it('does not mutate the task', () => {
    const task = makeTask({ prompt: '{{lastComments}}' })
    const before = JSON.stringify(task)
    openingBody(task)
    expect(JSON.stringify(task)).toBe(before)
    expect(emptyLedger().tasks).toEqual([])
  })
})
