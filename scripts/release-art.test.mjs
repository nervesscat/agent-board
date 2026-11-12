import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  BUDGET_BYTES,
  HEIGHT,
  OUT_DIR,
  THEMES,
  WIDTH,
  draw,
  fileName,
  plan,
  prng,
  readNotesCache,
  readThemes,
} from './release-art.mjs'

const releases = await readNotesCache()
const piece = (release, theme) => draw(plan(release.version, release.body), theme)
const files = releases.flatMap((release) => THEMES.map((theme) => fileName(release.version, theme)))

describe('release art', () => {
  it('has a release to draw, with its notes', () => {
    expect(releases.length).toBeGreaterThan(0)
    for (const release of releases) {
      expect(release.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(release.body.length).toBeGreaterThan(200)
    }
  })

  it('draws the same bytes for the same version and notes', () => {
    for (const release of releases) {
      for (const theme of THEMES) {
        expect(piece(release, theme)).toBe(piece(release, theme))
      }
    }
  })

  it('draws a different piece when the version or the notes change', () => {
    const [release] = releases
    const base = draw(plan(release.version, release.body), 'light')
    expect(draw(plan(release.version, `${release.body}\n* Something else entirely`), 'light')).not.toBe(base)
    expect(draw(plan(`${release.version}.1`, release.body), 'light')).not.toBe(base)
  })

  it('keeps every committed piece in step with the generator', () => {
    for (const release of releases) {
      for (const theme of THEMES) {
        const file = path.join(OUT_DIR, fileName(release.version, theme))
        expect(fs.readFileSync(file, 'utf8'), fileName(release.version, theme)).toBe(piece(release, theme))
      }
    }
  })

  it('ships 16:9 SVGs under the size budget', () => {
    for (const name of files) {
      const svg = fs.readFileSync(path.join(OUT_DIR, name), 'utf8')
      expect(svg).toContain(`viewBox="0 0 ${WIDTH} ${HEIGHT}"`)
      expect(WIDTH / HEIGHT).toBeCloseTo(16 / 9, 5)
      expect(Buffer.byteLength(svg)).toBeLessThan(BUDGET_BYTES)
    }
  })

  it('is self-contained: no external assets, no text, no script', () => {
    for (const name of files) {
      const svg = fs.readFileSync(path.join(OUT_DIR, name), 'utf8')
      const body = svg.replace('xmlns="http://www.w3.org/2000/svg"', '')
      expect(body, name).not.toMatch(/https?:\/\//)
      expect(svg).not.toContain('<image')
      expect(svg).not.toContain('<text')
      expect(svg).not.toContain('<script')
      expect(svg).not.toContain('href=')
    }
  })

  it('holds to two inks and a ground per piece', () => {
    for (const name of files) {
      const svg = fs.readFileSync(path.join(OUT_DIR, name), 'utf8')
      const colours = new Set(svg.match(/#[0-9a-f]{6}/g))
      // Two inks plus one ground, and nothing else.
      expect(colours.size, name).toBe(3)
    }
  })

  it('reads the release themes as numbers between nothing and everything', () => {
    for (const release of releases) {
      const themes = readThemes(release.body)
      for (const value of Object.values(themes)) {
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(1)
      }
    }
  })

  it('still draws a piece when a release has no notes yet', () => {
    const svg = draw(plan('0.2.5', ''), 'light')
    expect(svg).not.toContain('NaN')
    expect(svg).toContain('viewBox="0 0 1600 900"')
  })

  it('puts the empty quarter somewhere the ink is not', () => {
    for (const release of releases) {
      const made = plan(release.version, release.body)
      const [qx, qy] = made.quiet
      for (const drop of made.drops) {
        const gap = Math.hypot(drop.cx / WIDTH - qx, drop.cy / HEIGHT - qy)
        expect(gap, `${release.version} drop in the quiet quarter`).toBeGreaterThan(0.3)
      }
    }
  })

  it('makes the three releases visibly different pieces', () => {
    const light = releases.map((release) => piece(release, 'light'))
    expect(new Set(light).size).toBe(light.length)
  })

  it('is a seeded, engine-independent generator', () => {
    const a = prng(1234)
    const b = prng(1234)
    const first = Array.from({ length: 8 }, () => a())
    expect(first).toEqual(Array.from({ length: 8 }, () => b()))
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true)
  })
})
