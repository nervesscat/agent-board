import { describe, expect, it } from 'vitest'

import { classify, isProtected, parseEtime } from './reap-test-leftovers.mjs'

const BOARD = '/repo/.output-e2e/server/index.mjs'
const DEAD_ROOT = '/tmp/agent-board-e2e-dead'
const LIVE_ROOT = '/tmp/agent-board-e2e-live'

/** A process as the reaper reads it: old by default, orphaned by default, tagged with the dead run. */
function proc(overrides = {}) {
  return {
    pid: 100,
    ppid: 1,
    ageHours: 5,
    command: `node ${BOARD}`,
    env: { E2E_ROOT: DEAD_ROOT },
    ...overrides,
  }
}

const runnerAlive = (folder) => folder === LIVE_ROOT
const SELF = 1

describe('the test-run reaper', () => {
  it('classify lists an old test board with no live owner', () => {
    const { listed } = classify({ processes: [proc()], roots: [], hours: 4, runnerAlive, self: SELF })
    expect(listed.map((p) => p.pid)).toEqual([100])
    expect(listed[0].reason).toBe('its run has ended')
  })

  it("classify never lists a live run's processes", () => {
    const live = proc({ pid: 200, env: { E2E_ROOT: LIVE_ROOT }, command: `node ${BOARD}` })
    const fake = proc({ pid: 201, env: { E2E_ROOT: LIVE_ROOT }, command: 'node fake-claude.mjs' })
    const { listed } = classify({ processes: [live, fake], roots: [], hours: 0, runnerAlive, self: SELF })
    expect(listed).toEqual([])
  })

  it('classify never matches the live board', () => {
    // The live board runs on 47100 from the main checkout, with its data/ folder: never listed, even orphaned and old.
    const byPort = proc({ pid: 300, command: `node ${BOARD} --port 47100`, env: {} })
    const byEnv = proc({ pid: 301, command: `node ${BOARD}`, env: { BOARD_PORT: '47100' } })
    const byData = proc({ pid: 302, command: `node ${BOARD} --data /repo/data/`, env: {} })
    expect(isProtected(byPort)).toBe(true)
    expect(isProtected(byEnv)).toBe(true)
    expect(isProtected(byData)).toBe(true)
    const { listed } = classify({
      processes: [byPort, byEnv, byData],
      roots: [],
      hours: 0,
      runnerAlive,
      self: SELF,
    })
    expect(listed).toEqual([])
  })

  it('classify never matches an unmarked process', () => {
    const vite = proc({ pid: 400, command: 'node node_modules/.bin/vite dev', env: {} })
    const { listed } = classify({ processes: [vite], roots: [], hours: 0, runnerAlive, self: SELF })
    expect(listed).toEqual([])
  })

  it('classify keeps a process whose run is alive', () => {
    const owned = proc({ pid: 500, env: { E2E_ROOT: LIVE_ROOT } })
    const { listed, kept } = classify({ processes: [owned], roots: [], hours: 4, runnerAlive, self: SELF })
    expect(listed).toEqual([])
    expect(kept).toEqual([expect.objectContaining({ pid: 500, reason: 'its run is alive' })])
  })

  it('classify keeps an untagged process that is not orphaned', () => {
    const chrome = proc({
      pid: 600,
      ppid: 900,
      command: 'chrome --user-data-dir=/tmp/playwright_chromiumdev_profile-abc',
      env: {},
    })
    const orphan = { ...chrome, pid: 601, ppid: 1 }
    const { listed, kept } = classify({
      processes: [chrome, orphan],
      roots: [],
      hours: 4,
      runnerAlive,
      self: SELF,
    })
    expect(kept.map((p) => p.pid)).toEqual([600])
    expect(listed.map((p) => p.pid)).toEqual([601])
  })

  it('classify keeps young processes and lists old run folders only when their runner is gone', () => {
    const young = proc({ pid: 700, ageHours: 1 })
    const roots = [
      { path: DEAD_ROOT, ageHours: 6 },
      { path: LIVE_ROOT, ageHours: 6 },
      { path: '/tmp/agent-board-e2e-young', ageHours: 1 },
      { path: '/tmp/not-a-run', ageHours: 9 },
    ]
    const { listed } = classify({ processes: [young], roots, hours: 4, runnerAlive, self: SELF })
    expect(listed).toEqual([{ path: DEAD_ROOT, ageHours: 6, reason: 'its run has ended' }])
  })

  it('parseEtime reads ps elapsed times', () => {
    expect(parseEtime('05:03')).toBe(303)
    expect(parseEtime('02:00:10')).toBe(7210)
    expect(parseEtime('3-01:00:00')).toBe(3 * 86400 + 3600)
  })
})
