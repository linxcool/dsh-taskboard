import { describe, expect, it } from 'vitest'
import { GithubProvider } from '../src/host/github.ts'
import { normalizeExternalConfig } from '../src/host/external-sync.ts'
import type { ExternalConfig, ExternalItem } from '../src/shared/external.ts'

function config(changes: Partial<ExternalConfig> = {}): ExternalConfig {
  return {
    id: 'connection', provider: 'github', authMode: 'token', baseUrl: 'https://api.github.com', account: 'alice',
    credentials: { token: 'private-token' }, settings: {}, mappings: [{ projectId: 'acme/repo', workspaceId: 'ws' }],
    itemTypes: ['issue'], intervalMinutes: 0, since: '', ...changes,
  }
}

function issue(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number, title: `Issue ${number}`, body: 'Body text', state: 'open', html_url: `https://github.com/acme/repo/issues/${number}`,
    labels: [{ name: 'bug' }], assignee: { login: 'alice' }, assignees: [{ login: 'alice' }, { login: 'bob' }], ...overrides,
  }
}

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('GitHub provider', () => {
  it('normalizes issues, skips pull requests, maps labels/assignees and sends token auth', async () => {
    const calls: Array<{ url: URL; headers: Headers }> = []
    const mock = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({ url, headers: new Headers(init?.headers) })
      return response([issue(7, { labels: [{ name: 'urgent' }, { name: 'bug' }] }), { ...issue(8), pull_request: { url: 'x' } }])
    }) as typeof fetch
    const items = await new GithubProvider(config(), mock, 0).getItems('acme/repo', AbortSignal.timeout(1000))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      projectId: 'acme/repo', type: 'issue', id: '7', title: 'Issue 7', description: 'Body text',
      urgency: 'urgent', assignedTo: 'alice', assignees: ['alice', 'bob'],
      status: 'open', closed: false, url: 'https://github.com/acme/repo/issues/7',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer private-token')
    expect(calls[0]!.headers.get('x-github-api-version')).toBe('2022-11-28')
    expect(calls[0]!.url.pathname).toBe('/repos/acme/repo/issues')
    expect(calls[0]!.url.searchParams.get('state')).toBe('all')
    expect(calls[0]!.url.searchParams.get('page')).toBe('1')
    expect(calls[0]!.url.href).not.toContain('private-token')
  })

  it('attaches the Project Status option when a board is configured', async () => {
    const paths: string[] = []
    const mock = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      paths.push(url.pathname)
      if (url.pathname === '/graphql') {
        expect(String(init?.body)).toContain('ProjectV2ItemFieldSingleSelectValue')
        // repositoryOwner has no projectV2 field: the selection MUST go through
        // the ProjectV2Owner fragment or the whole query is invalid.
        expect(String(init?.body)).toContain('... on ProjectV2Owner')
        // GraphQL rejects declared-but-unused variables: filtering by field name
        // happens locally, so the query must not declare $field.
        expect(String(init?.body)).not.toContain('$field')
        return response({
          data: {
            repositoryOwner: {
              projectV2: {
                items: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    { content: { number: 7, repository: { nameWithOwner: 'acme/repo' } }, fieldValues: { nodes: [{ name: '执行中', field: { name: 'Status' } }] } },
                    // Same issue number in ANOTHER repository: its status must not leak.
                    { content: { number: 7, repository: { nameWithOwner: 'other/repo' } }, fieldValues: { nodes: [{ name: '完成', field: { name: 'Status' } }] } },
                    { content: { number: 8, repository: { nameWithOwner: 'acme/repo' } }, fieldValues: { nodes: [{ name: '待澄清', field: { name: 'Status' } }] } },
                    { content: { number: 9, repository: { nameWithOwner: 'acme/repo' } }, fieldValues: { nodes: [] } },
                  ],
                },
              },
            },
          },
        })
      }
      return response([issue(7), issue(8), issue(9)])
    }) as typeof fetch
    const items = await new GithubProvider(
      config({ settings: { projectOwner: 'acme', projectNumber: '1', statusField: 'Status' } }),
      mock,
      0,
    ).getItems('acme/repo', AbortSignal.timeout(1000))
    expect(paths).toContain('/graphql')
    expect(items.map(item => item.projectStatus)).toEqual(['执行中', '待澄清', undefined])
  })

  it('omits the project status when no board is configured or the query fails', async () => {
    const noProject = await new GithubProvider(config(), (async () => response([issue(7)])) as unknown as typeof fetch, 0)
      .getItems('acme/repo', AbortSignal.timeout(1000))
    expect(noProject[0]!.projectStatus).toBeUndefined()

    const failing = (async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (url.pathname === '/graphql') return response({ errors: [{ message: 'no scope' }] })
      return response([issue(7)])
    }) as typeof fetch
    const degraded = await new GithubProvider(
      config({ settings: { projectOwner: 'acme', projectNumber: '1' } }),
      failing,
      0,
    ).getItems('acme/repo', AbortSignal.timeout(1000))
    // A token without the project scope must not break issue import.
    expect(degraded).toHaveLength(1)
    expect(degraded[0]!.projectStatus).toBeUndefined()
  })

  it('paginates beyond a full page and stops on a short page', async () => {
    const calls: URL[] = []
    const mock = (async (input: string | URL | Request) => {
      const url = new URL(String(input))
      calls.push(url)
      const page = Number(url.searchParams.get('page'))
      if (page === 1) return response(Array.from({ length: 100 }, (_, index) => issue(index + 1)))
      return response([issue(101)])
    }) as typeof fetch
    const items = await new GithubProvider(config(), mock, 0).getItems('acme/repo', AbortSignal.timeout(1000))
    expect(items).toHaveLength(101)
    expect(calls.map(call => call.searchParams.get('page'))).toEqual(['1', '2'])
  })

  it('skips new closed issues but keeps tracking closed issues already on the board', async () => {
    const mock = (async () => response([issue(3, { state: 'closed' }), issue(4, { state: 'closed' })])) as typeof fetch
    const provider = new GithubProvider(config(), mock, 0)
    const none = await provider.getItems('acme/repo', AbortSignal.timeout(1000), { existing: new Map() })
    expect(none).toHaveLength(0)
    const tracked: ExternalItem = { projectId: 'acme/repo', type: 'issue', id: '3', title: 'Issue 3', description: '',
      urgency: 'normal', priority: '', status: 'closed', assignedTo: '', closed: true, url: 'https://github.com/acme/repo/issues/3' }
    const existing = new Map([[JSON.stringify(['issue', '3']), { item: tracked, metadataOnly: false }]])
    const items = await provider.getItems('acme/repo', AbortSignal.timeout(1000), { existing })
    expect(items.map(item => item.id)).toEqual(['3'])
    expect(items[0]!.closed).toBe(true)
  })

  it('passes the since filter and rejects malformed dates', async () => {
    const calls: URL[] = []
    const mock = (async (input: string | URL | Request) => {
      calls.push(new URL(String(input)))
      return response([])
    }) as typeof fetch
    await new GithubProvider(config({ since: '2026-10-01' }), mock, 0).getItems('acme/repo', AbortSignal.timeout(1000))
    expect(calls[0]!.searchParams.get('since')).toBe('2026-10-01T00:00:00Z')
    await expect(new GithubProvider(config({ since: '10/01/2026' }), mock, 0).getItems('acme/repo', AbortSignal.timeout(1000))).rejects.toThrow('since date')
  })

  it('tests the account and mapped repositories, discovers repos and identifies the account', async () => {
    const mock = (async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (url.pathname === '/user') return response({ login: 'alice', name: 'Alice' })
      if (url.pathname === '/user/repos') {
        const page = Number(url.searchParams.get('page'))
        return response(page === 1 ? Array.from({ length: 100 }, (_, index) => ({ full_name: `acme/repo-${index}` })) : [{ full_name: 'acme/repo' }])
      }
      if (url.pathname === '/repos/acme/repo') return response({ full_name: 'acme/repo' })
      return response({}, 404)
    }) as typeof fetch
    const provider = new GithubProvider(config(), mock, 0)
    await expect(provider.test(AbortSignal.timeout(1000))).resolves.toBeUndefined()
    expect(await provider.getAccount(AbortSignal.timeout(1000))).toEqual({ account: 'alice', name: 'Alice' })
    const projects = await provider.listProjects(AbortSignal.timeout(1000))
    expect(projects).toHaveLength(101)
    expect(projects.at(-1)).toEqual({ id: 'acme/repo', name: 'acme/repo' })
  })

  it('reads one issue by number and treats pull requests as unknown items', async () => {
    const item = (async (input: string | URL | Request) => {
      expect(new URL(String(input)).pathname).toBe('/repos/acme/repo/issues/9')
      return response(issue(9))
    }) as typeof fetch
    const provider = new GithubProvider(config(), item, 0)
    expect(await provider.getItem('acme/repo', 'issue', '9', AbortSignal.timeout(1000))).toMatchObject({ id: '9', type: 'issue' })
    await expect(provider.getItem('acme/repo', 'issue', 'not-a-number', AbortSignal.timeout(1000))).rejects.toThrow('invalid GitHub issue ID')
    await expect(provider.getItem('acme/repo', 'bug', '9', AbortSignal.timeout(1000))).rejects.toThrow('unsupported GitHub work item')
    const pullRequest = (async () => response({ ...issue(9), pull_request: {} })) as typeof fetch
    expect(await new GithubProvider(config(), pullRequest, 0).getItem('acme/repo', 'issue', '9', AbortSignal.timeout(1000))).toBeUndefined()
  })

  it('rejects malformed payloads and HTTP failures without leaking the token', async () => {
    const bad = (data: unknown) => (async () => response(data)) as typeof fetch
    const provider = (mock: typeof fetch) => new GithubProvider(config(), mock, 0)
    await expect(provider(bad({ not: 'an array' })).getItems('acme/repo', AbortSignal.timeout(1000))).rejects.toThrow('invalid GitHub issue list')
    await expect(provider(bad([issue(1, { title: '' })])).getItems('acme/repo', AbortSignal.timeout(1000))).rejects.toThrow('invalid GitHub issue title')
    await expect(provider(bad([issue(1.5)])).getItems('acme/repo', AbortSignal.timeout(1000))).rejects.toThrow('invalid GitHub issue number')
    await expect(provider(bad([issue(1, { state: 'merged' })])).getItems('acme/repo', AbortSignal.timeout(1000))).rejects.toThrow('invalid GitHub issue state')
    await expect(provider(bad([issue(1, { html_url: 'javascript:alert(1)' })])).getItems('acme/repo', AbortSignal.timeout(1000))).rejects.toThrow('invalid GitHub issue URL')
    await expect(provider(bad([issue(1, { labels: 'bug' })])).getItems('acme/repo', AbortSignal.timeout(1000))).rejects.toThrow('invalid GitHub issue labels')
    await expect(provider(bad([issue(1, { assignees: [{ login: 7 }] })])).getItems('acme/repo', AbortSignal.timeout(1000))).rejects.toThrow('invalid GitHub issue assignee')
    const failure = (async () => response({ message: 'Bad credentials' }, 401)) as typeof fetch
    await expect(provider(failure).test(AbortSignal.timeout(1000))).rejects.toThrow('HTTP 401')
    const invalidJson = (async () => new Response('not json', { headers: { 'Content-Type': 'application/json' } })) as typeof fetch
    await expect(provider(invalidJson).test(AbortSignal.timeout(1000))).rejects.toThrow('invalid JSON')
  })

  it('validates the provider configuration through the shared registry', () => {
    const input = {
      provider: 'github', baseUrl: 'https://api.github.com', account: 'alice', authMode: 'token',
      credentials: { token: 't' }, mappings: [{ projectId: 'acme/repo', workspaceId: 'ws' }], itemTypes: ['issue'],
    }
    const normalized = normalizeExternalConfig(input)
    expect(normalized.itemTypes).toEqual(['issue'])
    expect(normalized.credentials).toEqual({ token: 't' })
    expect(() => normalizeExternalConfig({ ...input, credentials: {} })).toThrow('enter credentials')
    expect(() => normalizeExternalConfig({ ...input, mappings: [{ projectId: 'repo-only', workspaceId: 'ws' }] })).toThrow('owner/repo')
    expect(() => normalizeExternalConfig({ ...input, settings: { requestIntervalMs: 'soon' } })).toThrow('request interval')
    expect(() => normalizeExternalConfig({ ...input, baseUrl: 'ftp://api.github.com' })).toThrow('invalid server URL')
    expect(() => normalizeExternalConfig({ ...input, itemTypes: ['bug'] })).toThrow('work item types')
  })
})
