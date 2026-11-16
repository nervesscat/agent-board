import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { GRAIN, PALETTE_HEXES, RIM, matchedPieces, planPiece, readThemes } from './torn-paper.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/release-art/torn-paper.mjs')
const COMMITTED = join(ROOT, 'src/assets/release-art/torn-paper')
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
  return planPiece('v9.9.9', readThemes(notes, 'v9.9.9'), 123456789)
}

describe('release artwork: torn paper', () => {
  it('writes the same bytes on every run', { timeout: TIMEOUT }, () => {
    const first = mkdtempSync(join(tmpdir(), 'torn-paper-a-'))
    const second = mkdtempSync(join(tmpdir(), 'torn-paper-b-'))
    generate(first)
    generate(second)

    const files = pieceFiles(first)
    expect(files.length).toBe(8)
    for (const file of files) {
      expect(readFileSync(join(second, file)).equals(readFileSync(join(first, file)))).toBe(true)
    }
    expect(
      readFileSync(join(second, 'manifest.json')).equals(readFileSync(join(first, 'manifest.json'))),
    ).toBe(true)
  })

  it('matches the pieces committed beside the app', { timeout: TIMEOUT }, () => {
    const fresh = mkdtempSync(join(tmpdir(), 'torn-paper-committed-'))
    generate(fresh)

    expect(pieceFiles(fresh)).toEqual(pieceFiles(COMMITTED))
    for (const file of pieceFiles(fresh)) {
      expect(readFileSync(join(COMMITTED, file)).equals(readFileSync(join(fresh, file)))).toBe(true)
    }
    expect(
      readFileSync(join(COMMITTED, 'manifest.json')).equals(readFileSync(join(fresh, 'manifest.json'))),
    ).toBe(true)
  })

  it('keeps every piece 16:9, self-contained, without text and under the size budget', () => {
    for (const file of pieceFiles(COMMITTED)) {
      const svg = readFileSync(join(COMMITTED, file), 'utf8')
      expect(svg).toMatch(/viewBox="0 0 1600 900"/)
      expect(svg).toMatch(/width="1600" height="900"/)
      expect(svg).toMatch(/role="img"/)
      expect(Buffer.byteLength(svg)).toBeLessThan(BUDGET)
      // Nothing that loads, runs or needs a network, and no text drawn inside the artwork.
      expect(svg).not.toMatch(
        /<script|<image|<use|<foreignObject|<text|<style|xlink|href=|@import|url\((?!#)/,
      )
      expect(svg.match(/https?:\/\/[^"' ]+/g)).toEqual(['http://www.w3.org/2000/svg'])
    }
    for (const version of ['v0.2.2', 'v0.2.3', 'v0.2.4', 'v0.2.5']) {
      expect(pieceFiles(COMMITTED)).toContain(`${version}-dark.svg`)
      expect(pieceFiles(COMMITTED)).toContain(`${version}-light.svg`)
    }
  })

  it('uses nothing but the declared palette', () => {
    const allowed = new Set(PALETTE_HEXES.map((hex) => hex.toUpperCase()))
    for (const file of pieceFiles(COMMITTED)) {
      const svg = readFileSync(join(COMMITTED, file), 'utf8')
      const colours = [...svg.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((match) => match[0].toUpperCase())
      expect(colours.length).toBeGreaterThan(0)
      for (const colour of colours) expect(allowed.has(colour), `${file} uses ${colour}`).toBe(true)
    }
  })

  it('reads a release as its themes and handles the paper accordingly', () => {
    const hands =
      '* Agents share the review queue\n* Project agents and lane verdicts\n* Delegate to a worker\n'
    const holding = '* Focus rings inside their items\n* Cache the proxy\n* Keep the clock on the server\n'
    const clearing = '* Move Daily into the menu\n* Remove the old card\n* Split the sidebar\n'
    const mending =
      '* Retry writes that lose the lock\n* Fix the flaky test\n* Restart the server when it dies\n'

    expect(readThemes(hands).share.agency).toBeGreaterThan(0.5)
    expect(readThemes(holding).share.precision).toBeGreaterThan(0.5)
    expect(readThemes(clearing).share.wayfinding).toBeGreaterThan(0.5)
    expect(readThemes(mending).share.mending).toBeGreaterThan(0.5)

    // Holding: one sheet torn across and laid back, no loose scraps of its own.
    expect(planFor(holding).matched).not.toBeNull()
    expect(planFor(hands).matched).toBeNull()
    // Clearing: pieces lifted, one moved, ghosts left behind.
    const cleared = planFor(clearing)
    expect(cleared.ghosts.length).toBeGreaterThan(0)
    expect(cleared.pieces.some((piece) => piece.state === 'moved')).toBe(true)
    // Hands: more scraps, more angle, than a cleared sheet.
    const many = planFor(hands)
    expect(many.handling.rotation).toBeGreaterThan(planFor(holding).handling.rotation)
    // Mending: torn pieces laid back together.
    expect(planFor(mending).mends.length).toBeGreaterThan(0)
    expect(planFor(hands).mends.length).toBe(0)
  })

  it('counts releases merged in from earlier lines of work, not its own release line', () => {
    const notes = '* Release: dev to main\n* Release 0.2.0: repositories\n* Something new\n* Release 9.9.9\n'
    expect(readThemes(notes, 'v9.9.9').carried).toBe(2)
    expect(planFor(notes).under.length).toBe(2)
  })

  it('keeps the two sides of a matched tear in step, a hairline apart', () => {
    const plan = planFor(
      '* Focus rings inside their items\n* Cache the proxy\n* Keep the clock on the server\n',
    )
    let state = 7
    const rng = () => {
      state = (state * 16807) % 2147483647
      return state / 2147483647
    }
    const parts = matchedPieces(plan.matched, rng)
    expect(parts.length).toBe(plan.matched.tears.length + 1)
    for (let j = 0; j < parts.length - 1; j += 1) {
      const left = parts[j].core
      const right = parts[j + 1].core
      const steps = parts[0].core.length - 2 // points on one tear: the first piece's other side is a straight cut
      // The left piece's right edge runs top to bottom; the right piece's left edge comes back up.
      for (let i = 0; i < steps; i += 1) {
        const a = left[i]
        const b = right[right.length - 1 - i]
        expect(b[1]).toBeCloseTo(a[1], 6)
        expect(b[0] - a[0]).toBeCloseTo(plan.matched.gap, 6)
      }
    }
  })

  it('stays legible at a third of the size', () => {
    const third = 1 / 3
    // The pale rim of a tear is still a device pixel wide where it is widest.
    expect(RIM.max * third).toBeGreaterThanOrEqual(2)
    // The paper's mottle is slow enough to survive the downscale as patches, not a grey wash.
    expect((1 / GRAIN.mottle) * third).toBeGreaterThanOrEqual(50)
    const manifest = JSON.parse(readFileSync(join(COMMITTED, 'manifest.json'), 'utf8'))
    for (const release of manifest.releases) {
      // Calm beside text: the paper never covers most of the sheet.
      expect(release.handling.coverage).toBeLessThanOrEqual(0.6)
    }
  })

  it('makes a piece for a release it has never seen, without a manifest', { timeout: TIMEOUT }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'torn-paper-new-'))
    const notes = join(dir, 'v9.9.9.md')
    writeFileSync(
      notes,
      [
        "## What's Changed",
        '* Move the settings into their own menu',
        '* Retry the upload when the lock is lost',
        '* Agents share a review queue',
        '* Keep the focus ring inside the card',
        '',
      ].join('\n'),
    )

    generate(dir, ['--version', 'v9.9.9', '--notes', notes])

    expect(pieceFiles(dir)).toEqual(['v9.9.9-dark.svg', 'v9.9.9-light.svg'])
    expect(existsSync(join(dir, 'manifest.json'))).toBe(false)
  })

  it('refuses flags with no value instead of writing into the series', () => {
    const dir = mkdtempSync(join(tmpdir(), 'torn-paper-flags-'))

    expect(failure(['--out'])).toContain('--out needs a value')
    expect(failure(['--out', '', '--version', 'v1.0.0', '--notes', join(dir, 'notes.md')])).toContain(
      '--out needs a value',
    )
    expect(failure(['--version', 'v1.0.0', '--notes'])).toContain('--notes needs a value')
    expect(failure(['--version', 'v1.0.0'])).toContain('--version and --notes go together')
    expect(failure(['--notes', join(dir, 'notes.md')])).toContain('--version and --notes go together')
    expect(failure(['--bogus'])).toContain('Unknown argument: --bogus')
  })

  it('gives different releases visibly different handling', () => {
    const manifest = JSON.parse(readFileSync(join(COMMITTED, 'manifest.json'), 'utf8'))
    const handling = manifest.releases.map((release) => JSON.stringify(release.handling))
    const paper = manifest.releases.map((release) => JSON.stringify(release.paper))
    expect(new Set(handling).size).toBe(manifest.releases.length)
    expect(new Set(paper).size).toBe(manifest.releases.length)
  })
})
