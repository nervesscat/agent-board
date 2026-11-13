import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { PALETTE, planPiece, readThemes } from './retro-thermal.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/release-art/retro-thermal.mjs')
const COMMITTED = join(ROOT, 'src/assets/release-art/retro-thermal')
const BUDGET = 150 * 1024
const TIMEOUT = 120_000

const ALLOWED_COLOURS = new Set(Object.values(PALETTE).map((hex) => hex.toLowerCase()))
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

describe('release artwork: retro thermal', () => {
  it('writes the same bytes on every run', { timeout: TIMEOUT }, () => {
    const first = mkdtempSync(join(tmpdir(), 'retro-thermal-a-'))
    const second = mkdtempSync(join(tmpdir(), 'retro-thermal-b-'))
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
    const fresh = mkdtempSync(join(tmpdir(), 'retro-thermal-committed-'))
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
      // Nothing that loads, runs, or draws a word of text inside the artwork.
      expect(svg).not.toMatch(/<script|<image|<foreignObject|<text>xlink/)
      expect(svg.match(/https?:\/\/[^"' ]+/g)).toEqual(['http://www.w3.org/2000/svg'])
      // Every reference is inside this file.
      for (const href of svg.match(/href="[^"]+"/g) || []) expect(href).toMatch(/^href="#[a-z-]+"$/)
    }
    expect(pieceFiles(COMMITTED)).toEqual(RELEASES.flatMap((v) => [`${v}-dark.svg`, `${v}-light.svg`]))
  })

  it('uses the declared palette and nothing else', () => {
    for (const file of pieceFiles(COMMITTED)) {
      const svg = readFileSync(join(COMMITTED, file), 'utf8')
      for (const hex of svg.match(/#[0-9a-fA-F]{6}/g) || []) {
        expect(ALLOWED_COLOURS).toContain(hex.toLowerCase())
      }
    }
  })

  it('reads a release as its themes', () => {
    const wayfinding = readThemes('* Move the palette\n* Remove the menu\n* Split the settings\n')
    const precision = readThemes('* Focus rings\n* Cache the proxy\n* Keep the clock exact\n')

    expect(wayfinding.wayfinding).toBeGreaterThan(wayfinding.precision)
    expect(precision.precision).toBeGreaterThan(precision.wayfinding)

    const moved = planPiece('v9.9.9', wayfinding, 123456789)
    const held = planPiece('v9.9.9', precision, 123456789)
    expect(moved.interruption).toBe('corridor')
    expect(held.interruption).toBe('crease')
    expect(held.ridge).toBe(true)
    expect(moved.ridge).toBe(false)
    expect(held.levels).toBeGreaterThan(moved.levels)
  })

  it('makes a piece for a release it has never seen, without a manifest', { timeout: TIMEOUT }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'retro-thermal-new-'))
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
    const svg = readFileSync(join(dir, 'v9.9.9-dark.svg'), 'utf8')
    expect(svg).toContain('data-release="v9.9.9"')
  })

  it('refuses flags with no value instead of writing into the series', () => {
    const dir = mkdtempSync(join(tmpdir(), 'retro-thermal-flags-'))

    expect(failure(['--out'])).toContain('--out needs a value')
    expect(failure(['--version', 'v1.0.0', '--notes'])).toContain('--notes needs a value')
    expect(failure(['--version', 'v1.0.0'])).toContain('--version and --notes go together')
    expect(failure(['--notes', join(dir, 'notes.md')])).toContain('--version and --notes go together')
    expect(failure(['--bogus'])).toContain('Unknown argument: --bogus')
  })

  it('gives different releases visibly different fields', () => {
    const manifest = JSON.parse(readFileSync(join(COMMITTED, 'manifest.json'), 'utf8'))
    const fields = manifest.releases.map((release) => JSON.stringify(release.field))
    expect(new Set(fields).size).toBe(manifest.releases.length)
    expect(manifest.palette).toEqual(PALETTE)
    for (const release of manifest.releases) {
      expect(release.files.dark).toBe(`${release.version}-dark.svg`)
      expect(release.files.light).toBe(`${release.version}-light.svg`)
    }
  })
})
