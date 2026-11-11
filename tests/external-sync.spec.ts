import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExternalSyncService } from '../src/host/external-sync.ts'
import { TaskStore } from '../src/host/store.ts'
import { externalKey, mergeExternalFields, normalizeExternalSource, type ExternalItem, type ExternalSource } from '../src/shared/external.ts'
import { ZentaoProvider, trackerText } from '../src/host/zentao.ts'
import { validateLedgerImport } from '../src/shared/protocol.ts'

const item: ExternalItem = { projectId: 'project:1', type: 'bug', id: '999999999999999999', title: 'Bug', description: 'Steps', urgency: 'normal', priority: '2', url: 'https://zentao.test/bug', assignedTo: 'alice', closed: false, status: 'active' }
const source: ExternalSource = { connectionId: 'c', provider: 'zentao', syncedAt: 1, item, conflicts: [] }
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true }))) })

/** Switch the fixture to a GitHub connection accepting `issue` items. */
async function configureGithub(f: { service: { configure: (body: unknown) => Promise<void> } }) {
  await f.service.configure({
    provider: 'github', baseUrl: 'https://api.github.com', authMode: 'token', account: 'alice',
    credentials: { token: 'private-token' },
    settings: { projectOwner: 'acme', projectNumber: '1' },
    mappings: [{ projectId: 'acme/repo', workspaceId: 'ws' }],
  } as never)
}

describe('external merge', () => {
  it('scopes identities by connection, project and type', () => {
    expect(externalKey('a', item)).not.toBe(externalKey('b', item))
    expect(externalKey('a', item)).not.toBe(externalKey('a', { ...item, type: 'task' }))
    expect(externalKey('a', item)).not.toBe(externalKey('a', { ...item, projectId: '2' }))
  })
  it('updates untouched fields and preserves conflicting local edits', () => {
    const remote = { ...item, title: 'Remote', description: 'New steps' }
    expect(mergeExternalFields(item, source, remote, false).fields.title).toBe('Remote')
    const result = mergeExternalFields({ ...item, title: 'Local' }, source, remote, false)
    expect(result.fields).toMatchObject({ title: 'Local', description: 'New steps' })
    expect(result.conflicts).toEqual(['title'])
    expect(mergeExternalFields(result.fields, { ...source, item: remote, conflicts: result.conflicts }, remote, false).conflicts).toEqual(['title'])
  })
  it('freezes execution context and rejects unsafe provenance links', () => {
    expect(mergeExternalFields(item, source, { ...item, title: 'Changed' }, true).fields.title).toBe('Bug')
    expect(normalizeExternalSource({ ...source, item: { ...item, url: 'javascript:alert(1)' } })).toBeUndefined()
    expect(normalizeExternalSource({ ...source, token: 'private-external-token' })).not.toHaveProperty('token')
  })
})

