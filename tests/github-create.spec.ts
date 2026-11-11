/** Outbound creation: board task → GitHub issue, added to the Project board. */
import { describe, expect, it, vi } from 'vitest'
import { createIssueFromTask } from '../src/host/github-create.ts'
import type { ExternalConfig } from '../src/shared/external.ts'

function config(changes: Partial<ExternalConfig> = {}): ExternalConfig {
  return {
    id: 'c', provider: 'github', authMode: 'token', baseUrl: 'https://api.github.com', account: 'alice',
    credentials: { token: 'private-token' }, settings: { projectOwner: 'acme', projectNumber: '1', statusField: 'Status' },
    mappings: [{ projectId: 'acme/repo', workspaceId: 'ws' }], itemTypes: ['issue'], intervalMinutes: 0, since: '',
    ...changes,
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

type Call = { url: string; method: string; body: string }

function router(handlers: (call: Call) => Response | undefined) {
  const calls: Call[] = []
  const mock = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? 'GET', body: String(init?.body ?? '') }
    calls.push(call)
    const handled = handlers(call)
    if (handled === undefined) throw new Error(`unexpected request: ${call.method} ${call.url}`)
    return handled
  }) as typeof fetch
  return { mock, calls }
}

const PROJECT_META = {
  data: {
    repositoryOwner: {
      projectV2: {
        id: 'PVT_1',
        field: { id: 'PVTSSF_1', options: [{ id: 'opt-clarify', name: '待澄清' }, { id: 'opt-ready', name: '就绪' }] },
      },
    },
  },
}

describe('createIssueFromTask', () => {
  it('creates the issue, adds it to the project and sets the mapped status', async () => {
    const { mock, calls } = router(call => {
      if (call.url.endsWith('/repos/acme/repo/issues') && call.method === 'POST') {
        return json({ number: 42, html_url: 'https://github.com/acme/repo/issues/42', node_id: 'ISSUE_42' }, 201)
      }
      if (call.url.endsWith('/graphql')) {
        const query = JSON.parse(call.body).query as string
        if (query.includes('projectV2')) return json(PROJECT_META)
        if (query.includes('addProjectV2ItemById')) return json({ data: { addProjectV2ItemById: { item: { id: 'PVTI_9' } } } })
        if (query.includes('updateProjectV2ItemFieldValue')) return json({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_9' } } } })
      }
      return undefined
    })

    const result = await createIssueFromTask({
      config: config(), repo: 'acme/repo', title: '修复登录', body: '描述正文', status: 'backlog', request: mock,
    })

    expect(result).toEqual({ number: 42, url: 'https://github.com/acme/repo/issues/42', projectAttached: true })
    const issueCall = calls.find(call => call.url.endsWith('/repos/acme/repo/issues'))!
    expect(JSON.parse(issueCall.body)).toEqual({ title: '修复登录', body: '描述正文' })
    const setValue = calls.find(call => call.body.includes('updateProjectV2ItemFieldValue'))!
    expect(JSON.parse(setValue.body).variables).toMatchObject({ projectId: 'PVT_1', itemId: 'PVTI_9', fieldId: 'PVTSSF_1', optionId: 'opt-clarify' })
  })

  it('skips the project step when no Project is configured', async () => {
    const { mock, calls } = router(call => {
      if (call.url.endsWith('/repos/acme/repo/issues')) return json({ number: 7, html_url: 'https://github.com/acme/repo/issues/7', node_id: 'ISSUE_7' }, 201)
      return undefined
    })
    const result = await createIssueFromTask({
      config: config({ settings: {} }), repo: 'acme/repo', title: '无项目', body: '', status: 'todo', request: mock,
    })
    expect(result).toEqual({ number: 7, url: 'https://github.com/acme/repo/issues/7', projectAttached: false })
    expect(calls.some(call => call.url.endsWith('/graphql'))).toBe(false)
  })

  it('keeps the issue when the project attachment fails', async () => {
    const { mock } = router(call => {
      if (call.url.endsWith('/repos/acme/repo/issues')) return json({ number: 8, html_url: 'https://github.com/acme/repo/issues/8', node_id: 'ISSUE_8' }, 201)
      if (call.url.endsWith('/graphql')) return json({ errors: [{ message: 'no scope' }] })
      return undefined
    })
    const result = await createIssueFromTask({
      config: config(), repo: 'acme/repo', title: '半成品', body: '', status: 'todo', request: mock,
    })
    // Duplicate issues are worse than a missing project item: the issue stays.
    expect(result).toMatchObject({ number: 8, projectAttached: false })
  })

  it('fails loudly when the issue itself cannot be created', async () => {
    const { mock } = router(call => {
      if (call.url.endsWith('/repos/acme/repo/issues')) return json({ message: 'nope' }, 403)
      return undefined
    })
    await expect(createIssueFromTask({
      config: config(), repo: 'acme/repo', title: '失败', body: '', status: 'todo', request: mock,
    })).rejects.toThrow('GitHub issue creation failed (HTTP 403)')
  })
})
