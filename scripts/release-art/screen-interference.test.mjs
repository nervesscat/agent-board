import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  PALETTE,
  PALETTE_HEXES,
  PITCH,
  STYLE_INKS,
  THEMATICS,
  chapterOf,
  isStandIn,
  parseVersion,
  planPiece,
  readThemes,
  renderPiece,
  thematicFor,
  variationFor,
} from './screen-interference.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/release-art/screen-interference.mjs')
const COMMITTED = join(ROOT, 'src/assets/release-art/screen-interference')
const BUDGET = 150 * 1024
const TIMEOUT = 60_000
const MATRIX = ['v0.1.0', 'v0.2.0', 'v0.3.0', 'v1.1.0', 'v1.2.0', 'v1.3.0']
const REAL = ['v0.2.0', 'v0.2.2', 'v0.2.3', 'v0.2.4', 'v0.2.5']
const STAND_INS = ['v0.1.0', 'v0.3.0', 'v1.1.0', 'v1.2.0', 'v1.3.0']
const SERIES = [
  'v0.1.0',
  'v0.2.0',
  'v0.2.2',
  'v0.2.3',
  'v0.2.4',
  'v0.2.5',
  'v0.3.0',
  'v1.1.0',
  'v1.2.0',
  'v1.3.0',
]
const NOTES = join(ROOT, 'scripts/release-art/notes')

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

function planFor(notes, version = 'v0.2.9') {
  return planPiece(version, readThemes(notes), 123456789)
}

function manifest() {
  return JSON.parse(readFileSync(join(COMMITTED, 'manifest.json'), 'utf8'))
}

// What a thematic declares, without its words: the guard compares form, not names.
function declared(thematic) {
  const { axis, accent, arc, beats, hold, pair } = thematic
  return JSON.stringify({ axis, accent, arc, beats, hold, pair: pair || null })
}

function variationParams(variation) {
  const { minor: _minor, chapter: _chapter, ...params } = variation
  return JSON.stringify(params)
}