describe('sync service', () => {
  async function fixture(now: () => number = () => 100) {
    const dir = await mkdtemp(join(tmpdir(), 'taskboard-external-')); directories.push(dir)
    const store = new TaskStore({ file: join(dir, 'tasks.json') })
    let items = [structuredClone(item)]
    let fail = false
    const service = new ExternalSyncService({ file: join(dir, 'connection.json'), store, workspaceExists: id => id === 'ws',
      provider: () => ({ test: async () => {}, getItems: async () => { if (fail) throw new Error('private-external-token'); return items } }), now })
    await service.configure({ mappingMode: 'project', baseUrl: 'https://zentao.test', account: 'alice', credentials: { username: 'alice', password: 'private-external-token' }, mappings: [{ projectId: 'project:1', workspaceId: 'ws' }] })
    return { service, store, set: (v: ExternalItem[]) => { items = v }, fail: () => { fail = true } }
  }
  it('imports into todo only for new tasks and rejects unsupported destinations', async () => {
    const f = await fixture()
    await f.service.sync()
    const config = (await f.service.status()).config!
    await expect(f.service.configure({ ...config, importStatus: 'done', credentials: {} })).rejects.toThrow('import status')
    await f.service.configure({ ...config, importStatus: 'todo', credentials: {} })
    f.set([item, { ...item, id: 'another' }])
    await f.service.sync()
    expect(f.store.snapshot().tasks.map(t => t.status)).toEqual(['backlog', 'todo'])
    expect(f.store.snapshot().tasks[1]!.execution.mode).toBe('claim')
    expect((await f.service.status()).config!.importStatus).toBe('todo')
    f.service.dispose()
  })
  it('imports unassigned items but still skips ones assigned to someone else', async () => {
    const f = await fixture()
    f.set([
      { ...item, id: 'no-assignee', assignedTo: '', assignees: [] },
      { ...item, id: 'someone-else', assignedTo: 'bob', assignees: ['bob'] },
      { ...item, id: 'mine', assignedTo: 'alice', assignees: ['alice'] },
    ])
    const result = await f.service.sync()
    expect(result.created).toBe(2)
    expect(f.store.snapshot().tasks.map(t => t.external?.item.id).sort()).toEqual(['mine', 'no-assignee'])
    f.service.dispose()
  })
  it('keeps epics out of the board and records them as filter facets', async () => {
    const f = await fixture()
    f.set([
      { ...item, id: '16', childCount: 2 },
      { ...item, id: '5', parentNumber: 16, childCount: 1 },
      { ...item, id: '8', parentNumber: 5 },
    ])
    const result = await f.service.sync()
    // The epic is a facet, not a card; the other two are cards.
    expect(result.created).toBe(2)
    expect(f.store.snapshot().tasks.map(task => task.external!.item.id).sort()).toEqual(['5', '8'])
    const config = (await f.service.status()).config!
    const epics = f.store.snapshot().externalSync?.[config.id]?.epics
    expect(epics).toEqual([{ key: expect.any(String), repo: 'project:1', number: 16, title: 'Bug', children: 2 }])
    f.service.dispose()
  })

  it('archives a card when its issue closes, with a host comment', async () => {
    const f = await fixture()
    await configureGithub(f)
    f.set([{ ...item, type: 'issue', projectId: 'acme/repo' }])
    await f.service.sync()
    const id = f.store.snapshot().tasks[0]!.id
    f.set([{ ...item, type: 'issue', projectId: 'acme/repo', closed: true, status: 'closed' }])
    const result = await f.service.sync()
    expect(result.updated).toBe(1)
    const task = f.store.get(id)!
    expect(task.status).toBe('archived')
    expect(task.comments.at(-1)).toMatchObject({ threadId: 'host' })
    expect(task.comments.at(-1)!.body).toContain('已关闭')
    f.service.dispose()
  })

  it('leaves an in-flight card alone when the issue closes, and archives it later', async () => {
    const f = await fixture()
    await configureGithub(f)
    f.set([{ ...item, type: 'issue', projectId: 'acme/repo' }])
    await f.service.sync()
    const id = f.store.snapshot().tasks[0]!.id
    await f.store.mutate('task-moved', ledger => {
      const task = ledger.tasks.find(candidate => candidate.id === id)!
      task.status = 'in_progress'
      task.claimedBy = 'session-live'
      return [task]
    })
    f.set([{ ...item, type: 'issue', projectId: 'acme/repo', closed: true, status: 'closed' }])
    await f.service.sync()
    expect(f.store.get(id)!.status).toBe('in_progress')

    await f.store.mutate('task-moved', ledger => {
      const task = ledger.tasks.find(candidate => candidate.id === id)!
      delete task.claimedBy
      task.status = 'todo'
      return [task]
    })
    await f.service.sync()
    expect(f.store.get(id)!.status).toBe('archived')
    f.service.dispose()
  })

  it('archives an existing card that became an epic', async () => {
    const f = await fixture()
    await f.service.sync()
    const id = f.store.snapshot().tasks[0]!.id
    f.set([{ ...item, childCount: 3 }])
    const result = await f.service.sync()
    expect(result.updated).toBe(1)
    const task = f.store.get(id)!
    expect(task.status).toBe('archived')
    expect(task.comments.at(-1)!.body).toContain('父任务')
    f.service.dispose()
  })

  it('creates a GitHub issue for a board-created task in a mapped workspace', async () => {
    const f = await fixture()
    await configureGithub(f)
    const urls: string[] = []
    const response = (data: unknown, status = 200): Response =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
    vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      urls.push(url)
      if (url.endsWith('/repos/acme/repo/issues')) {
        return response({ number: 42, html_url: 'https://github.com/acme/repo/issues/42', node_id: 'ISSUE_42' }, 201)
      }
      if (url.endsWith('/graphql')) {
        const query = String(init?.body ?? '')
        if (query.includes('addProjectV2ItemById')) return response({ data: { addProjectV2ItemById: { item: { id: 'PVTI_1' } } } })
        if (query.includes('updateProjectV2ItemFieldValue')) return response({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } } })
        return response({ data: { repositoryOwner: { projectV2: { id: 'P', field: { id: 'F', options: [{ id: 'O', name: '待澄清' }] } } } } })
      }
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch)

    const created = await f.service.createForTask('ws', { title: '新卡', description: '正文', status: 'backlog' })
    expect(created).toMatchObject({
      repo: 'acme/repo',
      number: 42,
      url: 'https://github.com/acme/repo/issues/42',
      projectStatus: '待澄清',
    })
    expect(urls.some(url => url.endsWith('/repos/acme/repo/issues'))).toBe(true)
    vi.unstubAllGlobals()
    f.service.dispose()
  })

  it('creates nothing when the connection is not GitHub or the workspace is unmapped', async () => {
    const f = await fixture()
    expect(await f.service.createForTask('ws', { title: 't', description: '', status: 'backlog' })).toBeUndefined()
    await configureGithub(f)
    expect(await f.service.createForTask('other-ws', { title: 't', description: '', status: 'backlog' })).toBeUndefined()
    f.service.dispose()
  })

  it('maps the project status onto the board column for new cards', async () => {
    const f = await fixture()
    await f.service.configure({
      provider: 'github', baseUrl: 'https://api.github.com', authMode: 'token', account: 'alice',
      credentials: { token: 'private-token' },
      settings: { statusMap: 'backlog=待澄清,todo=就绪,in_progress=执行中,in_review=待你验收,done=完成,canceled=取消' },
      mappings: [{ projectId: 'acme/repo', workspaceId: 'ws' }],
    } as never)
    f.set([
      { ...item, projectId: 'acme/repo', type: 'issue', id: '1', projectStatus: '执行中' },
      { ...item, projectId: 'acme/repo', type: 'issue', id: '2', projectStatus: '待你验收' },
      { ...item, projectId: 'acme/repo', type: 'issue', id: '3' },
      // An option the board does not model falls back to the import column.
      { ...item, projectId: 'acme/repo', type: 'issue', id: '4', projectStatus: '待合并' },
    ])
    await f.service.sync()
    const byExt = new Map(f.store.snapshot().tasks.map(task => [task.external!.item.id, task.status]))
    expect(byExt.get('1')).toBe('in_progress')
    expect(byExt.get('2')).toBe('in_review')
    expect(byExt.get('3')).toBe('backlog')
    expect(byExt.get('4')).toBe('backlog')
    f.service.dispose()
  })

  it('adopts the tracker status only for cards still sitting in the import column', async () => {
    const f = await fixture()
    await f.service.configure({
      provider: 'github', baseUrl: 'https://api.github.com', authMode: 'token', account: 'alice',
      credentials: { token: 'private-token' },
      settings: { statusMap: 'backlog=待澄清,todo=就绪,in_progress=执行中,in_review=待你验收,done=完成,canceled=取消' },
      mappings: [{ projectId: 'acme/repo', workspaceId: 'ws' }],
    } as never)
    f.set([
      { ...item, projectId: 'acme/repo', type: 'issue', id: '1', assignedTo: 'alice' },
      { ...item, projectId: 'acme/repo', type: 'issue', id: '2', assignedTo: 'alice' },
    ])
    await f.service.sync()
    expect(f.store.snapshot().tasks.map(task => task.status)).toEqual(['backlog', 'backlog'])

    // One card gets triaged locally; the other stays untouched.
    const [first, second] = f.store.snapshot().tasks
    await f.store.mutate('task-moved', ledger => {
      const target = ledger.tasks.find(task => task.id === first!.id)!
      target.status = 'todo'
      return [target]
    })
    f.set([
      { ...item, projectId: 'acme/repo', type: 'issue', id: '1', assignedTo: 'alice', projectStatus: '执行中' },
      { ...item, projectId: 'acme/repo', type: 'issue', id: '2', assignedTo: 'alice', projectStatus: '待你验收' },
    ])
    await f.service.sync()
    const statusById = new Map(f.store.snapshot().tasks.map(task => [task.id, task.status]))
    // Triage wins over the remote status…
    expect(statusById.get(first!.id)).toBe('todo')
    // …an untouched card follows the tracker.
    expect(statusById.get(second!.id)).toBe('in_review')
    f.service.dispose()
  })

  it('is idempotent and creates non-executing backlog tasks', async () => {
    const f = await fixture()
    expect((await f.service.sync()).created).toBe(1)
    const before = f.store.snapshot()
    expect(before.tasks[0]).toMatchObject({ status: 'backlog', execution: { mode: 'claim' } })
    expect((await f.service.sync()).unchanged).toBe(1)
    expect(f.store.snapshot().tasks).toEqual(before.tasks)
    expect(JSON.stringify(await f.service.status())).not.toContain('private-external-token')
    const restored = validateLedgerImport(JSON.parse(JSON.stringify(before)), new Set(), 200)
    expect(restored.create[0]!.external).toEqual(before.tasks[0]!.external)
  })
  it('keeps local state, comments and claims when the external bug closes', async () => {
    const f = await fixture(); await f.service.sync()
    await f.store.mutate('task-updated', ledger => { const t = ledger.tasks[0]!; t.status = 'in_progress'; t.claimedBy = 'session'; return [t] })
    f.set([{ ...item, title: 'New title', status: 'closed', closed: true, assignedTo: 'bob' }])
    await f.service.sync()
    expect(f.store.snapshot().tasks[0]).toMatchObject({ title: 'Bug', status: 'in_progress', claimedBy: 'session', external: { conflicts: ['title'], item: { status: 'closed' } } })
  })
  it('does not commit incomplete scans and redacts server failures', async () => {
    const f = await fixture(); f.fail()
    await expect(f.service.sync()).rejects.toThrow('External sync failed')
    expect(f.store.snapshot().tasks).toEqual([])
    expect(JSON.stringify(await f.service.status())).not.toContain('private-external-token')
  })
  it('rejects provider scope/type violations before committing any item in the scan', async () => {
    const f = await fixture(); await f.service.sync()
    const snapshot = f.store.snapshot()
    f.set([{ ...item, title: 'Changed' }, { ...item, id: '2', projectId: 'another-project' }])
    await expect(f.service.sync()).rejects.toThrow('External sync failed')
    expect(f.store.snapshot().tasks).toEqual(snapshot.tasks)
    f.set([{ ...item, type: 'unsupported-type' }])
    await expect(f.service.sync()).rejects.toThrow('External sync failed')
    expect(f.store.snapshot().tasks).toEqual(snapshot.tasks)
  })
  it('persists deletion suppression', async () => {
    const f = await fixture(); await f.service.sync()
    await f.store.mutate('task-updated', ledger => { ledger.tasks[0]!.trashedAt = 1; return [ledger.tasks[0]!] })
    expect((await f.service.sync()).ignored).toBe(1)
    await f.store.mutate('task-deleted', ledger => { ledger.tasks = []; return [] })
    expect((await f.service.sync()).created).toBe(0)
    await f.service.clearIgnored()
    expect((await f.service.sync()).created).toBe(1)
  })
  it('suppresses a task purged between sync rounds', async () => {
    const f = await fixture(); await f.service.sync()
    await f.store.mutate('task-deleted', ledger => { ledger.tasks = []; return [] })
    expect((await f.service.sync()).ignored).toBe(1)
    expect(f.store.snapshot().tasks).toEqual([])
  })
  it('resolves conflicts with optimistic version checks', async () => {
    const f = await fixture(); await f.service.sync()
    await f.store.mutate('task-updated', ledger => { ledger.tasks[0]!.title = 'Local'; return [ledger.tasks[0]!] })
    f.set([{ ...item, title: 'Remote' }]); await f.service.sync()
    const task = f.store.snapshot().tasks[0]!
    await expect(f.service.resolve(task.id, 'title', true, task.version - 1)).rejects.toThrow('task changed')
    await f.service.resolve(task.id, 'title', false, task.version)
    expect((await f.service.sync()).unchanged).toBe(1)
    expect(f.store.snapshot().tasks[0]!.title).toBe('Local')
    expect(f.store.snapshot().tasks[0]!.external!.conflicts).toEqual([])
  })
  it('restores credentials and exclusions without leaking tokens', async () => {
    const f = await fixture(); await f.service.sync()
    const status = await f.service.status()
    await f.service.configure({ ...status.config, credentials: {}, intervalMinutes: 5 })
    expect(await f.service.status()).toMatchObject({ credentialPresent: { password: true }, config: { intervalMinutes: 5 } })
    await expect(f.service.configure({ ...status.config, baseUrl: 'https://other.test', token: '' })).rejects.toThrow('enter credentials')
  })
  it('runs host polling and stops on disposal', async () => {
    vi.useFakeTimers()
    let service: ExternalSyncService | undefined
    try {
      const f = await fixture(() => Date.now()); service = f.service
      const saved = await service.status()
      await service.configure({ ...saved.config, credentials: {}, intervalMinutes: 5 })
      const sync = vi.spyOn(service, 'sync').mockResolvedValue({ created: 0, updated: 0, unchanged: 0, conflicts: 0, ignored: 0, at: 0 })
      service.start(); service.start()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(sync).toHaveBeenCalledTimes(1)
      service.dispose()
      await vi.advanceTimersByTimeAsync(600_000)
      expect(sync).toHaveBeenCalledTimes(1)
    } finally { service?.dispose(); vi.useRealTimers() }
  })
  it('rejects overlapping sync/config writes and cancels outstanding requests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taskboard-external-concurrent-')); directories.push(dir)
    const store = new TaskStore({ file: join(dir, 'tasks.json') })
    let started!: () => void
    const pending = new Promise<void>(resolve => { started = resolve })
    const service = new ExternalSyncService({ file: join(dir, 'connection.json'), store, workspaceExists: () => true,
      provider: () => ({ test: async () => {}, getItems: async (_id, signal) => {
        started()
        return new Promise<ExternalItem[]>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      } }) })
    await service.configure({ mappingMode: 'project', baseUrl: 'https://zentao.test', account: 'alice', credentials: { username: 'alice', password: 'private-external-token' }, mappings: [{ projectId: 'project:1', workspaceId: 'ws' }] })
    const running = service.sync()
    const rejection = expect(running).rejects.toThrow('External sync failed')
    await pending
    await expect(service.sync()).rejects.toThrow('already running')
    await expect(service.configure({})).rejects.toThrow('sync is running')
    service.cancel(); await rejection
    expect(store.snapshot().tasks).toEqual([])
    service.dispose()
  })
})

