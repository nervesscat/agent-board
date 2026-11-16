import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { PALETTE_HEXES, meetsAtEnd, planPiece, readThemes } from './pochoir.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/release-art/pochoir.mjs')
const COMMITTED = join(ROOT, 'src/assets/release-art/pochoir')
const BUDGET = 150 * 1024
const TIMEOUT = 60_000
const SERIES = ['v0.2.2', 'v0.2.3', 'v0.2.4', 'v0.2.5']

function generate(out, extra = []) {
  return execFileSync(process.execPath, [SCRIPT, '--out', out, ...extra], { cwd: ROOT, encoding: 'utf8' })
}

function failure(args) {
  try {
    execFileSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
  } catch (error) {
    return String(error.stderr)
  }
  return ''
}

function pieceFiles(dir) {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.svg'))
    .sort()
}

const PRECISE =
  '* Keep the focus rings inside\n* Cache the proxy and retry\n* Keep the clock exact\n* Fix the sticky header\n'
const STEPPED =
  '* Move the palette into the menu\n* Split the sidebar\n* Remove the old row\n* Fold the page into its own window\n'
const BUSY =
  '* Agent tools and lane verdicts\n* PR queue for review\n* Project agents and shared tokens\n* Delegate to a worker agent\n* Connect a session\n'
const LOUD =
  '* Show progress jobs\n* Notification center notices\n* Work state icon with a tooltip\n* Live work status\n* Warn on a tracked job\n'