describe('release artwork: screen interference', () => {
  it('writes the same bytes on every run', { timeout: TIMEOUT }, () => {
    const first = mkdtempSync(join(tmpdir(), 'screen-interference-a-'))
    const second = mkdtempSync(join(tmpdir(), 'screen-interference-b-'))
    generate(first)
    generate(second)

    const files = pieceFiles(first)
    expect(files.length).toBe(SERIES.length * 2)
    for (const file of [...files, 'manifest.json']) {
      expect(readFileSync(join(second, file)).equals(readFileSync(join(first, file)))).toBe(true)
    }
  })

  it('matches the pieces committed beside the app', { timeout: TIMEOUT }, () => {
    const fresh = mkdtempSync(join(tmpdir(), 'screen-interference-committed-'))
    generate(fresh)

    expect(pieceFiles(fresh)).toEqual(pieceFiles(COMMITTED))
    for (const file of [...pieceFiles(fresh), 'manifest.json']) {
      expect(readFileSync(join(COMMITTED, file)).equals(readFileSync(join(fresh, file))), file).toBe(true)
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
      // Nothing that loads, runs or reaches a network, and no text drawn inside the artwork.
      expect(svg).not.toMatch(/<script|<image|<use|<foreignObject|<text|<tspan|<style|xlink|href=|@import/i)
      expect(svg.match(/https?:\/\/[^"' ]+/g)).toEqual(['http://www.w3.org/2000/svg'])
      // The only url() references are the piece's own filters.
      for (const ref of svg.match(/url\([^)]*\)/g) || []) expect(ref).toMatch(/^url\(#[a-z]+-(dark|light)\)$/)
    }
  })

  it('prints nothing but the declared palette', () => {
    const allowed = new Set(PALETTE_HEXES.map((hex) => hex.toUpperCase()))
    for (const file of pieceFiles(COMMITTED)) {
      const svg = readFileSync(join(COMMITTED, file), 'utf8')
      const colours = [...svg.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0].toUpperCase())
      expect(colours.length).toBeGreaterThan(0)
      for (const colour of colours) expect(allowed.has(colour), `${file} uses ${colour}`).toBe(true)
    }
  })

  it('reads a release as its themes, and lets no more than two speak', () => {
    const wayfinding = '* Move the palette into the menu\n* Remove the card\n* Split the settings\n'
    const precision = '* Focus rings inside\n* Cache the proxy\n* Keep the clock exact\n'
    expect(readThemes(wayfinding).wayfinding).toBeGreaterThan(readThemes(wayfinding).precision)
    expect(readThemes(precision).precision).toBeGreaterThan(readThemes(precision).wayfinding)

    expect(planFor(wayfinding).lane).not.toBeNull()
    expect(planFor(wayfinding).edge).toBeNull()
    expect(planFor(precision).edge).not.toBeNull()
    expect(planFor(precision).lane).toBeNull()

    const manifest = JSON.parse(readFileSync(join(COMMITTED, 'manifest.json'), 'utf8'))
    for (const release of manifest.releases) expect(release.speaks.length).toBeLessThanOrEqual(2)
  })

  it('closes the screens for precision and opens them for many hands', () => {
    const precise = planFor('* Focus rings\n* Cache the proxy\n* Keep the clock exact\n* Cap the count\n')
    const hands = planFor(
      '* Agent tools\n* Lanes shared between agents\n* Review by agents\n* Delegate to workers\n',
    )
    const gap = (plan) => Math.abs(plan.plates[1].angle - plan.plates[0].angle)
    expect(gap(precise)).toBeLessThan(gap(hands))
    expect(precise.plates[1].warp).toBeLessThan(hands.plates[1].warp)
  })

  it('keeps the screen readable at a third of the size', () => {
    const manifest = JSON.parse(readFileSync(join(COMMITTED, 'manifest.json'), 'utf8'))
    // Six pixels between dots at a third: still a screen, not a grey wash.
    expect(PITCH / 3).toBeGreaterThanOrEqual(5.5)
    for (const release of manifest.releases) {
      for (const screen of release.screens) expect(screen.pitch / 3).toBeGreaterThanOrEqual(5.5)
      // Fringes wider than a dot at a third: at least two pitches between beats.
      const angles = release.screens.map((screen) => screen.angle)
      const gap = Math.abs(angles[1] - angles[0]) * (Math.PI / 180)
      expect(PITCH / (2 * Math.sin(gap / 2)) / PITCH).toBeGreaterThanOrEqual(8)
    }
  })

  it('renders the same plan to the same bytes', () => {
    const plan = planFor('* Move the palette\n')
    expect(renderPiece(plan, 'light').svg).toBe(renderPiece(plan, 'light').svg)
    expect(renderPiece(plan, 'dark').svg).not.toBe(renderPiece(plan, 'light').svg)
  })

  it(
    'makes a piece for a release it has never seen, without touching the manifest',
    { timeout: TIMEOUT },
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'screen-interference-new-'))
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

      generate(dir, ['--version', 'v9.9.9', '--notes', notes])

      expect(pieceFiles(dir)).toEqual(['v9.9.9-dark.svg', 'v9.9.9-light.svg'])
      expect(existsSync(join(dir, 'manifest.json'))).toBe(false)
      for (const file of pieceFiles(dir)) {
        expect(Buffer.byteLength(readFileSync(join(dir, file)))).toBeLessThan(BUDGET)
      }
    },
  )

  it('refuses flags with no value instead of writing into the series', () => {
    const dir = mkdtempSync(join(tmpdir(), 'screen-interference-flags-'))

    expect(failure(['--out'])).toContain('--out needs a value')
    expect(failure(['--version', 'v1.0.0', '--notes'])).toContain('--notes needs a value')
    expect(failure(['--version', 'v1.0.0'])).toContain('--version and --notes go together')
    expect(failure(['--notes', join(dir, 'notes.md')])).toContain('--version and --notes go together')
    expect(failure(['--bogus'])).toContain('Unknown argument: --bogus')
  })

  it('gives each release its own screens and composition', () => {
    const manifest = JSON.parse(readFileSync(join(COMMITTED, 'manifest.json'), 'utf8'))
    expect(manifest.releases.map((release) => release.version)).toEqual(SERIES)
    const screens = manifest.releases.map((release) => JSON.stringify(release.screens))
    expect(new Set(screens).size).toBe(manifest.releases.length)
    const gestures = manifest.releases.map((release) =>
      JSON.stringify([release.edge, release.lane, release.ramp]),
    )
    expect(new Set(gestures).size).toBeGreaterThanOrEqual(3)
  })
  it('parses release versions and refuses anything else', () => {
    expect(parseVersion('v0.2.5')).toEqual({ major: 0, minor: 2, patch: 5, tag: 'v0.2.5' })
    expect(parseVersion('1.12.0')).toEqual({ major: 1, minor: 12, patch: 0, tag: 'v1.12.0' })
    expect(parseVersion('v10.0.3').major).toBe(10)
    for (const bad of [
      '',
      'v1',
      'v1.2',
      'v1.2.3.4',
      'v01.2.3',
      'v1.02.3',
      'v1.2.3-rc.1',
      'x1.2.3',
      'v1.2.3 ',
      'v-1.2.3',
    ]) {
      expect(() => parseVersion(bad), bad).toThrow(/Not a release version/)
    }
    expect(failure(['--version', 'v1.2', '--notes', join(NOTES, 'v0.2.5.md'), '--out', tmpdir()])).toContain(
      'Not a release version',
    )
    expect(() => planFor('* Move the palette\n', 'banana')).toThrow(/Not a release version/)
  })

  it('gives every major its own thematic, by declaration for 0 and 1 and by rule after them', () => {
    expect(thematicFor(0).name).toBe('Make-ready')
    expect(thematicFor(1).name).toBe('The run')
    expect(thematicFor(0).derived).toBe(false)
    expect(thematicFor(1).derived).toBe(false)
    expect(thematicFor(2).derived).toBe(true)
    expect(() => thematicFor(-1)).toThrow()
    expect(() => thematicFor(1.5)).toThrow()

    // Two majors never declare the same form: not 0 and 1, and not any two of the next twelve.
    expect(declared(thematicFor(0))).not.toBe(declared(thematicFor(1)))
    const forms = Array.from({ length: 12 }, (_, major) => declared(thematicFor(major)))
    expect(new Set(forms).size).toBe(forms.length)
    // Every accent is a declared ink in both variants, and never one of the style's own two.
    for (let major = 0; major < 12; major++) {
      const { accent } = thematicFor(major)
      expect(STYLE_INKS).not.toContain(accent)
      expect(PALETTE.light.inks[accent]).toBeTruthy()
      expect(PALETTE.dark.inks[accent]).toBeTruthy()
    }
    for (const major of Object.keys(THEMATICS)) {
      expect(THEMATICS[major].meaning.length).toBeGreaterThan(40)
    }
  })

  it('gives every minor of a major its own variation, in order along the arc', () => {
    for (const major of [0, 1, 2, 5]) {
      const thematic = thematicFor(major)
      const params = Array.from({ length: 10 }, (_, minor) => variationParams(variationFor(thematic, minor)))
      expect(new Set(params).size, `major ${major}`).toBe(params.length)
    }
    // Chapters step forward: 0.1 starts the arc, 0.3 ends it, later minors keep moving by less.
    expect(chapterOf(1)).toBe(0)
    expect(chapterOf(3)).toBe(1)
    for (let minor = 1; minor < 12; minor++) expect(chapterOf(minor)).toBeGreaterThan(chapterOf(minor - 1))
    for (let minor = 4; minor < 12; minor++) {
      expect(chapterOf(minor + 1) - chapterOf(minor)).toBeLessThan(
        chapterOf(minor) - chapterOf(minor - 1) + 1e-9,
      )
    }
    // Make-ready closes in on register; The run counts its beats.
    const ready = [1, 2, 3].map((minor) => variationFor(thematicFor(0), minor))
    expect(ready[0].gap).toBeGreaterThan(ready[1].gap)
    expect(ready[1].gap).toBeGreaterThan(ready[2].gap)
    expect(ready[0].warp).toBeGreaterThan(ready[2].warp)
    expect(ready[0].lean).toBeGreaterThan(ready[2].lean)
    expect(ready[0].reach).toBeLessThan(1)
    expect(ready[1].reach).toBeGreaterThan(1)
    expect([1, 2, 3].map((minor) => variationFor(thematicFor(1), minor).beats)).toEqual([1, 2, 3])
  })

  it('draws each thematic in its own grammar, whatever the notes say', () => {
    const notes = [
      '* Agent tools and lanes shared between agents\n* Review by agents\n* Delegate to workers\n',
      '* Focus rings\n* Cache the proxy\n* Keep the clock exact\n',
      '* Move the palette into the menu\n* Remove the card\n',
      '* Progress of each job\n* Live state in the panel\n* Notices when it stalls\n',
    ]
    for (const text of notes) {
      for (const minor of [1, 2, 3, 7]) {
        const ready = planFor(text, `v0.${minor}.4`)
        const run = planFor(text, `v1.${minor}.4`)
        // Make-ready leans on the diagonal; The run stands upright and is never warped.
        for (const field of ready.fields)
          for (const band of field.bands) expect(Math.abs(band.angle)).toBeLessThan(60)
        for (const field of run.fields) {
          expect(field.bands.length).toBe(Math.min(minor, 5))
          for (const band of field.bands) expect(Math.abs(band.angle - 90)).toBeLessThan(4)
        }
        for (const plate of run.plates) expect(plate.warp).toBe(0)
        // The run always holds an edge; the accent always prints, in either thematic.
        expect(run.holds.length).toBeGreaterThan(0)
        expect(ready.plates.slice(0, 2).map((plate) => plate.ink)).toContain('vermilion')
        expect(run.plates.slice(0, 2).map((plate) => plate.ink)).toEqual(
          expect.arrayContaining(['viridian', 'indigo']),
        )
        expect(ready.plates.map((plate) => plate.ink)).not.toContain('viridian')
        expect(run.plates.map((plate) => plate.ink)).not.toContain('vermilion')
      }
    }
  })

  it('marks the stand-in notes as stand-ins, beside the real ones', () => {
    for (const version of SERIES) {
      const notes = readFileSync(join(NOTES, `${version}.md`), 'utf8')
      expect(isStandIn(notes), version).toBe(STAND_INS.includes(version))
    }
    for (const release of manifest().releases) {
      expect(release.standIn, release.version).toBe(STAND_INS.includes(release.version))
    }
    expect(REAL.every((version) => !STAND_INS.includes(version))).toBe(true)
  })

  it('records the thematic and the chapter of every piece', () => {
    const { thematics, releases } = manifest()
    expect(thematics.map((thematic) => thematic.name)).toEqual(['Make-ready', 'The run'])
    const byVersion = Object.fromEntries(releases.map((release) => [release.version, release]))
    for (const version of MATRIX) expect(byVersion[version]).toBeTruthy()
    expect(byVersion['v0.1.0'].chapter).toBe('First pull')
    expect(byVersion['v1.3.0'].chapter).toBe('Full stack')
    for (const version of REAL) {
      expect(byVersion[version].thematic).toBe('Make-ready')
      expect(byVersion[version].chapter).toBe('Finding register')
    }
    for (const file of pieceFiles(COMMITTED)) {
      const svg = readFileSync(join(COMMITTED, file), 'utf8')
      const version = file.replace(/-(dark|light)\.svg$/, '')
      expect(svg).toContain(`${byVersion[version].thematic}, ${byVersion[version].chapter}.`)
    }
  })
})