describe('ZenTao provider', () => {
  it('strips active HTML content', () => {
    expect(trackerText('<p>Steps<br>next</p><script>secret()</script>')).toBe('Steps\nnext')
  })
  it('fetches every page and preserves opaque IDs', async () => {
    const urls: string[] = []
    const mock = (async (url: string | URL | Request) => {
      if (String(url).endsWith('/tokens')) return new Response(JSON.stringify({ token: 'generated-private-token' }))
      urls.push(String(url))
      return new Response(JSON.stringify({ total: 2, bugs: [{ id: urls.length === 1 ? item.id : '2', title: 'Bug', status: 'active', assignedTo: { account: 'alice' }, pri: 1, steps: '<p>steps</p>' }] }))
    }) as typeof fetch
    const provider = new ZentaoProvider({ id: 'c', provider: 'zentao', mappingMode: 'project', baseUrl: 'https://zentao.test', account: 'alice', authMode: 'password', credentials: { username: 'alice', password: 'private-external-token' }, settings: {}, itemTypes: ['bug'], mappings: [], intervalMinutes: 0, since: '' }, mock)
    const items = await provider.getItems('project:1', AbortSignal.timeout(1000))
    expect(items).toHaveLength(2); expect(items[0]!.id).toBe(item.id)
    expect(urls[1]).toContain('page=2')
    expect(items[0]).toMatchObject({ urgency: 'urgent', description: 'steps', assignedTo: 'alice' })
  })
})
