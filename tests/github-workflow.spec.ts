import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExternalSyncService } from '../src/host/external-sync.ts'
import { GithubProvider } from '../src/host/github.ts'
import { GithubWritebackService } from '../src/host/github-writeback.ts'
import { TaskStore } from '../src/host/store.ts'
import { waitFor } from './wait-for.ts'

/**
 * Host-level P1 + P2 workflow: GitHub issues imported by the external-sync
 * engine become cards, and a committed board move writes Project Status and
 * an issue comment through the write-back service. All network is mocked.
 */
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

const issue = (number: number, overrides: Record<string, unknown> = {}) => ({
  number, title: `Issue ${number}`, body: `Body ${number}`, state: 'open',
  html_url: `https://github.com/acme/repo/issues/${number}`, labels: [{ name: 'bug' }],
  assignee: { login: 'alice' }, assignees: [{ login: 'alice' }], ...overrides,
})

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

describe('GitHub workflow (import → move → write-back)', () => {
  it('imports issues once, then mirrors a board move into Project Status and a comment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'github-workflow-'))
    directories.push(dir)
    const store = new TaskStore({ file: join(dir, 'tasks.json') })

    const importFetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/repos/acme/repo/issues')
      expect(url.searchParams.get('state')).toBe('all')
      return json([
        issue(7),
        issue(10),
        { ...issue(8), pull_request: { url: 'https://api.github.com/repos/acme/repo/pulls/8' } },
        issue(9, { state: 'closed' }),
      ])
    }) as typeof fetch

    const sync = new ExternalSyncService({
      file: join(dir, 'connection.json'),
      store,
      workspaceExists: id => id === 'ws',
      provider: config => new GithubProvider(config, importFetch, 0),
    })
    await sync.configure({
      provider: 'github', baseUrl: 'https://api.github.com', account: 'alice', authMode: 'token',
      credentials: { token: 'private-token' }, mappings: [{ projectId: 'acme/repo', workspaceId: 'ws' }],
      itemTypes: ['issue'], intervalMinutes: 0, since: '', importStatus: 'todo',
      settings: {
        writebackMode: 'both', projectOwner: 'acme', projectNumber: '5', statusField: 'Status',
        statusMap: 'todo=就绪,in_progress=执行中,in_review=待你验收',
      },
    })
    const result = await sync.sync()
    expect(result.created).toBe(2)
    const imported = store.snapshot().tasks
    expect(imported).toHaveLength(2)
    expect(imported.every(task => task.external?.provider === 'github' && task.status === 'todo')).toBe(true)
    expect(imported.some(task => task.title === 'Issue 8')).toBe(false)

    const gqlCalls: string[] = []
    const comments: string[] = []
    const writeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/comments')) {
        comments.push(String((JSON.parse(String(init?.body)) as { body: string }).body))
        return new Response('{}', { status: 201 })
      }
      const payload = JSON.parse(String(init?.body)) as { query: string }
      gqlCalls.push(payload.query)
      if (payload.query.includes('TaskboardIssueStatus')) {
        return json({ data: { repository: { issue: { projectItems: { nodes: [{
          id: 'PVTI_7', project: { id: 'PVT_1', number: 5, owner: { login: 'acme' } },
          fieldValues: { nodes: [{ name: '执行中', field: { name: 'Status' } }] },
        }] } } } } })
      }
      if (payload.query.includes('TaskboardStatusField')) {
        return json({ data: { node: { field: { id: 'F1', options: [{ id: 'opt_review', name: '待你验收' }] } } } })
      }
      return json({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_7' } } } })
    }) as typeof fetch
    const writeback = new GithubWritebackService({ store, connection: () => sync.hostConnection(), request: writeFetch })
    const dispose = store.onTaskMoved((task, from, to) => writeback.afterMove(task, from, to))

    const taskId = imported[0]!.id
    const move = (status: string) => store.mutate('task-moved', ledger => {
      const fresh = ledger.tasks.find(task => task.id === taskId)!
      const next = structuredClone(fresh)
      next.status = status as typeof next.status
      next.version += 1
      ledger.tasks[ledger.tasks.findIndex(task => task.id === taskId)] = next
      return [next]
    })

    // todo → in_progress: the Project already shows 执行中, so no write.
    await move('in_progress')
    await waitFor(() => gqlCalls.length >= 1)
    expect(gqlCalls.filter(query => query.includes('TaskboardSetStatus'))).toHaveLength(0)
    expect(comments).toHaveLength(0)

    // in_progress → in_review: Project Status + issue comment.
    await move('in_review')
    await waitFor(() => comments.length === 1)
    expect(gqlCalls.some(query => query.includes('TaskboardSetStatus'))).toBe(true)
    expect(comments[0]).toContain('in_progress → in_review')
    dispose()
    writeback.dispose()
    sync.dispose()
  })
})
