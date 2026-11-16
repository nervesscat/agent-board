import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { PALETTE_HEXES, planPiece, readThemes, renderPiece, seedFor } from './tear.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/release-art/tear.mjs')
const COMMITTED = join(ROOT, 'src/assets/release-art/tear')
const VERSIONS = ['v0.2.2', 'v0.2.3', 'v0.2.4', 'v0.2.5']
const BUDGET = 150 * 1024
const TIMEOUT = 60_000

const NOTES = {
  hands: '* Agents share a thread\n* Lane verdicts from the human\n* Delegation notes for agent tools\n',
  precision: '* Focus rings\n* Cache the proxy\n* Keep the clock exact\n',
  wayfinding: '* Move the palette\n* Remove the menu\n* Split the instructions\n',
  pulse: '* Show progress jobs\n* Notify when a run stalls\n* Track the live state\n',
}

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

function sameBytes(a, b, file) {
  return readFileSync(join(a, file)).equals(readFileSync(join(b, file)))
}

describe('release artwork: tear', () => {
  it('writes the same bytes on every run', { timeout: TIMEOUT }, () => {
    const first = mkdtempSync(join(tmpdir(), 'tear-a-'))
    const second = mkdtempSync(join(tmpdir(), 'tear-b-'))
    generate(first)
    generate(second)

    const files = pieceFiles(first)
    expect(files.length).toBe(VERSIONS.length * 2)
    for (const file of [...files, 'manifest.json']) expect(sameBytes(first, second, file), file).toBe(true)
  })

  it('matches the pieces committed beside the app', { timeout: TIMEOUT }, () => {
    const fresh = mkdtempSync(join(tmpdir(), 'tear-committed-'))
    generate(fresh)

    expect(pieceFiles(fresh)).toEqual(pieceFiles(COMMITTED))
    for (const file of [...pieceFiles(fresh), 'manifest.json']) {
      expect(sameBytes(COMMITTED, fresh, file), file).toBe(true)
    }
  })

  it('keeps every piece 16:9, self-contained, without text and under the size budget', () => {
    for (const version of VERSIONS) {
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
      // Nothing that loads, runs, or needs a network, and no text drawn inside the artwork.
      expect(svg).not.toMatch(/<script|<image|<use|<foreignObject|<text|<tspan|<style|@import|xlink|href=/)
      expect(svg).not.toMatch(/url\((?!#)/)
      expect(svg.match(/https?:\/\/[^"' ]+/g)).toEqual(['http://www.w3.org/2000/svg'])
      expect(svg).not.toMatch(/NaN|Infinity|undefined/)
    }
  })

  it('uses nothing but the declared palette, and no gradient', () => {
    const allowed = new Set(PALETTE_HEXES.map((hex) => hex.toUpperCase()))
    for (const file of pieceFiles(COMMITTED)) {
      const svg = readFileSync(join(COMMITTED, file), 'utf8')
      const colours = [...svg.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((match) => match[0].toUpperCase())
      expect(colours.length).toBeGreaterThan(0)
      for (const colour of colours) expect(allowed.has(colour), `${file} uses ${colour}`).toBe(true)
      expect(svg).not.toMatch(/Gradient/)
    }
  })

  it('reads a release as its themes, and lays the sheets by the strongest', () => {
    const lays = { hands: 'gather', precision: 'hold', wayfinding: 'clear', pulse: 'run' }
    for (const [theme, notes] of Object.entries(NOTES)) {
      const themes = readThemes(notes)
      expect(themes.lead).toBe(theme)
      expect(themes[theme]).toBe(1)
      expect(planPiece('v9.9.9', themes, 123456789).lay.name).toBe(lays[theme])
    }
  })

  it('lays each of the four releases its own way', () => {
    const manifest = JSON.parse(readFileSync(join(COMMITTED, 'manifest.json'), 'utf8'))
    expect(manifest.madeBy).toBe('Claude Fable 5.2')
    expect(manifest.releases.map((release) => release.version)).toEqual(VERSIONS)
    expect(manifest.releases.map((release) => release.lay.name)).toEqual(['gather', 'hold', 'clear', 'run'])
    for (const release of manifest.releases) {
      // The accent scrap lies on the canvas, clear of its edge.
      expect(release.accent[0]).toBeGreaterThan(80)
      expect(release.accent[0]).toBeLessThan(1520)
      expect(release.accent[1]).toBeGreaterThan(60)
      expect(release.accent[1]).toBeLessThan(840)
    }
  })

  it('tears a precise release cleaner than a release of many hands', () => {
    const precise = planPiece('v9.9.9', readThemes(NOTES.precision), 7)
    const many = planPiece('v9.9.9', readThemes(NOTES.hands), 7)
    expect(precise.tear.amp).toBeLessThan(many.tear.amp)
    // The tear still reads at a third of the size: it wanders by more than a device pixel there.
    expect(precise.tear.amp / 3).toBeGreaterThanOrEqual(1)
  })

  it('gives two versions with the same notes two different pieces', () => {
    const themes = readThemes(NOTES.wayfinding)
    const one = renderPiece(planPiece('v9.9.8', themes, seedFor('v9.9.8')), 'light')
    const other = renderPiece(planPiece('v9.9.9', themes, seedFor('v9.9.9')), 'light')
    const again = renderPiece(planPiece('v9.9.9', themes, seedFor('v9.9.9')), 'light')
    expect(other).not.toBe(one)
    expect(again).toBe(other)
  })

  it('stays inside the rules for any notes and seed', () => {
    for (const notes of Object.values(NOTES)) {
      for (let i = 0; i < 12; i++) {
        const version = `v7.${i}.0`
        const plan = planPiece(version, readThemes(notes), seedFor(version))
        for (const variant of ['light', 'dark']) {
          const svg = renderPiece(plan, variant)
          expect(Buffer.byteLength(svg), `${version} ${plan.lay.name}`).toBeLessThan(BUDGET)
          expect(svg).not.toMatch(/NaN|Infinity|undefined|<text/)
        }
        expect(plan.accent[0]).toBeGreaterThan(0)
        expect(plan.accent[0]).toBeLessThan(1600)
        expect(plan.accent[1]).toBeGreaterThan(0)
        expect(plan.accent[1]).toBeLessThan(900)
      }
    }
  })

  it('makes a piece for a release it has never seen, without a manifest', { timeout: TIMEOUT }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'tear-new-'))
    const notes = join(dir, 'v9.9.9.md')
    writeFileSync(notes, `## What's Changed\n${NOTES.wayfinding}`)

    generate(dir, ['--version', 'v9.9.9', '--notes', notes])

    expect(pieceFiles(dir)).toEqual(['v9.9.9-dark.svg', 'v9.9.9-light.svg'])
    expect(existsSync(join(dir, 'manifest.json'))).toBe(false)
  })

  it('refuses flags with no value instead of writing into the series', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tear-flags-'))

    expect(failure(['--out'])).toContain('--out needs a value')
    expect(failure(['--version', 'v1.0.0', '--notes'])).toContain('--notes needs a value')
    expect(failure(['--version', 'v1.0.0'])).toContain('--version and --notes go together')
    expect(failure(['--notes', join(dir, 'notes.md')])).toContain('--version and --notes go together')
    expect(failure(['--bogus'])).toContain('Unknown argument: --bogus')
  })
})
