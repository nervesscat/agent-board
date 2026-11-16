import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { PALETTE_HEXES, SERIES, WARP_PITCH, planPiece, readThemes, render } from './loom.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/release-art/loom.mjs')
const COMMITTED = join(ROOT, 'src/assets/release-art/loom')
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

const sameBytes = (a, b) => readFileSync(a).equals(readFileSync(b))

describe('release artwork: loom', () => {
  it('writes the same bytes on every run', { timeout: TIMEOUT }, () => {
    const first = mkdtempSync(join(tmpdir(), 'loom-a-'))
    const second = mkdtempSync(join(tmpdir(), 'loom-b-'))
    generate(first)
    generate(second)

    const files = pieceFiles(first)
    expect(files.length).toBe(8)
    for (const file of [...files, 'manifest.json']) {
      expect(sameBytes(join(first, file), join(second, file)), file).toBe(true)
    }
  })

  it('matches the pieces committed beside the app', { timeout: TIMEOUT }, () => {
    const fresh = mkdtempSync(join(tmpdir(), 'loom-committed-'))
    generate(fresh)

    expect(pieceFiles(fresh)).toEqual(pieceFiles(COMMITTED))
    for (const file of [...pieceFiles(fresh), 'manifest.json']) {
      expect(sameBytes(join(COMMITTED, file), join(fresh, file)), file).toBe(true)
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
      // No drawn text, nothing that loads or runs, and no reference outside the file.
      expect(svg).not.toMatch(
        /<text|<tspan|<textPath|<script|<image|<use|<foreignObject|<style|xlink|href=|@import/,
      )
      expect(svg.match(/https?:\/\/[^"' ]+/g)).toEqual(['http://www.w3.org/2000/svg'])
      for (const ref of svg.matchAll(/url\(([^)]*)\)/g)) expect(ref[1], file).toMatch(/^#[a-z]+$/)
    }
  })

  it('dyes with nothing but the declared palette', () => {
    const allowed = new Set(PALETTE_HEXES.map((hex) => hex.toUpperCase()))
    for (const file of pieceFiles(COMMITTED)) {
      const svg = readFileSync(join(COMMITTED, file), 'utf8')
      const colours = [...svg.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((match) => match[0].toUpperCase())
      expect(colours.length).toBeGreaterThan(0)
      for (const colour of colours) expect(allowed.has(colour), `${file} uses ${colour}`).toBe(true)
      expect(svg).not.toMatch(/rgb\(|hsl\(|#[0-9a-fA-F]{3}\b/)
    }
    // Three dyes per mode, on an undyed ground.
    const manifest = JSON.parse(readFileSync(join(COMMITTED, 'manifest.json'), 'utf8'))
    expect(manifest.palette.light.dyes).toHaveLength(3)
    expect(manifest.palette.dark.dyes).toHaveLength(3)
  })

  it('reads a release as its themes', () => {
    const moving = readThemes(
      '* Move the palette\n* Remove the menu\n* Split the settings\n* Fold the list\n',
    )
    const holding = readThemes('* Focus rings inside items\n* Cache the proxy\n* Keep the clock exact\n')
    const hands = readThemes('* Project agents\n* Delegate reviews to lanes\n* Agents share tickets\n')
    const pulse = readThemes('* Stall means no agent alive\n* Progress jobs\n* Tracked notifications\n')

    expect(moving.wayfinding).toBeGreaterThan(0.5)
    expect(holding.precision).toBeGreaterThan(0.5)
    expect(hands.agency).toBeGreaterThan(0.5)
    expect(pulse.signal).toBeGreaterThan(0.5)
    // A bare version bump is not read as a change.
    expect(readThemes('* Release 0.2.3\n* Bump pnpm from 1 to 2\n').items).toBe(0)
  })

  it('lays in what the themes ask for, and nothing a minor theme would add', () => {
    const plan = (notes) => planPiece('v9.9.9', readThemes(notes), 123456789)
    const kinds = (p) => new Set(p.blocks.map((block) => block.kind))

    const holding = plan('* Focus rings inside items\n* Cache the proxy\n* Keep the clock exact\n')
    expect(kinds(holding).has('precision')).toBe(true)
    expect(kinds(holding).has('signal')).toBe(false)
    expect(holding.ground).toBe('plain')

    const moving = plan('* Move the palette\n* Remove the menu\n* Split the settings\n* Fold the list\n')
    expect(kinds(moving).has('ghost')).toBe(true)
    expect(moving.blocks.some((block) => block.kind === 'wayfinding' && block.turn != null)).toBe(true)
    expect(moving.ground).toBe('twill')

    const pulse = plan('* Stall means no agent alive\n* Progress jobs\n* Tracked notifications\n')
    expect(kinds(pulse).has('signal')).toBe(true)
    expect(pulse.pulses.length).toBeGreaterThan(4)
  })

  it('stays woven, not drawn, at a third of the size', () => {
    const manifest = JSON.parse(readFileSync(join(COMMITTED, 'manifest.json'), 'utf8'))
    const third = 1 / 3
    // A warp thread is still more than 3 px wide at a third, so the interlacing does not turn to grey.
    expect(manifest.thread.warpWidth * third).toBeGreaterThanOrEqual(3)
    expect(WARP_PITCH * third).toBeGreaterThanOrEqual(5)
    for (const release of manifest.releases) {
      expect(release.cloth.beat * 0.8 * third).toBeGreaterThanOrEqual(2.5)
      // The hand's wobble is slow: its waves stay longer than the card is tall at a third.
      for (const frequency of release.cloth.wobbleFrequency)
        expect((1 / frequency) * third).toBeGreaterThan(30)
    }
  })

  it('gives different releases visibly different cloth', () => {
    const manifest = JSON.parse(readFileSync(join(COMMITTED, 'manifest.json'), 'utf8'))
    expect(manifest.releases.map((release) => release.version)).toEqual(SERIES)
    const cloth = manifest.releases.map((release) => JSON.stringify(release.cloth))
    expect(new Set(cloth).size).toBe(SERIES.length)
    expect(new Set(manifest.releases.map((release) => release.lead)).size).toBeGreaterThanOrEqual(3)
    // Same version, same piece; another version, another piece.
    const notes = readFileSync(join(ROOT, 'scripts/release-art/notes/v0.2.3.md'), 'utf8')
    expect(render('v0.2.3', notes).light).toBe(render('v0.2.3', notes).light)
    expect(render('v0.2.3', notes).light).not.toBe(render('v0.2.4', notes).light)
  })

  it('makes a piece for a release it has never seen, without a manifest', { timeout: TIMEOUT }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'loom-new-'))
    const notes = join(dir, 'v9.9.9.md')
    writeFileSync(
      notes,
      [
        "## What's Changed",
        '* Move the settings into their own menu',
        '* Show a stalled agent as lost contact',
        '* Delegate review rounds to project agents',
        '* Keep the sticky header inside the safe area',
        '',
      ].join('\n'),
    )

    generate(dir, ['--version', 'v9.9.9', '--notes', notes])

    expect(pieceFiles(dir)).toEqual(['v9.9.9-dark.svg', 'v9.9.9-light.svg'])
    expect(existsSync(join(dir, 'manifest.json'))).toBe(false)
  })

  it('refuses flags with no value instead of writing into the series', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loom-flags-'))

    expect(failure(['--out'])).toContain('--out needs a value')
    expect(failure(['--out', '', '--version', 'v1.0.0', '--notes', join(dir, 'n.md')])).toContain(
      '--out needs a value',
    )
    expect(failure(['--version', 'v1.0.0', '--notes'])).toContain('--notes needs a value')
    expect(failure(['--version', 'v1.0.0'])).toContain('--version and --notes go together')
    expect(failure(['--notes', join(dir, 'n.md')])).toContain('--version and --notes go together')
    expect(failure(['--bogus'])).toContain('Unknown argument: --bogus')
  })
})
