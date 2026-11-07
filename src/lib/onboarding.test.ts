import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentTokenRow, HostTools, ProjectRow } from './api'
import { missingTools, recallOnboarding, rememberOnboarding, steps } from './onboarding'

const tool = (name: string, ok = true) => ({
  name,
  ok,
  problem: ok ? null : `${name} is missing`,
  fix: 'install it',
})
const tools = (...bad: string[]) =>
  ({
    checkedAt: 'now',
    tools: ['git', 'gh', 'claude', 'node', 'pnpm'].map((n) => tool(n, !bad.includes(n))),
  }) as unknown as HostTools
const project = (repos: number, tickets: number) =>
  ({ id: 1, name: 'P', repos: Array.from({ length: repos }, () => ({})), counts: { tickets } }) as ProjectRow
const token = { id: 1, name: 'claude' } as AgentTokenRow

const done = (f: Parameters<typeof steps>[0]) => steps(f).map((s) => [s.id, s.done])

describe('steps', () => {
  it('ticks each step from its own fact', () => {
    expect(done({ tools: tools('gh'), projects: [], tokens: [] })).toEqual([
      ['tools', false],
      ['project', false],
      ['agent', false],
      ['ticket', false],
    ])
    expect(done({ tools: tools(), projects: [project(0, 0)], tokens: [] })).toEqual([
      ['tools', true],
      ['project', false],
      ['agent', false],
      ['ticket', false],
    ])
    expect(done({ tools: tools(), projects: [project(1, 1)], tokens: [token] })).toEqual([
      ['tools', true],
      ['project', true],
      ['agent', true],
      ['ticket', true],
    ])
  })

  it('needs only git, gh and claude: node and pnpm are for previews', () => {
    expect(steps({ tools: tools('node', 'pnpm'), projects: [], tokens: [] })[0]!.done).toBe(true)
    expect(missingTools(tools('claude', 'pnpm')).map((t) => t.name)).toEqual(['claude'])
  })

  it('shows a step whose source is loading as pending, and one that failed as failed and not done', () => {
    const s = steps({ tools: undefined, projects: null, tokens: [token] })
    expect(s.map((x) => [x.id, x.pending, x.failed, x.done])).toEqual([
      ['tools', true, false, false],
      ['project', false, true, false],
      ['agent', false, false, true],
      ['ticket', false, true, false],
    ])
  })
})

describe('what this browser remembers', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps dismissed or done per user, and nothing else', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    })
    expect(recallOnboarding('enrique')).toBeNull()
    rememberOnboarding('enrique', 'done')
    expect(recallOnboarding('enrique')).toBe('done')
    expect(recallOnboarding('someone')).toBeNull()
    store.set('getting-started:someone', 'junk')
    expect(recallOnboarding('someone')).toBeNull()
  })

  it('forgets nothing loudly when storage cannot be used', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    expect(() => rememberOnboarding('enrique', 'dismissed')).not.toThrow()
    expect(recallOnboarding('enrique')).toBeNull()
  })
})
