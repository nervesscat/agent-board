import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { BEADS, PALETTE_HEXES, composePiece, planPiece, readThemes, renderPiece } from './tracks.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/release-art/tracks.mjs')
const COMMITTED = join(ROOT, 'src/assets/release-art/tracks')
const VERSIONS = ['v0.2.2', 'v0.2.3', 'v0.2.4', 'v0.2.5']
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

function sameBytes(a, b) {
  return readFileSync(a).equals(readFileSync(b))
}

describe('release artwork: tracks', () => {
  it('writes the same bytes on every run', { timeout: TIMEOUT }, () => {
    const first = mkdtempSync(join(tmpdir(), 'tracks-a-'))
    const second = mkdtempSync(join(tmpdir(), 'tracks-b-'))
    generate(first)
    generate(second)

    const files = pieceFiles(first)
    expect(files.length).toBe(VERSIONS.length * 2)
    for (const file of files) expect(sameBytes(join(first, file), join(second, file)), file).toBe(true)
    expect(sameBytes(join(first, 'manifest.json'), join(second, 'manifest.json'))).toBe(true)
  })

  it('matches the pieces committed beside the app', { timeout: TIMEOUT }, () => {
    const fresh = mkdtempSync(join(tmpdir(), 'tracks-committed-'))
    generate(fresh)

    expect(pieceFiles(fresh)).toEqual(pieceFiles(COMMITTED))
    for (const file of pieceFiles(fresh))
      expect(sameBytes(join(COMMITTED, file), join(fresh, file)), file).toBe(true)
    expect(sameBytes(join(COMMITTED, 'manifest.json'), join(fresh, 'manifest.json'))).toBe(true)
  })

  it('keeps every piece 16:9, self-contained, without text and under the size budget', () => {
    const files = pieceFiles(COMMITTED)
    for (const version of VERSIONS) {
      expect(files).toContain(`${version}-dark.svg`)
      expect(files).toContain(`${version}-light.svg`)
    }
    for (const file of files) {
      const svg = readFileSync(join(COMMITTED, file), 'utf8')
      expect(svg).toMatch(/viewBox="0 0 1600 900"/)
      expect(svg).toMatch(/width="1600" height="900"/)
      expect(svg).toMatch(/role="img"/)
      expect(svg).toContain('<title')
      expect(svg).toContain('<desc')
      expect(Buffer.byteLength(svg), file).toBeLessThan(BUDGET)
      // Nothing that loads, runs or needs a network, and no text drawn inside the artwork.
      expect(svg).not.toMatch(/<script|<image|<use|<foreignObject|<text|<tspan|<style|@import|xlink|href=/)
      expect(svg.match(/https?:\/\/[^"' ]+/g)).toEqual(['http://www.w3.org/2000/svg'])
      // Every url() points at a filter defined in the same file.
      for (const [, id] of svg.matchAll(/url\(#([^)]+)\)/g)) expect(svg).toContain(`<filter id="${id}"`)
      expect(svg).not.toMatch(/url\((?!#)/)
    }
  })

  it('draws with nothing but the declared palette', () => {
    const allowed = new Set(PALETTE_HEXES.map((hex) => hex.toUpperCase()))
    for (const file of pieceFiles(COMMITTED)) {
      const svg = readFileSync(join(COMMITTED, file), 'utf8')
      const colours = [...svg.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((match) => match[0].toUpperCase())
      expect(colours.length).toBeGreaterThan(0)
      for (const colour of colours) expect(allowed.has(colour), `${file} uses ${colour}`).toBe(true)
      // A ground, a neutral and one ink per sign: four colours at most in one piece.
      expect(new Set(colours).size).toBeLessThanOrEqual(4)
    }
  })

  it('reads a release as its themes', () => {
    const plan = (notes) => planPiece('v9.9.9', readThemes(notes), 123456789)

    expect(
      plan('* Agents ask for a review\n* Share a lane with a worker\n* Delegate the queue\n').primary,
    ).toBe('hands')
    expect(plan('* Keep the focus ring inside\n* Cache the proxy\n* Count on the clock\n').primary).toBe(
      'holding',
    )
    expect(plan('* Move the palette\n* Remove the menu\n* Split the sidebar module\n').primary).toBe('route')
    expect(plan('* Show progress jobs\n* Add a remote mode\n* Speed up the long runs\n').primary).toBe(
      'flight',
    )
    // Notes with nothing to read still give a piece, and always the same one.
    expect(plan('nothing to see').primary).toBe('hands')
    expect(readThemes('* Release 1.0.0\n* Bump a dependency from 1 to 2\n').lines).toBe(0)
  })

  it('gives the four releases four different plates', () => {
    const manifest = JSON.parse(readFileSync(join(COMMITTED, 'manifest.json'), 'utf8'))
    expect(manifest.madeBy).toBe('Claude Fable 5.2')
    expect(manifest.releases.map((release) => release.version)).toEqual(VERSIONS)
    expect(manifest.releases.map((release) => release.plan.primary)).toEqual([
      'hands',
      'holding',
      'route',
      'flight',
    ])
    expect(new Set(manifest.releases.map((release) => release.plan.seed)).size).toBe(VERSIONS.length)
  })

  it('is a different piece for a different version with the same notes', () => {
    const themes = readThemes('* Move the palette\n* Remove the menu\n')
    const one = renderPiece(planPiece('v1.0.0', themes), 'light')
    const other = renderPiece(planPiece('v1.0.1', themes), 'light')
    expect(one).not.toBe(other)
    expect(renderPiece(planPiece('v1.0.0', themes), 'light')).toBe(one)
  })

  it('leaves most of the plate empty and keeps its beads legible at a third of the size', () => {
    const third = 1 / 3
    // The smallest bead is still more than a device pixel wide at one third.
    expect(Math.min(...BEADS.widths) * third).toBeGreaterThanOrEqual(1.5)
    expect(BEADS.pitch).toBeGreaterThan(1)
    const manifest = JSON.parse(readFileSync(join(COMMITTED, 'manifest.json'), 'utf8'))
    for (const release of manifest.releases) {
      const { trails } = composePiece(release.plan)
      expect(trails.length, release.version).toBeGreaterThanOrEqual(6)
      expect(trails.length, release.version).toBeLessThanOrEqual(40)
    }
  })

  it('makes a piece for a release it has never seen, without a manifest', { timeout: TIMEOUT }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracks-new-'))
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

    expect(generate(dir, ['--version', 'v9.9.9', '--notes', notes])).toContain('v9.9.9: route')
    expect(pieceFiles(dir)).toEqual(['v9.9.9-dark.svg', 'v9.9.9-light.svg'])
    expect(existsSync(join(dir, 'manifest.json'))).toBe(false)
    for (const file of pieceFiles(dir))
      expect(Buffer.byteLength(readFileSync(join(dir, file)))).toBeLessThan(BUDGET)
  })

  it('refuses flags with no value instead of writing into the series', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracks-flags-'))

    expect(failure(['--out'])).toContain('--out needs a value')
    expect(failure(['--version', 'v1.0.0', '--notes'])).toContain('--notes needs a value')
    expect(failure(['--version', 'v1.0.0'])).toContain('--version and --notes go together')
    expect(failure(['--notes', join(dir, 'notes.md')])).toContain('--version and --notes go together')
    expect(failure(['--bogus'])).toContain('Unknown argument: --bogus')
  })
})
