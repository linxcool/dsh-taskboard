import { describe, expect, it } from 'vitest'
import { filterTasks } from '../src/client/board/TaskBoard.tsx'
import type { ControllerState } from '../src/client/controller.ts'
import type { ExternalSource } from '../src/shared/external.ts'
import type { TaskRecord } from '../src/shared/protocol.ts'

const external: ExternalSource = {
  connectionId: 'c1', provider: 'github', providerName: 'GitHub', syncedAt: 1, conflicts: [],
  item: {
    projectId: 'acme/repo', type: 'issue', id: '7', title: 'Issue 7', description: '', urgency: 'normal',
    priority: '', status: 'open', assignedTo: '', closed: false, url: 'https://github.com/acme/repo/issues/7',
  },
}

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id, title: id, description: '', prompt: '', workspaceId: 'ws', urgency: 'normal', status: 'todo', blocked: false,
    execution: { mode: 'claim' }, comments: [], executions: [], createdBy: { kind: 'user' }, updatedBy: { kind: 'user' },
    version: 1, createdAt: 1, updatedAt: 1, ...overrides,
  }
}

function state(filters: ControllerState['filters']): ControllerState {
  return { search: '', filters, sortBy: 'default' } as unknown as ControllerState
}

describe('external tracker filter', () => {
  it('keeps only cards imported from an external tracker when enabled', () => {
    const tasks = [task('local'), task('issue-7', { external }), task('issue-8', { external: { ...external, item: { ...external.item, id: '8' } } })]
    expect(filterTasks(state({ urgencies: [], externalOnly: true }), tasks).map(t => t.id)).toEqual(['issue-7', 'issue-8'])
    expect(filterTasks(state({ urgencies: [] }), tasks)).toHaveLength(3)
    expect(filterTasks(state({ urgencies: [], externalOnly: false }), tasks)).toHaveLength(3)
  })

  it('combines the external filter with urgency chips and search', () => {
    const tasks = [
      task('issue-urgent', { urgency: 'urgent', external }),
      task('issue-normal', { external: { ...external, item: { ...external.item, id: '9' } } }),
      task('local-urgent', { urgency: 'urgent' }),
    ]
    expect(filterTasks(state({ urgencies: ['urgent'], externalOnly: true }), tasks).map(t => t.id)).toEqual(['issue-urgent'])
    expect(filterTasks({ ...state({ urgencies: [], externalOnly: true }), search: 'normal' }, tasks).map(t => t.id)).toEqual(['issue-normal'])
  })
})
