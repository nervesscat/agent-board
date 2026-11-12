import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { PALETTE_HEXES, planPiece, readThemes } from './retro-riso.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/release-art/retro-riso.mjs')
const COMMITTED = join(ROOT, 'src/assets/release-art/retro-riso')
const BUDGET = 150 * 1024
const TIMEOUT = 60_000

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

describe('release artwork: retro riso', () => {
  it('writes the same bytes on every run', { timeout: TIMEOUT }, () => {
    const first = mkdtempSync(join(tmpdir(), 'retro-riso-a-'))
    const second = mkdtempSync(join(tmpdir(), 'retro-riso-b-'))
    generate(first)
    generate(second)

    const files = pieceFiles(first)
    expect(files.length).toBe(6)
    for (const file of files) {
      expect(readFileSync(join(second, file)).equals(readFileSync(join(first, file)))).toBe(true)
    }
    expect(
      readFileSync(join(second, 'manifest.json')).equals(readFileSync(join(first, 'manifest.json'))),
    ).toBe(true)
  })

  it('matches the pieces committed beside the app', { timeout: TIMEOUT }, () => {
    const fresh = mkdtempSync(join(tmpdir(), 'retro-riso-committed-'))
    generate(fresh)

    expect(pieceFiles(fresh)).toEqual(pieceFiles(COMMITTED))
    for (const file of pieceFiles(fresh)) {
      expect(readFileSync(join(COMMITTED, file)).equals(readFileSync(join(fresh, file)))).toBe(true)
    }
    expect(
      readFileSync(join(COMMITTED, 'manifest.json')).equals(readFileSync(join(fresh, 'manifest.json'))),
    ).toBe(true)
  })

  it('keeps every piece 16:9, self-contained and under the size budget', () => {
    for (const file of pieceFiles(COMMITTED)) {
      const svg = readFileSync(join(COMMITTED, file), 'utf8')
      expect(svg).toMatch(/viewBox="0 0 1600 900"/)
      expect(svg).toMatch(/width="1600" height="900"/)
      expect(svg).toMatch(/role="img"/)
      expect(svg).toContain('<title')
      expect(svg).toContain('<desc')
      expect(Buffer.byteLength(svg)).toBeLessThan(BUDGET)
      // Nothing that loads, runs, or needs a network, and no text drawn inside the artwork.
      expect(svg).not.toMatch(/<script|<image|<use|<foreignObject|<text|xlink|href=/)
      expect(svg.match(/https?:\/\/[^"' ]+/g)).toEqual(['http://www.w3.org/2000/svg'])
    }
    for (const version of ['v0.2.2', 'v0.2.3', 'v0.2.4']) {
      expect(pieceFiles(COMMITTED)).toContain(`${version}-dark.svg`)
      expect(pieceFiles(COMMITTED)).toContain(`${version}-light.svg`)
    }
  })

  it('prints nothing but the declared palette', () => {
    // True black and white are allowed for the drum-miss mask only; they are holes, not inks.
    const allowed = new Set([...PALETTE_HEXES, '#000000', '#FFFFFF'].map((hex) => hex.toUpperCase()))
    for (const file of pieceFiles(COMMITTED)) {
      const svg = readFileSync(join(COMMITTED, file), 'utf8')
      const colours = [...svg.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((match) => match[0].toUpperCase())
      expect(colours.length).toBeGreaterThan(0)
      for (const colour of colours) expect(allowed.has(colour), `${file} uses ${colour}`).toBe(true)
    }
  })

  it('reads a release as its themes', () => {
    const wayfinding = readThemes('* Move the palette\n* Remove the menu\n* Split the settings\n')
    const precision = readThemes('* Focus rings\n* Cache the proxy\n* Keep the clock exact\n')

    expect(wayfinding.wayfinding).toBeGreaterThan(wayfinding.precision)
    expect(precision.precision).toBeGreaterThan(precision.wayfinding)
    expect(planFor('* Move the palette\n* Remove the menu\n* Split the settings\n').corridor).toBe(true)
    expect(planFor('* Focus rings\n* Cache the proxy\n* Keep the clock exact\n').ridge).toBe(true)
    expect(planFor('* Focus rings\n* Cache the proxy\n* Keep the clock exact\n').corridor).toBe(false)
  })

  it('splits the contours between the two drums, deterministically', () => {
    const notes = readThemes('* Move the palette\n')
    const first = planPiece('v9.9.9', notes, 424242)
    const second = planPiece('v9.9.9', notes, 424242)

    expect(first.spotStride).toBe(3)
    expect(first.spotPhase).toBe(second.spotPhase)
    expect(first.registration).toEqual(second.registration)
    expect(first.registration.x).toBeGreaterThanOrEqual(1.2)
    expect(first.registration.x).toBeLessThanOrEqual(2.0)
    expect(Math.abs(first.registration.y)).toBeGreaterThanOrEqual(0.8)
    expect(Math.abs(first.registration.y)).toBeLessThanOrEqual(1.6)
  })

  it('keeps the degradation legible at a third of the size', () => {
    const manifest = JSON.parse(readFileSync(join(COMMITTED, 'manifest.json'), 'utf8'))
    const third = 1 / 3
    const { inkWeights, spotWeight, halftone } = manifest.print

    // The heaviest strokes stay a device pixel wide at 1/3, so the field keeps its edges.
    expect(inkWeights.heavy * third).toBeGreaterThanOrEqual(0.9)
    expect(spotWeight * third).toBeGreaterThanOrEqual(0.9)
    // The screen is coarse enough to read as dots rather than as a grey wash at 1/3.
    expect(halftone.pitch * third).toBeGreaterThanOrEqual(2.5)
    expect(halftone.radius * third).toBeGreaterThanOrEqual(0.7)
    // The drum density is low-frequency: its patches survive the downscale.
    for (const release of manifest.releases) {
      for (const frequency of release.print.drumMottle.frequency) {
        expect((1 / frequency) * third).toBeGreaterThanOrEqual(10)
      }
    }
  })

  it('makes a piece for a release it has never seen, without a manifest', { timeout: TIMEOUT }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'retro-riso-new-'))
    const notes = join(dir, 'v9.9.9.md')
    writeFileSync(
      notes,
      [
        "## What's Changed",
        '* Move the settings into their own menu',
        '* Remove the old palette from every screen',
        '* Split the daily view and fold the resume card away',
        '* Rename the cleanup page and find things by search',
        '',
      ].join('\n'),
    )

    generate(dir, ['--version', 'v9.9.9', '--notes', notes])

    expect(pieceFiles(dir)).toEqual(['v9.9.9-dark.svg', 'v9.9.9-light.svg'])
    expect(existsSync(join(dir, 'manifest.json'))).toBe(false)
  })

  it('refuses flags with no value instead of writing into the series', () => {
    const dir = mkdtempSync(join(tmpdir(), 'retro-riso-flags-'))

    expect(failure(['--out'])).toContain('--out needs a value')
    expect(failure(['--out', '', '--version', 'v1.0.0', '--notes', join(dir, 'notes.md')])).toContain(
      '--out needs a value',
    )
    expect(failure(['--version', 'v1.0.0', '--notes'])).toContain('--notes needs a value')
    expect(failure(['--version', 'v1.0.0'])).toContain('--version and --notes go together')
    expect(failure(['--notes', join(dir, 'notes.md')])).toContain('--version and --notes go together')
    expect(failure(['--bogus'])).toContain('Unknown argument: --bogus')
  })

  it('gives different releases visibly different fields and drums', () => {
    const manifest = JSON.parse(readFileSync(join(COMMITTED, 'manifest.json'), 'utf8'))
    const fields = manifest.releases.map((release) => JSON.stringify(release.field))
    const print = manifest.releases.map((release) => JSON.stringify(release.print))
    expect(new Set(fields).size).toBe(manifest.releases.length)
    expect(new Set(print).size).toBe(manifest.releases.length)
  })
})
