import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GithubWritebackService } from '../src/host/github-writeback.ts'
import { TaskStore } from '../src/host/store.ts'
import { normalizeExternalConfig } from '../src/host/external-sync.ts'
import type { ExternalConfig } from '../src/shared/external.ts'
import type { TaskRecord, TaskStatus } from '../src/shared/protocol.ts'
import { waitFor } from './wait-for.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

function config(changes: Partial<ExternalConfig> = {}): ExternalConfig {
  return {
    id: 'c1', provider: 'github', authMode: 'token', baseUrl: 'https://api.github.com', account: 'alice',
    credentials: { token: 'private-token' }, mappings: [], itemTypes: ['issue'], intervalMinutes: 0, since: '',
    settings: {
      writebackMode: 'both', projectOwner: 'acme', projectNumber: '5', statusField: 'Status',
      statusMap: 'in_review=待你验收,done=完成',
    },
    ...changes,
  }
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 't1', title: 'Issue 7', description: '', prompt: '', workspaceId: 'ws', urgency: 'normal',
    status: 'in_progress', blocked: false, execution: { mode: 'claim' }, comments: [], executions: [],
    createdBy: { kind: 'user' }, updatedBy: { kind: 'user' }, version: 1, createdAt: 1, updatedAt: 1,
    external: {
      connectionId: 'c1', provider: 'github', providerName: 'GitHub', syncedAt: 1, conflicts: [],
      item: {
        projectId: 'acme/repo', type: 'issue', id: '7', title: 'Issue 7', description: '', urgency: 'normal',
        priority: '', status: 'open', assignedTo: '', closed: false, url: 'https://github.com/acme/repo/issues/7',
      },
    },
    ...overrides,
  }
}

async function storeWith(task: TaskRecord): Promise<TaskStore> {
  const dir = await mkdtemp(join(tmpdir(), 'writeback-'))
  directories.push(dir)
  const store = new TaskStore({ file: join(dir, 'tasks.json') })
  await store.mutate('task-created', ledger => { ledger.tasks.push(task); return [task] })
  return store
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

function graphqlMock(calls: Array<{ query: string; variables: Record<string, unknown>; headers: Headers }>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const payload = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> }
    calls.push({ query: payload.query, variables: payload.variables, headers: new Headers(init?.headers) })
    expect(url).toBe('https://api.github.com/graphql')
    if (payload.query.includes('TaskboardIssueStatus')) {
      return json({ data: { repository: { issue: { id: 'I_1', projectItems: { nodes: [{
        id: 'PVTI_1', project: { id: 'PVT_1', number: 5, owner: { login: 'acme' } },
        fieldValues: { nodes: [{ name: '执行中', field: { name: 'Status' } }] },
      }] } } } } })
    }
    if (payload.query.includes('TaskboardStatusField')) {
      return json({ data: { node: { field: { id: 'PVTSSF_1', name: 'Status', options: [{ id: 'opt_review', name: '待你验收' }, { id: 'opt_done', name: '完成' }] } } } })
    }
    if (payload.query.includes('TaskboardSetStatus')) {
      return json({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } } })
    }
    return json({ data: {} })
  }) as typeof fetch
}

