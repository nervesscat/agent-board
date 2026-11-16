import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { PALETTE_HEXES, planPiece, readThemes, renderPiece, rulePass, seedFor } from './burin.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/release-art/burin.mjs')
const NOTES = join(ROOT, 'scripts/release-art/notes')
const COMMITTED = join(ROOT, 'src/assets/release-art/burin')
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

function committedPlan(version) {
  return planPiece(version, readThemes(readFileSync(join(NOTES, `${version}.md`), 'utf8')))
}

describe('release artwork: burin', () => {
  it('writes the same bytes on every run', { timeout: TIMEOUT }, () => {
    const first = mkdtempSync(join(tmpdir(), 'burin-a-'))
    const second = mkdtempSync(join(tmpdir(), 'burin-b-'))
    generate(first)
    generate(second)

    const files = pieceFiles(first)
    expect(files.length).toBe(VERSIONS.length * 2)
    for (const file of [...files, 'manifest.json']) {
      expect(readFileSync(join(second, file)).equals(readFileSync(join(first, file)))).toBe(true)
    }
  })

  it('matches the pieces committed beside the app', { timeout: TIMEOUT }, () => {
    const fresh = mkdtempSync(join(tmpdir(), 'burin-committed-'))
    generate(fresh)

    expect(pieceFiles(fresh)).toEqual(pieceFiles(COMMITTED))
    for (const file of [...pieceFiles(fresh), 'manifest.json']) {
      expect(readFileSync(join(COMMITTED, file)).equals(readFileSync(join(fresh, file)))).toBe(true)
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
      expect(Buffer.byteLength(svg)).toBeLessThan(BUDGET)
      // Nothing that loads, runs, or needs a network, and no text drawn inside the artwork.
      expect(svg).not.toMatch(/<script|<image|<use|<foreignObject|<text|<tspan|<style|@import|xlink|href=/)
      expect(svg.match(/https?:\/\/[^"' ]+/g)).toEqual(['http://www.w3.org/2000/svg'])
      for (const reference of svg.matchAll(/url\(([^)]*)\)/g)) expect(reference[1]).toMatch(/^#[a-z]$/)
    }
  })

  it('draws nothing but ruled strokes in the declared palette', () => {
    const allowed = new Set(PALETTE_HEXES.map((hex) => hex.toUpperCase()))
    for (const file of pieceFiles(COMMITTED)) {
      const svg = readFileSync(join(COMMITTED, file), 'utf8')
      const colours = [...svg.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((match) => match[0].toUpperCase())
      expect(colours.length).toBeGreaterThan(2)
      for (const colour of colours) expect(allowed.has(colour), `${file} uses ${colour}`).toBe(true)
      // Straight strokes only: a move, relative lines and a close. No curve or arc on the plate.
      for (const path of svg.matchAll(/ d="([^"]*)"/g)) expect(path[1]).toMatch(/^[Mlz\d .-]+$/)
      expect(svg).not.toMatch(/<circle|<ellipse|<polygon|<line|Gradient/)
    }
  })

  it('reads a release as its themes', () => {
    const wayfinding = readThemes('* Move the palette\n* Remove the menu\n* Split the settings\n')
    const precision = readThemes('* Focus rings\n* Cache the proxy\n* Keep the clock exact\n')
    const hands = readThemes('* Project agents\n* Lanes shared by a team\n* A review queue\n')

    expect(wayfinding.wayfinding).toBeGreaterThan(wayfinding.precision)
    expect(precision.precision).toBeGreaterThan(precision.wayfinding)
    expect(hands.hands).toBeGreaterThan(hands.precision)
    expect(readThemes('')).toMatchObject({ lines: 0, volume: 0 })

    const held = planPiece('v9.9.9', precision)
    const cleared = planPiece('v9.9.9', wayfinding)
    const crowded = planPiece('v9.9.9', hands)
    expect(held.edge.strength).toBe(1)
    expect(held.path.strength).toBe(0)
    expect(held.count).toBe(2)
    expect(cleared.path.strength).toBe(1)
    expect(cleared.edge.strength).toBe(0)
    expect(crowded.count).toBe(3)
    expect(held.wobble).toBeLessThan(crowded.wobble)
    expect(held.passes[0].pitch).toBeLessThan(crowded.passes[0].pitch)
  })

  it('gives the four releases four different plates', () => {
    const plans = VERSIONS.map(committedPlan)
    expect(plans.map((plan) => plan.count)).toEqual([3, 2, 3, 3])
    expect(plans[1].edge.strength).toBe(1)
    expect(plans[2].path.strength).toBe(1)
    expect(plans[0].edge.strength).toBe(0)
    expect(plans[3].path.strength).toBe(0)
    expect(new Set(plans.map((plan) => plan.passes[0].angle)).size).toBe(4)
  })

  it('plans and rules from the seed alone', () => {
    const themes = readThemes('* Move the palette\n* Project agents\n')
    const first = planPiece('v9.9.9', themes, 424242)
    expect(planPiece('v9.9.9', themes, 424242)).toEqual(first)
    expect(planPiece('v9.9.9', themes, 424243)).not.toEqual(first)
    expect(seedFor('v0.2.2')).not.toBe(seedFor('v0.2.3'))
    expect(rulePass(first, 0)).toEqual(rulePass(first, 0))
    expect(rulePass(first, 0).length).toBeGreaterThan(20)
    expect(renderPiece(first, 'dark')).toBe(renderPiece(first, 'dark'))
    expect(renderPiece(first, 'dark')).not.toBe(renderPiece(first, 'light'))
  })

  it('draws a release nobody has seen from its notes file', { timeout: TIMEOUT }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'burin-next-'))
    const notes = join(dir, 'v0.3.0.md')
    writeFileSync(notes, '* Move the board\n* Cache the queue\n* Shared lanes for agents\n')
    generate(dir, ['--version', 'v0.3.0', '--notes', notes])

    expect(pieceFiles(dir)).toEqual(['v0.3.0-dark.svg', 'v0.3.0-light.svg'])
    for (const file of pieceFiles(dir)) {
      expect(Buffer.byteLength(readFileSync(join(dir, file)))).toBeLessThan(BUDGET)
    }
    // Empty notes still give a piece: an even reading of the themes.
    writeFileSync(notes, '')
    generate(dir, ['--version', 'v0.3.0', '--notes', notes])
    expect(readFileSync(join(dir, 'v0.3.0-light.svg'), 'utf8')).toContain('<path')
  })

  it('refuses arguments it does not understand', () => {
    expect(failure(['--version', 'v0.3.0'])).toContain('--version and --notes go together')
    expect(failure(['--version', 'next', '--notes', 'x.md'])).toContain('Not a release version')
    expect(failure(['--colour', 'red'])).toContain('Unknown option')
    expect(failure(['--out'])).toContain('needs a value')
  })
})