describe('release artwork: pochoir', () => {
  it('writes the same bytes on every run', { timeout: TIMEOUT }, () => {
    const first = mkdtempSync(join(tmpdir(), 'pochoir-a-'))
    const second = mkdtempSync(join(tmpdir(), 'pochoir-b-'))
    generate(first)
    generate(second)

    const files = pieceFiles(first)
    expect(files.length).toBe(SERIES.length * 2)
    for (const file of [...files, 'manifest.json']) {
      expect(readFileSync(join(second, file)).equals(readFileSync(join(first, file))), file).toBe(true)
    }
  })

  it('matches the pieces committed beside the app', { timeout: TIMEOUT }, () => {
    const fresh = mkdtempSync(join(tmpdir(), 'pochoir-committed-'))
    generate(fresh)

    expect(pieceFiles(fresh)).toEqual(pieceFiles(COMMITTED))
    for (const file of [...pieceFiles(fresh), 'manifest.json']) {
      expect(readFileSync(join(COMMITTED, file)).equals(readFileSync(join(fresh, file))), file).toBe(true)
    }
  })

  it('keeps every piece 16:9, self-contained, without text and under the size budget', () => {
    for (const version of SERIES) {
      expect(pieceFiles(COMMITTED)).toContain(`${version}-dark.svg`)
      expect(pieceFiles(COMMITTED)).toContain(`${version}-light.svg`)
    }
    for (const file of pieceFiles(COMMITTED)) {
      const svg = readFileSync(join(COMMITTED, file), 'utf8')
      expect(svg).toMatch(/viewBox="0 0 1600 900"/)
      expect(svg).toMatch(/width="1600" height="900"/)
      expect(svg).toMatch(/role="img"/)
      expect(Buffer.byteLength(svg)).toBeLessThan(BUDGET)
      // Nothing that loads, runs or needs a network, and no text drawn inside the artwork
      // (<title> and <desc> are the accessible name, never painted).
      expect(svg).not.toMatch(
        /<script|<image|<use|<foreignObject|<text|<style|@import|xlink|href=|url\((?!#)/,
      )
      expect(svg.match(/https?:\/\/[^"' ]+/g)).toEqual(['http://www.w3.org/2000/svg'])
    }
  })

  it('prints nothing but the declared palette', () => {
    // Black and white only stand for alpha (the spray's coverage and the sweep's mask), never for an ink.
    const allowed = new Set([...PALETTE_HEXES, '#000000', '#FFFFFF'].map((hex) => hex.toUpperCase()))
    for (const file of pieceFiles(COMMITTED)) {
      const svg = readFileSync(join(COMMITTED, file), 'utf8')
      const colours = [...svg.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((match) => match[0].toUpperCase())
      expect(colours.length).toBeGreaterThan(0)
      for (const colour of colours) expect(allowed.has(colour), `${file} uses ${colour}`).toBe(true)
    }
  })

  it('reads a release as its themes, and the themes as passes', () => {
    const precise = readThemes(PRECISE)
    const stepped = readThemes(STEPPED)
    expect(precise.shares.precision).toBeGreaterThan(precise.shares.agency)
    expect(stepped.shares.wayfinding).toBeGreaterThan(stepped.shares.precision)

    // A precise release: no crossings, no arcs, a short hard falloff.
    const p = planPiece('v9.9.9', precise)
    expect(p.passes.some((pass) => pass.crossed)).toBe(false)
    expect(p.passes.some((pass) => pass.kind === 'arc')).toBe(false)
    expect(Math.max(...p.passes.map((pass) => pass.falloff))).toBeLessThan(200)
    // A reorganizing release: the card is stepped along a path.
    expect(planPiece('v9.9.9', stepped).stepped).toBe(true)
    // Many hands cross; a loud release sprays again (echoes).
    const busy = planPiece('v9.9.9', readThemes(BUSY))
    expect(busy.passes.filter((pass) => pass.crossed).length).toBeGreaterThan(0)
    expect(busy.passes.length).toBeGreaterThan(p.passes.length)
    expect(planPiece('v9.9.9', readThemes(LOUD)).echoes).toBeGreaterThan(0)
  })

  it('lets cuts cross in an X but not meet in a V', () => {
    const cut = (x, y, angle) => ({ x, y, angle, length: 600 })
    expect(meetsAtEnd(cut(800, 450, 20), cut(800, 450, -25))).toBe(false)
    expect(meetsAtEnd(cut(800, 450, 20), cut(800, 600, 20))).toBe(false)
    const a = cut(800, 450, 20)
    const end = {
      x: 800 + Math.cos((20 * Math.PI) / 180) * 290,
      y: 450 + Math.sin((20 * Math.PI) / 180) * 290,
    }
    const b = {
      ...cut(0, 0, -30),
      x: end.x + Math.cos((-30 * Math.PI) / 180) * 290,
      y: end.y + Math.sin((-30 * Math.PI) / 180) * 290,
    }
    expect(meetsAtEnd(a, b)).toBe(true)
  })

  it('keeps the spray legible at a third of the size', () => {
    const manifest = JSON.parse(readFileSync(join(COMMITTED, 'manifest.json'), 'utf8'))
    const third = 1 / 3
    for (const release of manifest.releases) {
      // Every spray stays a visible band at 1/3: at least 20 px of falloff on the scaled card.
      for (const pass of release.plan.passes) expect(pass.falloff * third).toBeGreaterThanOrEqual(20)
      // And the card keeps bare ground beside it.
      expect(release.plan.bare).toBeGreaterThanOrEqual(0.18)
    }
    // The knife's wobble is slow enough to read as a cut, not as fuzz, once scaled down.
    expect((1 / manifest.spray.edgeFrequency) * third).toBeGreaterThanOrEqual(15)
  })

  it('gives different releases visibly different plans', () => {
    const manifest = JSON.parse(readFileSync(join(COMMITTED, 'manifest.json'), 'utf8'))
    expect(manifest.releases.map((release) => release.version)).toEqual(SERIES)
    const plans = manifest.releases.map((release) => JSON.stringify(release.plan))
    expect(new Set(plans).size).toBe(SERIES.length)
    const counts = manifest.releases.map((release) => release.plan.passes.length)
    expect(new Set(counts).size).toBeGreaterThan(1)
  })

  it(
    'makes a piece for a release it has never seen, without touching a manifest',
    { timeout: TIMEOUT },
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'pochoir-new-'))
      const notes = join(dir, 'v9.9.9.md')
      writeFileSync(notes, `## What's Changed\n${STEPPED}${LOUD}`)

      generate(dir, ['--version', 'v9.9.9', '--notes', notes])

      expect(pieceFiles(dir)).toEqual(['v9.9.9-dark.svg', 'v9.9.9-light.svg'])
      expect(existsSync(join(dir, 'manifest.json'))).toBe(false)
    },
  )

  it('refuses flags with no value instead of writing into the series', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pochoir-flags-'))

    expect(failure(['--out'])).toContain('--out needs a value')
    expect(failure(['--out', '', '--version', 'v1.0.0', '--notes', join(dir, 'n.md')])).toContain(
      '--out needs a value',
    )
    expect(failure(['--version', 'v1.0.0', '--notes'])).toContain('--notes needs a value')
    expect(failure(['--version', 'v1.0.0'])).toContain('--version and --notes go together')
    expect(failure(['--bogus'])).toContain('Unknown argument: --bogus')
  })
})
