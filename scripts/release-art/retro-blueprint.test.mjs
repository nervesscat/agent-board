import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { PALETTE, planPiece, readThemes } from './retro-blueprint.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/release-art/retro-blueprint.mjs')
const COMMITTED = join(ROOT, 'src/assets/release-art/retro-blueprint')
const BUDGET = 150 * 1024
const TIMEOUT = 90_000
const RELEASES = ['v0.2.2', 'v0.2.3', 'v0.2.4']

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

function piece(name) {
  return readFileSync(join(COMMITTED, `${name}.svg`), 'utf8')
}

function planFor(notes) {
  return planPiece('v9.9.9', readThemes(notes), 123456789)
}

describe('release artwork: retro blueprint', () => {
  it('writes the same bytes on every run', { timeout: TIMEOUT }, () => {
    const first = mkdtempSync(join(tmpdir(), 'retro-blueprint-a-'))
    const second = mkdtempSync(join(tmpdir(), 'retro-blueprint-b-'))
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
    const fresh = mkdtempSync(join(tmpdir(), 'retro-blueprint-committed-'))
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
    for (const version of RELEASES) {
      expect(pieceFiles(COMMITTED)).toContain(`${version}-dark.svg`)
      expect(pieceFiles(COMMITTED)).toContain(`${version}-light.svg`)
    }
  })

  it('paints nothing outside the declared palette', () => {
    const declared = Object.values(PALETTE)
    expect(declared).toEqual(['#0E2438', '#EAF3F8', '#7FB6D9', '#081826'])

    for (const file of pieceFiles(COMMITTED)) {
      // The exposure mask and the gradients inside it speak in pure black and white: opacity, not
      // pigment. Everything that is actually painted comes from the four hexes above.
      const painted = readFileSync(join(COMMITTED, file), 'utf8')
        .replace(/<defs>[\s\S]*?<\/defs>/, '')
        .replace(/<mask[\s\S]*?<\/mask>/g, '')
      const colours = painted.match(/#[0-9A-Fa-f]{6}\b/g) || []
      expect(colours.length).toBeGreaterThan(0)
      for (const colour of colours) expect(declared).toContain(colour)
    }

    const manifest = JSON.parse(readFileSync(join(COMMITTED, 'manifest.json'), 'utf8'))
    expect(manifest.palette).toEqual(PALETTE)
  })

  it('prints one field under two conditions: the linework is the same in both variants', () => {
    for (const version of RELEASES) {
      const paths = (variant) =>
        [...piece(`${version}-${variant}`).matchAll(/<path d="([^"]*)"/g)].map((match) => match[1]).sort()
      expect(paths('light')).toEqual(paths('dark'))
      expect(piece(`${version}-light`)).not.toBe(piece(`${version}-dark`))
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

  it('makes a piece for a release it has never seen, without a manifest', { timeout: TIMEOUT }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'retro-blueprint-new-'))
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
    // The same version and notes make the same two files, whether or not they are in the series.
    const again = mkdtempSync(join(tmpdir(), 'retro-blueprint-new-again-'))
    generate(again, ['--version', 'v9.9.9', '--notes', notes])
    for (const file of pieceFiles(dir)) {
      expect(readFileSync(join(again, file)).equals(readFileSync(join(dir, file)))).toBe(true)
    }
  })

  it('refuses flags with no value instead of writing into the series', () => {
    const dir = mkdtempSync(join(tmpdir(), 'retro-blueprint-flags-'))

    expect(failure(['--out'])).toContain('--out needs a value')
    expect(failure(['--out', '', '--version', 'v1.0.0', '--notes', join(dir, 'notes.md')])).toContain(
      '--out needs a value',
    )
    expect(failure(['--version', 'v1.0.0', '--notes'])).toContain('--notes needs a value')
    expect(failure(['--version', 'v1.0.0'])).toContain('--version and --notes go together')
    expect(failure(['--notes', join(dir, 'notes.md')])).toContain('--version and --notes go together')
    expect(failure(['--bogus'])).toContain('Unknown argument: --bogus')
  })

  it('gives different releases visibly different fields', () => {
    const manifest = JSON.parse(readFileSync(join(COMMITTED, 'manifest.json'), 'utf8'))
    const fields = manifest.releases.map((release) => JSON.stringify(release.exposure))
    expect(new Set(fields).size).toBe(manifest.releases.length)
    expect(manifest.releases.map((release) => release.version)).toEqual(RELEASES)
  })
})
