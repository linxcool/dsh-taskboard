import { describe, expect, it } from 'vitest'
import { DEFAULT_STATUS_MAP, githubStatusMapOf, parseStatusMap } from '../src/shared/github-status-map.ts'

describe('parseStatusMap', () => {
  it('defaults every column when raw is empty', () => {
    expect(parseStatusMap(undefined)).toEqual(DEFAULT_STATUS_MAP)
  })

  it('overrides one column and keeps the rest', () => {
    const map = parseStatusMap('in_review=等你点头')
    expect(map.in_review).toBe('等你点头')
    expect(map.done).toBe(DEFAULT_STATUS_MAP.done)
  })

  it('ignores unknown columns and empty values', () => {
    const map = parseStatusMap('nope=x,in_review=,todo=就绪')
    expect(map).toEqual({ ...DEFAULT_STATUS_MAP, todo: '就绪' })
  })

  it('keeps the last duplicate column', () => {
    expect(parseStatusMap('todo=甲,todo=乙').todo).toBe('乙')
  })
})

describe('githubStatusMapOf', () => {
  it('is undefined without a github connection', () => {
    expect(githubStatusMapOf(undefined)).toBeUndefined()
    expect(githubStatusMapOf({ provider: 'zentao', settings: {} })).toBeUndefined()
  })

  it('is undefined when write-back is off', () => {
    expect(githubStatusMapOf({ provider: 'github', settings: { writebackMode: 'off' } })).toBeUndefined()
    expect(githubStatusMapOf({ provider: 'github', settings: {} })).toBeUndefined()
  })

  it('parses settings.statusMap for an enabled github connection', () => {
    expect(githubStatusMapOf({ provider: 'github', settings: { writebackMode: 'status', statusMap: 'done=收工' } })?.done).toBe('收工')
  })

  it('falls back to the defaults when the connection has no statusMap', () => {
    expect(githubStatusMapOf({ provider: 'github', settings: { writebackMode: 'both' } })).toEqual(DEFAULT_STATUS_MAP)
  })
})
