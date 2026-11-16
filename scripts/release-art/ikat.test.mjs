import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { PALETTE_HEXES, THREADS, planPiece, readThemes, renderPiece, seedOf } from './ikat.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/release-art/ikat.mjs')
const COMMITTED = join(ROOT, 'src/assets/release-art/ikat')
const RELEASES = ['v0.2.2', 'v0.2.3', 'v0.2.4', 'v0.2.5']
const BUDGET = 150 * 1024
const TIMEOUT = 60_000

function generate(out, extra = []) {
  return execFileSync(process.execPath, [SCRIPT, '--out', out, ...extra], { cwd: ROOT, encoding: 'utf8' })
}

function pieceFiles(dir) {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.svg'))
    .sort()
}

function same(a, b) {
  return readFileSync(a).equals(readFileSync(b))
}

describe('release artwork: ikat', () => {
  it('writes the same bytes on every run', { timeout: TIMEOUT }, () => {
    const first = mkdtempSync(join(tmpdir(), 'ikat-a-'))
    const second = mkdtempSync(join(tmpdir(), 'ikat-b-'))
    generate(first)
    generate(second)

    const files = pieceFiles(first)
    expect(files).toEqual(RELEASES.flatMap((version) => [`${version}-dark.svg`, `${version}-light.svg`]))
    for (const file of [...files, 'manifest.json']) {
      expect(same(join(first, file), join(second, file)), file).toBe(true)
    }
  })

  it('matches the pieces committed beside the app', { timeout: TIMEOUT }, () => {
    const fresh = mkdtempSync(join(tmpdir(), 'ikat-committed-'))
    generate(fresh)

    expect(pieceFiles(fresh)).toEqual(pieceFiles(COMMITTED))
    for (const file of [...pieceFiles(fresh), 'manifest.json']) {
      expect(same(join(COMMITTED, file), join(fresh, file)), file).toBe(true)
    }
  })

  it('keeps every piece 16:9, self-contained, without text and under the size budget', () => {
    for (const file of pieceFiles(COMMITTED)) {
      const svg = readFileSync(join(COMMITTED, file), 'utf8')
      expect(Buffer.byteLength(svg), file).toBeLessThan(BUDGET)
      expect(svg, file).toContain('viewBox="0 0 1600 900"')
      expect(svg, file).not.toMatch(/<(text|tspan|textPath|image|use|foreignObject|script|style|a)[\s>]/)
      expect(svg, file).not.toMatch(/font-family|@import|xlink:href/)
      // The only address in the file is the SVG namespace; every other reference is to its own defs.
      expect(svg.replaceAll('http://www.w3.org/2000/svg', ''), file).not.toMatch(/https?:|data:|\/\//)
      for (const [, target] of svg.matchAll(/url\(([^)]*)\)/g)) expect(target, file).toMatch(/^#[a-z]$/)
      expect(svg.match(/href=/g), file).toBeNull()
    }
  })

  it('uses only the palette', () => {
    const allowed = new Set(PALETTE_HEXES)
    expect(allowed.size).toBe(5)
    for (const file of pieceFiles(COMMITTED)) {
      const svg = readFileSync(join(COMMITTED, file), 'utf8')
      for (const [hex] of svg.matchAll(/#[0-9A-Fa-f]{6}\b/g))
        expect(allowed.has(hex), `${file} ${hex}`).toBe(true)
    }
  })

  it('gives each release its own binding from its own notes', () => {
    const plans = RELEASES.map((version) => {
      const notes = readFileSync(join(ROOT, 'scripts/release-art/notes', `${version}.md`), 'utf8')
      return planPiece(version, readThemes(notes), seedOf(version))
    })
    expect(new Set(plans.map((plan) => JSON.stringify(plan.binding))).size).toBe(RELEASES.length)
    expect(new Set(plans.map((plan) => plan.seed)).size).toBe(RELEASES.length)
    for (const plan of plans) {
      for (const block of plan.blocks) {
        expect(block.from).toBeLessThan(block.to)
        expect(block.y0).toBeLessThan(block.y1)
      }
      expect(plan.field.first).toBeLessThan(THREADS)
    }
  })

  it('reads the notes: a tight release is bound tighter than a loose one', () => {
    const tight = readThemes(
      '* Fix the focus ring\n* Keep the header sticky\n* Cap the list\n* Remember the stage\n',
    )
    const loose = readThemes(
      Array.from({ length: 60 }, (_, n) => `* Let agents review pull request ${n}, restart what fails`).join(
        '\n',
      ),
    )
    const a = planPiece('v9.9.9', tight, 123456789).binding
    const b = planPiece('v9.9.9', loose, 123456789).binding
    expect(a.slip).toBeLessThan(b.slip)
    expect(a.courses).toBeLessThan(b.courses)
    expect(a.stagger).toBeLessThan(b.stagger)
    expect(a.rows).toBeLessThanOrEqual(b.rows)
  })

  it('draws notes with no changelog items at all', () => {
    const plan = planPiece('v9.9.9', readThemes('Nothing to say.\n'), seedOf('v9.9.9'))
    expect(plan.blocks.length).toBeGreaterThan(0)
    for (const mode of ['light', 'dark']) {
      const svg = renderPiece(plan, mode)
      expect(svg).not.toMatch(/NaN|undefined|Infinity/)
      expect(Buffer.byteLength(svg)).toBeLessThan(BUDGET)
    }
  })

  it(
    'renders one unseen release from its notes without touching the series manifest',
    { timeout: TIMEOUT },
    () => {
      const out = mkdtempSync(join(tmpdir(), 'ikat-next-'))
      const notes = join(out, 'next.md')
      writeFileSync(
        notes,
        '* Move the tag filter into the header\n* Fix a flaky test\n* Let agents share a ticket\n',
      )
      generate(out, ['--version', '0.3.0', '--notes', notes])
      expect(pieceFiles(out)).toEqual(['v0.3.0-dark.svg', 'v0.3.0-light.svg'])
      expect(readdirSync(out)).not.toContain('manifest.json')
    },
  )

  it('never leaves NaN or a missing value in a committed piece', () => {
    for (const file of pieceFiles(COMMITTED)) {
      expect(readFileSync(join(COMMITTED, file), 'utf8'), file).not.toMatch(/NaN|undefined|Infinity/)
    }
  })
})
