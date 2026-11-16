import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { PALETTE_HEXES, PITCH, planPiece, readThemes, renderPiece } from './screen-interference.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/release-art/screen-interference.mjs')
const COMMITTED = join(ROOT, 'src/assets/release-art/screen-interference')
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

function planFor(notes) {
  return planPiece('v9.9.9', readThemes(notes), 123456789)
}

describe('release artwork: screen interference', () => {
  it('writes the same bytes on every run', { timeout: TIMEOUT }, () => {
    const first = mkdtempSync(join(tmpdir(), 'screen-interference-a-'))
    const second = mkdtempSync(join(tmpdir(), 'screen-interference-b-'))
    generate(first)
    generate(second)

    const files = pieceFiles(first)
    expect(files.length).toBe(8)
    for (const file of [...files, 'manifest.json']) {
      expect(readFileSync(join(second, file)).equals(readFileSync(join(first, file)))).toBe(true)
    }
  })

  it('matches the pieces committed beside the app', { timeout: TIMEOUT }, () => {
    const fresh = mkdtempSync(join(tmpdir(), 'screen-interference-committed-'))
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
      expect(svg).toContain('<title')
      expect(svg).toContain('<desc')
      expect(Buffer.byteLength(svg), file).toBeLessThan(BUDGET)
      // Nothing that loads, runs or reaches a network, and no text drawn inside the artwork.
      expect(svg).not.toMatch(/<script|<image|<use|<foreignObject|<text|<tspan|<style|xlink|href=|@import/i)
      expect(svg.match(/https?:\/\/[^"' ]+/g)).toEqual(['http://www.w3.org/2000/svg'])
      // The only url() references are the piece's own filters.
      for (const ref of svg.match(/url\([^)]*\)/g) || []) expect(ref).toMatch(/^url\(#[a-z]+-(dark|light)\)$/)
    }
  })

  it('prints nothing but the declared palette', () => {
    const allowed = new Set(PALETTE_HEXES.map((hex) => hex.toUpperCase()))
    for (const file of pieceFiles(COMMITTED)) {
      const svg = readFileSync(join(COMMITTED, file), 'utf8')
      const colours = [...svg.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0].toUpperCase())
      expect(colours.length).toBeGreaterThan(0)
      for (const colour of colours) expect(allowed.has(colour), `${file} uses ${colour}`).toBe(true)
    }
  })

  it('reads a release as its themes, and lets no more than two speak', () => {
    const wayfinding = '* Move the palette into the menu\n* Remove the card\n* Split the settings\n'
    const precision = '* Focus rings inside\n* Cache the proxy\n* Keep the clock exact\n'
    expect(readThemes(wayfinding).wayfinding).toBeGreaterThan(readThemes(wayfinding).precision)
    expect(readThemes(precision).precision).toBeGreaterThan(readThemes(precision).wayfinding)

    expect(planFor(wayfinding).lane).not.toBeNull()
    expect(planFor(wayfinding).edge).toBeNull()
    expect(planFor(precision).edge).not.toBeNull()
    expect(planFor(precision).lane).toBeNull()

    const manifest = JSON.parse(readFileSync(join(COMMITTED, 'manifest.json'), 'utf8'))
    for (const release of manifest.releases) expect(release.speaks.length).toBeLessThanOrEqual(2)
  })

  it('closes the screens for precision and opens them for many hands', () => {
    const precise = planFor('* Focus rings\n* Cache the proxy\n* Keep the clock exact\n* Cap the count\n')
    const hands = planFor(
      '* Agent tools\n* Lanes shared between agents\n* Review by agents\n* Delegate to workers\n',
    )
    const gap = (plan) => Math.abs(plan.plates[1].angle - plan.plates[0].angle)
    expect(gap(precise)).toBeLessThan(gap(hands))
    expect(precise.plates[1].warp).toBeLessThan(hands.plates[1].warp)
  })

  it('keeps the screen readable at a third of the size', () => {
    const manifest = JSON.parse(readFileSync(join(COMMITTED, 'manifest.json'), 'utf8'))
    // Six pixels between dots at a third: still a screen, not a grey wash.
    expect(PITCH / 3).toBeGreaterThanOrEqual(5.5)
    for (const release of manifest.releases) {
      for (const screen of release.screens) expect(screen.pitch / 3).toBeGreaterThanOrEqual(5.5)
      // Fringes wider than a dot at a third: at least two pitches between beats.
      const angles = release.screens.map((screen) => screen.angle)
      const gap = Math.abs(angles[1] - angles[0]) * (Math.PI / 180)
      expect(PITCH / (2 * Math.sin(gap / 2)) / PITCH).toBeGreaterThanOrEqual(8)
    }
  })

  it('renders the same plan to the same bytes', () => {
    const plan = planFor('* Move the palette\n')
    expect(renderPiece(plan, 'light').svg).toBe(renderPiece(plan, 'light').svg)
    expect(renderPiece(plan, 'dark').svg).not.toBe(renderPiece(plan, 'light').svg)
  })

  it(
    'makes a piece for a release it has never seen, without touching the manifest',
    { timeout: TIMEOUT },
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'screen-interference-new-'))
      const notes = join(dir, 'v9.9.9.md')
      writeFileSync(
        notes,
        [
          "## What's Changed",
          '* Move the settings into their own menu',
          '* Remove the old palette from every screen',
          '* Split the daily view and fold the resume card away',
          '',
        ].join('\n'),
      )

      generate(dir, ['--version', 'v9.9.9', '--notes', notes])

      expect(pieceFiles(dir)).toEqual(['v9.9.9-dark.svg', 'v9.9.9-light.svg'])
      expect(existsSync(join(dir, 'manifest.json'))).toBe(false)
      for (const file of pieceFiles(dir)) {
        expect(Buffer.byteLength(readFileSync(join(dir, file)))).toBeLessThan(BUDGET)
      }
    },
  )

  it('refuses flags with no value instead of writing into the series', () => {
    const dir = mkdtempSync(join(tmpdir(), 'screen-interference-flags-'))

    expect(failure(['--out'])).toContain('--out needs a value')
    expect(failure(['--version', 'v1.0.0', '--notes'])).toContain('--notes needs a value')
    expect(failure(['--version', 'v1.0.0'])).toContain('--version and --notes go together')
    expect(failure(['--notes', join(dir, 'notes.md')])).toContain('--version and --notes go together')
    expect(failure(['--bogus'])).toContain('Unknown argument: --bogus')
  })

  it('gives each release its own screens and composition', () => {
    const manifest = JSON.parse(readFileSync(join(COMMITTED, 'manifest.json'), 'utf8'))
    expect(manifest.releases.map((release) => release.version)).toEqual(SERIES)
    const screens = manifest.releases.map((release) => JSON.stringify(release.screens))
    expect(new Set(screens).size).toBe(manifest.releases.length)
    const gestures = manifest.releases.map((release) =>
      JSON.stringify([release.edge, release.lane, release.ramp]),
    )
    expect(new Set(gestures).size).toBeGreaterThanOrEqual(3)
  })
})