describe('GitHub Project write-back', () => {
  it('updates the single-select Status field and comments on the issue', async () => {
    const store = await storeWith(task())
    const calls: Array<{ query: string; variables: Record<string, unknown>; headers: Headers }> = []
    const comments: Array<{ url: string; body: unknown }> = []
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/comments')) {
        comments.push({ url: String(input), body: JSON.parse(String(init?.body)) })
        return new Response('{}', { status: 201 })
      }
      return graphqlMock(calls)(input, init)
    }) as typeof fetch
    const service = new GithubWritebackService({ store, connection: () => config(), request, now: () => 1000 })
    await service.handleMove(store.get('t1')!, 'in_progress', 'in_review')
    expect(calls.map(call => call.query.match(/query|mutation/)?.[0])).toHaveLength(3)
    expect(calls[0]!.variables).toEqual({ owner: 'acme', name: 'repo', number: 7 })
    expect(calls[1]!.variables).toEqual({ projectId: 'PVT_1', field: 'Status' })
    expect(calls[2]!.variables).toEqual({ projectId: 'PVT_1', itemId: 'PVTI_1', fieldId: 'PVTSSF_1', optionId: 'opt_review' })
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer private-token')
    expect(comments).toHaveLength(1)
    expect(comments[0]!.url).toBe('https://api.github.com/repos/acme/repo/issues/7/comments')
    expect(String((comments[0]!.body as { body: string }).body)).toContain('看板状态：in_progress → in_review')
  })

  it('is idempotent when the Project status already matches', async () => {
    const store = await storeWith(task())
    const calls: Array<{ query: string; variables: Record<string, unknown>; headers: Headers }> = []
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { query: string }
      calls.push({ query: payload.query, variables: {}, headers: new Headers(init?.headers) })
      return json({ data: { repository: { issue: { projectItems: { nodes: [{
        id: 'PVTI_1', project: { id: 'PVT_1', number: 5, owner: { login: 'acme' } },
        fieldValues: { nodes: [{ name: '待你验收', field: { name: 'Status' } }] },
      }] } } } } })
    }) as typeof fetch
    await new GithubWritebackService({ store, connection: () => config(), request }).handleMove(store.get('t1')!, 'in_progress', 'in_review')
    expect(calls).toHaveLength(1)
  })

  it('does nothing when disabled, for non-GitHub tasks, or when no Project status maps', async () => {
    const request = vi.fn() as unknown as typeof fetch
    const store = await storeWith(task())
    const cases: Array<{ store: TaskStore; connection: () => ExternalConfig | undefined; from: TaskStatus; to: TaskStatus }> = [
      { store, connection: () => config({ settings: { writebackMode: 'off' } }), from: 'in_progress', to: 'in_review' },
      { store, connection: () => config({ provider: 'tapd' }), from: 'in_progress', to: 'in_review' },
      { store, connection: () => undefined, from: 'in_progress', to: 'in_review' },
      { store: await storeWith(task({ external: undefined })), connection: () => config(), from: 'in_progress', to: 'in_review' },
      { store, connection: () => config({ settings: { writebackMode: 'both', projectNumber: '5', statusMap: 'done=完成' } }), from: 'in_progress', to: 'archived' },
    ]
    for (const entry of cases) {
      const service = new GithubWritebackService({ store: entry.store, connection: entry.connection, request })
      await service.handleMove(entry.store.get('t1')!, entry.from, entry.to)
    }
    expect(request).not.toHaveBeenCalled()
  })

  it('records GraphQL failures as a host comment without throwing', async () => {
    const store = await storeWith(task())
    const request = (async () => json({ errors: [{ message: 'Resource not accessible by integration' }] })) as typeof fetch
    const service = new GithubWritebackService({ store, connection: () => config(), request, now: () => 2000 })
    await expect(service.handleMove(store.get('t1')!, 'in_progress', 'in_review')).resolves.toBeUndefined()
    const comment = store.get('t1')!.comments.at(-1)!
    expect(comment.threadId).toBe('host')
    expect(comment.body).toContain('GitHub 回写失败')
    expect(comment.body).toContain('Resource not accessible by integration')
  })

  it('reports a missing Project status option instead of writing', async () => {
    const store = await storeWith(task())
    const calls: string[] = []
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { query: string }
      calls.push(payload.query)
      if (payload.query.includes('TaskboardIssueStatus')) {
        return json({ data: { repository: { issue: { projectItems: { nodes: [{
          id: 'PVTI_1', project: { id: 'PVT_1', number: 5, owner: { login: 'acme' } },
          fieldValues: { nodes: [{ name: '执行中', field: { name: 'Status' } }] },
        }] } } } } })
      }
      return json({ data: { node: { field: { id: 'F1', options: [{ id: 'o1', name: '其他' }] } } } })
    }) as typeof fetch
    await new GithubWritebackService({ store, connection: () => config(), request, now: () => 3000 }).handleMove(store.get('t1')!, 'in_progress', 'in_review')
    expect(calls.some(query => query.includes('TaskboardSetStatus'))).toBe(false)
    expect(store.get('t1')!.comments.at(-1)!.body).toContain('待你验收')
  })

  it('observes status transitions committed through the store (any writer)', async () => {
    const store = await storeWith(task())
    const moves: Array<[string, string, string]> = []
    const dispose = store.onTaskMoved((_task, from, to) => moves.push(['t1', from, to]))
    await store.mutate('task-moved', ledger => {
      const next = structuredClone(ledger.tasks[0]!)
      next.status = 'in_review'
      next.version += 1
      ledger.tasks[0] = next
      return [next]
    })
    await store.mutate('task-moved', ledger => {
      const next = structuredClone(ledger.tasks[0]!)
      next.status = 'done'
      next.version += 1
      ledger.tasks[0] = next
      return [next]
    })
    dispose()
    expect(moves).toEqual([['t1', 'in_progress', 'in_review'], ['t1', 'in_review', 'done']])
  })

  it('observes a committed move and performs the write-back end-to-end', async () => {
    const store = await storeWith(task())
    const queries: string[] = []
    const comments: string[] = []
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/comments')) {
        comments.push(String((JSON.parse(String(init?.body)) as { body: string }).body))
        return new Response('{}', { status: 201 })
      }
      const payload = JSON.parse(String(init?.body)) as { query: string }
      queries.push(payload.query)
      if (payload.query.includes('TaskboardIssueStatus')) {
        return json({ data: { repository: { issue: { projectItems: { nodes: [{
          id: 'PVTI_1', project: { id: 'PVT_1', number: 5, owner: { login: 'acme' } },
          fieldValues: { nodes: [{ name: '执行中', field: { name: 'Status' } }] },
        }] } } } } })
      }
      if (payload.query.includes('TaskboardStatusField')) {
        return json({ data: { node: { field: { id: 'F1', options: [{ id: 'o1', name: '待你验收' }] } } } })
      }
      return json({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } } })
    }) as typeof fetch
    const service = new GithubWritebackService({ store, connection: () => config(), request })
    const dispose = store.onTaskMoved((moved, from, to) => service.afterMove(moved, from, to))
    await store.mutate('task-moved', ledger => {
      const next = structuredClone(ledger.tasks[0]!)
      next.status = 'in_review'
      next.version += 1
      ledger.tasks[0] = next
      return [next]
    })
    await waitFor(() => comments.length === 1)
    dispose()
    expect(queries.some(query => query.includes('TaskboardSetStatus'))).toBe(true)
    expect(comments[0]).toContain('in_progress → in_review')
  })

  it('validates write-back settings through the shared registry', () => {
    const input = {
      provider: 'github', baseUrl: 'https://api.github.com', account: 'alice', authMode: 'token',
      credentials: { token: 't' }, mappings: [{ projectId: 'acme/repo', workspaceId: 'ws' }], itemTypes: ['issue'],
      settings: { writebackMode: 'status', projectNumber: '1', statusMap: 'backlog=待澄清,todo=就绪' },
    }
    expect(normalizeExternalConfig(input).settings.projectNumber).toBe('1')
    expect(() => normalizeExternalConfig({ ...input, settings: { writebackMode: 'bogus' } })).toThrow('write-back mode')
    expect(() => normalizeExternalConfig({ ...input, settings: { writebackMode: 'status', projectNumber: '0' } })).toThrow('Project number')
    expect(() => normalizeExternalConfig({ ...input, settings: { writebackMode: 'status', projectNumber: '1', statusMap: 'unknown=待澄清' } })).toThrow('column=option')
  })
})
