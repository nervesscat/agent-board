import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  DYES,
  GRAMMARS,
  PALETTE_HEXES,
  parseVersion,
  planPiece,
  readThemes,
  renderPiece,
  seedFor,
  thematicFor,
  variationFor,
} from './tear.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/release-art/tear.mjs')
const COMMITTED = join(ROOT, 'src/assets/release-art/tear')
const REAL = ['v0.2.2', 'v0.2.3', 'v0.2.4', 'v0.2.5']
const MATRIX = ['v0.1.0', 'v0.2.0', 'v0.3.0', 'v1.1.0', 'v1.2.0', 'v1.3.0']
const STAND_INS = ['v0.1.0', 'v0.3.0', 'v1.1.0', 'v1.2.0', 'v1.3.0']
const VERSIONS = ['v0.1.0', 'v0.2.0', ...REAL, 'v0.3.0', 'v1.1.0', 'v1.2.0', 'v1.3.0']
// The four pieces as they were approved, before a version meant anything: minor 2 of major 0 is
// the system's reference point, so they must come out unchanged.
const APPROVED = {
  'v0.2.2-dark.svg': 'cba63d8d95f273b0087518e2c48b4da905082ec461ea3539476bb1e355631aa9',
  'v0.2.2-light.svg': 'bcc7e76972a28633d5b1a212f341b79d1018e96fae31a245f4a5f22b479ce27f',
  'v0.2.3-dark.svg': '1e4a3a2537f3a40f7f44da02115d9c1ec6d7fdc7f7e1cf2347b34bc75324ee0e',
  'v0.2.3-light.svg': 'd3acaddc2b3d2aca4d05954e2e06088b15a62c4cb9ff26179886515ccc0d86e7',
  'v0.2.4-dark.svg': '33f07614fb197455b54dc1f6279688abb74a36a0a24fea8bee0d43fd0f59a141',
  'v0.2.4-light.svg': 'cfb28aee03366b8fbe7cd36aa36dea0552b047c49f7aa55cf9c7fd4ecfa587f3',
  'v0.2.5-dark.svg': '1a39071c353d5442de516eeef85a7d77fa3ee1264db9caffe88a9b409e76aa85',
  'v0.2.5-light.svg': 'f58c23e363cd8c8322994ead7ae0690ab2a51339d624eadf39c6bccb6febe614',
}
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
    const real = manifest.releases.filter((release) => REAL.includes(release.version))
    expect(real.map((release) => release.lay.name)).toEqual(['gather', 'hold', 'clear', 'run'])
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
      for (let i = 0; i < 24; i++) {
        const version = `v${i % 4}.${i}.${i % 3}`
        const plan = planPiece(version, readThemes(notes), seedFor(version))
        for (const variant of ['light', 'dark']) {
          const svg = renderPiece(plan, variant)
          expect(Buffer.byteLength(svg), `${version} ${plan.lay.name}`).toBeLessThan(BUDGET)
          expect(svg).not.toMatch(/NaN|Infinity|undefined|<text/)
          const allowed = new Set(PALETTE_HEXES)
          for (const [colour] of svg.matchAll(/#[0-9a-fA-F]{6}\b/g)) {
            expect(allowed.has(colour.toUpperCase()), `${version} uses ${colour}`).toBe(true)
          }
        }
        expect(plan.accent[0]).toBeGreaterThan(0)
        expect(plan.accent[0]).toBeLessThan(1600)
        expect(plan.accent[1]).toBeGreaterThan(0)
        expect(plan.accent[1]).toBeLessThan(900)
      }
    }
  })

  it('reads a version as major, minor and patch, and refuses anything else', () => {
    expect(parseVersion('v0.2.5')).toEqual({ major: 0, minor: 2, patch: 5, pre: '' })
    expect(parseVersion('1.12.0')).toEqual({ major: 1, minor: 12, patch: 0, pre: '' })
    expect(parseVersion(' v2.0.1-rc.1 ')).toEqual({ major: 2, minor: 0, patch: 1, pre: 'rc.1' })
    expect(parseVersion('v3.4.5+build.7')).toEqual({ major: 3, minor: 4, patch: 5, pre: '' })
    for (const bad of ['', 'v1', 'v1.2', 'v1.2.x', '1.2.3.4', 'vv1.2.3', 'latest', 'v-1.2.3', 'v1.2.3-']) {
      expect(() => parseVersion(bad), bad).toThrow(/Not a version/)
    }
    expect(() => planPiece('next', readThemes(NOTES.hands), 1)).toThrow(/Not a version/)
    expect(failure(['--version', 'next', '--notes', SCRIPT])).toContain('Not a version: next')
  })

  it('gives every major its own thematic: two majors differ in grammar or dyes', () => {
    const declared = (major) => {
      const { grammar, axis, ground, dyes, deep, pale } = thematicFor(major)
      return JSON.stringify({ grammar, axis, ground, dyes, deep, pale })
    }
    const cycle = GRAMMARS.length * DYES.length
    const seen = new Set(Array.from({ length: cycle }, (_, major) => declared(major)))
    expect(seen.size).toBe(cycle)

    const zero = thematicFor(0)
    const one = thematicFor(1)
    expect([zero.name, one.name]).toEqual(['Loose', 'Coursed'])
    expect(zero.meaning).not.toBe('')
    expect(one.meaning).not.toBe('')
    // Majors 0 and 1 differ in every declared parameter, not in one.
    for (const key of ['grammar', 'axis', 'ground', 'dyes']) expect(zero[key], key).not.toBe(one[key])
    for (const variant of ['light', 'dark']) {
      expect(zero.deep[variant]).not.toBe(one.deep[variant])
      expect(zero.pale[variant]).not.toBe(one.pale[variant])
    }
    // The style's own colours are no thematic's to change.
    expect(zero.accent).toBe(one.accent)
    // A major nobody has named still gets a thematic: major 2 is unlike 0 and unlike 1.
    const two = thematicFor(2)
    expect(two.grammar).toBe(zero.grammar)
    expect(two.dyes).not.toBe(zero.dyes)
    expect(two.dyes).not.toBe(one.dyes)
    expect(two.name).not.toBe('')
  })

  it('gives every minor of a major its own variation: bath and bearing', () => {
    for (const major of [0, 1, 2, 3]) {
      const declared = (minor) => {
        const { bath, bearing, pale } = variationFor(major, minor)
        return JSON.stringify({ bath, bearing, pale })
      }
      expect(new Set(Array.from({ length: 10 }, (_, minor) => declared(minor))).size, `major ${major}`).toBe(
        10,
      )
      // Minors 1, 2 and 3 differ in both parameters, and the pale dye deepens in order.
      const [first, second, third] = [1, 2, 3].map((minor) => variationFor(major, minor))
      expect(new Set([first.bath, second.bath, third.bath]).size).toBe(3)
      expect(new Set([first.bearing, second.bearing, third.bearing]).size).toBe(3)
      expect(first.bath).toBeLessThan(second.bath)
      expect(second.bath).toBeLessThan(third.bath)
      expect(first.bearing).toBeLessThan(second.bearing)
      expect(second.bearing).toBeLessThan(third.bearing)
      for (const variant of ['light', 'dark']) {
        expect(new Set([first, second, third].map((v) => v.pale[variant])).size).toBe(3)
        // The deep dye anchors the thematic: no minor moves it.
        const plans = [1, 2, 3].map((minor) => planPiece(`v${major}.${minor}.0`, readThemes(NOTES.hands), 5))
        expect(new Set(plans.map((plan) => plan.inks[variant].a)).size).toBe(1)
        expect(plans.map((plan) => plan.inks[variant].b)).toEqual(
          [first, second, third].map((v) => v.pale[variant]),
        )
      }
    }
    // Minor 2 of major 0 is the reference: the approved dyes, nothing turned.
    expect(variationFor(0, 2)).toMatchObject({
      bath: 2,
      bearing: 0,
      pale: { light: '#9CB7A6', dark: '#638A79' },
    })
  })

  it('lays a major by its grammar and a minor by its variation, whatever the notes', () => {
    for (const notes of Object.values(NOTES)) {
      const themes = readThemes(notes)
      expect(planPiece('v0.4.1', themes, 9).lay.grammar).toBe('loose')
      expect(planPiece('v1.4.1', themes, 9).lay.grammar).toBe('coursed')
      // The same notes and seed in two minors: the same lay, and a different piece.
      const one = planPiece('v1.1.0', themes, 9)
      const two = planPiece('v1.2.0', themes, 9)
      expect(two.lay.name).toBe(one.lay.name)
      expect(two.lay.lean).not.toBe(one.lay.lean)
      expect(renderPiece(two, 'light')).not.toBe(renderPiece(one, 'light'))
    }
  })

  it('renders the matrix, marks the stand-ins and leaves the approved pieces as they were', () => {
    const manifest = JSON.parse(readFileSync(join(COMMITTED, 'manifest.json'), 'utf8'))
    const byVersion = Object.fromEntries(manifest.releases.map((release) => [release.version, release]))
    for (const version of MATRIX) {
      const { major, minor } = parseVersion(version)
      expect(byVersion[version].thematic).toBe(thematicFor(major).name)
      expect(byVersion[version].variation.minor).toBe(minor)
      expect(byVersion[version].lay.grammar).toBe(major === 0 ? 'loose' : 'coursed')
    }
    for (const release of manifest.releases) {
      const standIn = STAND_INS.includes(release.version)
      expect(release.standIn, release.version).toBe(standIn)
      const notes = readFileSync(join(ROOT, release.notes), 'utf8')
      expect(/^<!--\s*stand-in/.test(notes), release.version).toBe(standIn)
    }
    expect(manifest.thematics.map((thematic) => thematic.name)).toEqual(['Loose', 'Coursed'])
    for (const [file, hash] of Object.entries(APPROVED)) {
      expect(
        createHash('sha256')
          .update(readFileSync(join(COMMITTED, file)))
          .digest('hex'),
        file,
      ).toBe(hash)
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

  it('gives every spelling of a version the same bytes as the canonical one', { timeout: TIMEOUT }, () => {
    const clean = mkdtempSync(join(tmpdir(), 'tear-clean-'))
    const notes = join(clean, 'v9.9.9.md')
    writeFileSync(notes, `## What's Changed\n${NOTES.wayfinding}`)
    generate(clean, ['--version', 'v9.9.9', '--notes', notes])

    for (const spelling of ['v9.9.9 ', '9.9.9', 'v9.9.9+build.5']) {
      const other = mkdtempSync(join(tmpdir(), 'tear-spelling-'))
      generate(other, ['--version', spelling, '--notes', notes])
      expect(pieceFiles(other)).toEqual(pieceFiles(clean))
      for (const name of pieceFiles(clean)) {
        expect(readFileSync(join(other, name))).toEqual(readFileSync(join(clean, name)))
      }
    }
  })

  it('refuses notes with no theme lines, empty or prose only, instead of drawing a piece', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tear-empty-'))
    const empty = join(dir, 'empty.md')
    const prose = join(dir, 'prose.md')
    writeFileSync(empty, '')
    writeFileSync(prose, 'A paragraph of prose with no bullets or headings.\n')

    expect(failure(['--version', 'v9.9.9', '--notes', empty])).toContain('No theme lines')
    expect(failure(['--version', 'v9.9.9', '--notes', prose])).toContain('No theme lines')
    expect(() => readThemes('')).toThrow('No theme lines')
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
