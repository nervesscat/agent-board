import { describe, expect, it } from 'vitest'

import { PET_COLORS, PET_FRAMES, PET_HEIGHT, PET_WIDTH, framePaths } from './petSprites'

const states = ['working', 'waiting', 'asleep'] as const

describe('the pet sprites', () => {
  it.each(states)('%s: two frames on the same grid, using only the known colours', (state) => {
    const frames = PET_FRAMES[state]
    expect(frames).toHaveLength(2)
    for (const frame of frames) {
      const rows = frame.split('\n')
      expect(rows).toHaveLength(PET_HEIGHT)
      for (const row of rows) {
        expect(row).toHaveLength(PET_WIDTH)
        expect(row).toMatch(/^[.KBPM]+$/)
      }
    }
    // The frames differ, or nothing would move.
    expect(frames[0]).not.toBe(frames[1])
  })

  it('draws the three poses differently', () => {
    expect(new Set(states.map((s) => PET_FRAMES[s][0])).size).toBe(3)
  })

  it('shows the "?" only while waiting, and the "z" only while asleep', () => {
    const ink = (state: (typeof states)[number]) =>
      PET_FRAMES[state][0]
        .split('\n')
        .slice(0, 10)
        .map((r) => r.slice(0, 3))
    // Above the laptop: the "?" is in the first three columns, left of the body.
    expect(ink('waiting').join('')).toContain('KKK')
    expect(ink('working').join('')).not.toContain('K')
    expect(ink('asleep').join('')).not.toContain('K')
    // The "z" is in the last three columns, right of the body.
    const right = (state: (typeof states)[number]) =>
      PET_FRAMES[state][0]
        .split('\n')
        .slice(0, 10)
        .map((r) => r.slice(-3))
    expect(right('asleep').join('')).toContain('KKK')
    expect(right('working').join('')).not.toContain('K')
  })

  it('paints every pixel as a whole grid cell, one path per colour', () => {
    for (const state of states)
      for (const frame of PET_FRAMES[state]) {
        const paths = framePaths(frame)
        expect(paths.map((p) => p.letter).sort()).toEqual([...new Set(paths.map((p) => p.letter))].sort())
        for (const { letter, d } of paths) {
          expect(letter in PET_COLORS).toBe(true)
          // Only moves, whole-number horizontal and vertical runs: no curves, nothing between pixels.
          expect(d).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/)
        }
        // Every inked cell is in a path: the cells counted from the paths equal those in the frame.
        const cells = framePaths(frame).reduce(
          (n, p) => n + [...p.d.matchAll(/h(\d+)v1/g)].reduce((m, x) => m + Number(x[1]), 0),
          0,
        )
        expect(cells).toBe(frame.replace(/[^KBPM]/g, '').length)
      }
  })
})
