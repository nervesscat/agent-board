import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { PALETTE_HEXES, buildRelease, leadingTheme, planPiece, readThemes, seedFor } from './strike.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/release-art/strike.mjs')
const COMMITTED = join(ROOT, 'src/assets/release-art/strike')
const VERSIONS = ['v0.2.2', 'v0.2.3', 'v0.2.4', 'v0.2.5']
const BUDGET = 150 * 1024
const TIMEOUT = 60_000

const WAYFINDING = '* Move the palette into the menu\n* Remove the card\n* Split the settings\n'
const PRECISION = '* Focus rings inside their items\n* Cache the proxy\n* Keep the clock exact\n'
const HANDS =
  '* Agents share a ticket\n* Agent tools and lane verdicts\n* Reviews and replies on every post\n'
const MOMENTUM = '* Show long jobs as progress\n* Retry the run\n* Speed up the pipeline\n'

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

function roles(plan) {
  return plan.runs.map((run) => run.role)
}

describe('release artwork: strike', () => {
  it('writes the same bytes on every run', { timeout: TIMEOUT }, () => {
    const first = mkdtempSync(join(tmpdir(), 'strike-a-'))
    const second = mkdtempSync(join(tmpdir(), 'strike-b-'))
    generate(first)
    generate(second)

    const files = pieceFiles(first)
    expect(files.length).toBe(VERSIONS.length * 2)
    for (const file of files) {
      expect(readFileSync(join(second, file)).equals(readFileSync(join(first, file)))).toBe(true)
    }
    expect(
      readFileSync(join(second, 'manifest.json')).equals(readFileSync(join(first, 'manifest.json'))),
    ).toBe(true)
  })

  it('matches the pieces committed beside the app', { timeout: TIMEOUT }, () => {
    const fresh = mkdtempSync(join(tmpdir(), 'strike-committed-'))
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
      // Every url() points at a filter defined in the same file.
      const defined = new Set([...svg.matchAll(/<filter id="([^"]+)"/g)].map((match) => match[1]))
      const used = [...svg.matchAll(/url\(([^)]*)\)/g)].map((match) => match[1])
      expect(used.length).toBeGreaterThan(0)
      for (const reference of used) {
        expect(reference.startsWith('#'), `${file} refers to ${reference}`).toBe(true)
        expect(defined.has(reference.slice(1)), `${file} refers to ${reference}`).toBe(true)
      }
    }
  })

  it('prints nothing but the declared palette', () => {
    const allowed = new Set(PALETTE_HEXES.map((hex) => hex.toUpperCase()))
    for (const file of pieceFiles(COMMITTED)) {
      const svg = readFileSync(join(COMMITTED, file), 'utf8')
      const colours = [...svg.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((match) => match[0].toUpperCase())
      expect(colours.length).toBeGreaterThan(0)
      for (const colour of colours) expect(allowed.has(colour), `${file} uses ${colour}`).toBe(true)
      // A ground and at most three inks.
      expect(new Set(colours).size).toBeLessThanOrEqual(4)
    }
  })

  it('reads a release as its themes', () => {
    expect(leadingTheme(readThemes(WAYFINDING))).toBe('wayfinding')
    expect(leadingTheme(readThemes(PRECISION))).toBe('precision')
    expect(leadingTheme(readThemes(HANDS))).toBe('hands')
    expect(leadingTheme(readThemes(MOMENTUM))).toBe('momentum')
    // The author and the link at the end of a bullet are not part of what the release says.
    const tail = readThemes('* Tidy a label by @agent-run in https://example.test/agent/run/1\n')
    expect(tail.hands).toBe(0.25)
    expect(tail.momentum).toBe(0.25)
  })

  it('turns the themes into runs', () => {
    const wayfinding = planFor(WAYFINDING)
    expect(wayfinding.blinds.length).toBe(1)
    expect(roles(wayfinding)).toContain('reset')
    expect(roles(wayfinding)).toContain('lane')

    const precision = planFor(PRECISION)
    expect(precision.blinds.length).toBe(0)
    expect(roles(precision)).toContain('keyline')
    expect(roles(precision)).toContain('register')
    expect(precision.trueness).toBeGreaterThan(wayfinding.trueness)
    expect(Math.abs(precision.axis)).toBeLessThan(Math.abs(wayfinding.axis))

    const hands = planFor(HANDS)
    expect(roles(hands).filter((role) => role === 'hand').length).toBeGreaterThanOrEqual(3)
    expect(new Set(hands.runs.map((run) => run.ink)).size).toBe(3)

    const momentum = planFor(MOMENTUM)
    expect(roles(momentum).filter((role) => role === 'job').length).toBe(2)
    const primary = momentum.runs.find((run) => run.role === 'primary')
    // Inked again part way: somewhere the load goes back up.
    expect(
      primary.strikes.some((strike, index) => index > 0 && strike.load > primary.strikes[index - 1].load),
    ).toBe(true)
  })

  it('lets the ink give out along a run, and keeps the primary run on the sheet', () => {
    for (const notes of [WAYFINDING, PRECISION, HANDS, MOMENTUM]) {
      for (const seed of [1, 22, 333, 4444, 55555]) {
        const plan = planPiece('v9.9.9', readThemes(notes), seed)
        for (const run of plan.runs) {
          expect(run.strikes.length).toBeGreaterThanOrEqual(2)
          expect(run.strikes.at(-1).load).toBeLessThan(run.strikes[0].load + 1e-9)
          for (const strike of run.strikes) {
            expect(strike.load).toBeGreaterThan(0)
            expect(strike.load).toBeLessThanOrEqual(1)
          }
        }
        for (const run of plan.runs.filter((run) => run.role === 'primary' || run.role === 'reset')) {
          for (const strike of run.strikes) {
            expect(strike.x).toBeGreaterThan(0)
            expect(strike.x).toBeLessThan(1600)
            expect(strike.y).toBeGreaterThan(0)
            expect(strike.y).toBeLessThan(900)
          }
        }
      }
    }
  })

  it('seeds a piece by its version', () => {
    expect(seedFor('v0.2.5')).toBe(seedFor('v0.2.5'))
    expect(seedFor('v0.2.5')).not.toBe(seedFor('v0.2.6'))
    const notes = readFileSync(join(ROOT, 'scripts/release-art/notes/v0.2.5.md'), 'utf8')
    expect(buildRelease('v0.2.5', notes).light).toBe(buildRelease('v0.2.5', notes).light)
    expect(buildRelease('v0.2.5', notes).light).not.toBe(buildRelease('v0.2.6', notes).light)
    expect(buildRelease('v0.2.5', notes).light).toBe(
      readFileSync(join(COMMITTED, 'v0.2.5-light.svg'), 'utf8'),
    )
  })

  it('makes the next release from its notes alone', { timeout: TIMEOUT }, () => {
    const out = mkdtempSync(join(tmpdir(), 'strike-next-'))
    const notes = join(out, 'next.md')
    writeFileSync(notes, MOMENTUM)
    generate(out, ['--version', 'v0.2.6', '--notes', notes])

    expect(pieceFiles(out)).toEqual(['v0.2.6-dark.svg', 'v0.2.6-light.svg'])
    expect(existsSync(join(out, 'manifest.json'))).toBe(false)
    for (const file of pieceFiles(out)) {
      expect(Buffer.byteLength(readFileSync(join(out, file)))).toBeLessThan(BUDGET)
    }
  })

  it('refuses arguments it cannot use', () => {
    expect(failure(['--version', '0.2.6'])).toMatch(/must look like v0\.2\.6/)
    expect(failure(['--version', 'v9.9.9'])).toMatch(/no notes for v9\.9\.9/)
    expect(failure(['--notes', 'x.md'])).toMatch(/--notes needs --version/)
    expect(failure(['--colour'])).toMatch(/unknown argument/)
  })
})
