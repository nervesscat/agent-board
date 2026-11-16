import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { NEUTRAL, PALETTE_HEXES, planPiece, readThemes, renderSeries, seriesPlans } from './palimpsest.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/release-art/palimpsest.mjs')
const NOTES = join(ROOT, 'scripts/release-art/notes')
const COMMITTED = join(ROOT, 'src/assets/release-art/palimpsest')
const BUDGET = 150 * 1024
const TIMEOUT = 60_000
const RELEASES = ['v0.2.2', 'v0.2.3', 'v0.2.4', 'v0.2.5']

function generate(out) {
  return execFileSync(process.execPath, [SCRIPT, '--out', out], { cwd: ROOT, encoding: 'utf8' })
}

function pieceFiles(dir) {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.svg'))
    .sort()
}

describe('release artwork: palimpsest', () => {
  it('writes the same bytes on every run', { timeout: TIMEOUT }, () => {
    const first = mkdtempSync(join(tmpdir(), 'palimpsest-a-'))
    const second = mkdtempSync(join(tmpdir(), 'palimpsest-b-'))
    generate(first)
    generate(second)

    const files = pieceFiles(first)
    expect(files.length).toBe(8)
    for (const file of [...files, 'manifest.json']) {
      expect(readFileSync(join(second, file)).equals(readFileSync(join(first, file))), file).toBe(true)
    }
  })

  it('matches the pieces committed beside the app', { timeout: TIMEOUT }, () => {
    const fresh = mkdtempSync(join(tmpdir(), 'palimpsest-committed-'))
    generate(fresh)

    expect(pieceFiles(fresh)).toEqual(pieceFiles(COMMITTED))
    for (const file of [...pieceFiles(fresh), 'manifest.json']) {
      expect(readFileSync(join(COMMITTED, file)).equals(readFileSync(join(fresh, file))), file).toBe(true)
    }
  })

  it('keeps every piece 16:9, self-contained, without text and under the size budget', () => {
    for (const version of RELEASES) {
      expect(pieceFiles(COMMITTED)).toContain(`${version}-light.svg`)
      expect(pieceFiles(COMMITTED)).toContain(`${version}-dark.svg`)
    }
    for (const file of pieceFiles(COMMITTED)) {
      const svg = readFileSync(join(COMMITTED, file), 'utf8')
      expect(svg).toMatch(
        /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1600" height="900" viewBox="0 0 1600 900"/,
      )
      expect(svg).toMatch(/role="img"/)
      expect(Buffer.byteLength(svg), file).toBeLessThan(BUDGET)
      // Nothing that loads, runs or needs a network, and no text drawn inside the artwork.
      expect(svg).not.toMatch(/<script|<image|<use|<foreignObject|<text|<tspan|<style|xlink|href=|@import/)
      expect(svg).not.toMatch(/url\((?!#)/)
      expect(svg.match(/https?:\/\/[^"' ]+/g)).toEqual(['http://www.w3.org/2000/svg'])
    }
  })

  it('draws with nothing but the declared palette', () => {
    // Black and white are allowed for the eraser's mask and the pressure shapes only: they set
    // alpha, never a colour on the sheet.
    const allowed = new Set([...PALETTE_HEXES, '#000000', '#FFFFFF'].map((hex) => hex.toUpperCase()))
    for (const file of pieceFiles(COMMITTED)) {
      const svg = readFileSync(join(COMMITTED, file), 'utf8')
      const colours = [...svg.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((match) => match[0].toUpperCase())
      expect(colours.length).toBeGreaterThan(0)
      for (const colour of colours) expect(allowed.has(colour), `${file} uses ${colour}`).toBe(true)
    }
  })

  it('reads a release as its themes', () => {
    const hands = readThemes(
      '* Agents share lanes\n* Review agents and delegation\n* Agent tokens for the session\n',
    )
    const precision = readThemes('* Focus rings inside\n* Cache and retry\n* Keep the clock exact\n')
    const clearing = readThemes('* Move the palette\n* Remove the menu\n* Split the settings\n')

    expect(hands.hands).toBeGreaterThan(hands.precision)
    expect(precision.precision).toBeGreaterThan(precision.hands)
    expect(clearing.wayfinding).toBeGreaterThan(clearing.precision)
    expect(clearing.clearing).toBe(1)
    expect(readThemes('* Release 0.2.0 by @x\n* Fix it\n').carry).toBe(0.5)

    // Many hands draw more swaths at more angles; precision keeps them parallel and even; a
    // clearing release erases more of the sheet before it.
    const many = planPiece('v9.9.9', hands)
    const exact = planPiece('v9.9.9', precision)
    const cleared = planPiece('v9.9.9', clearing)
    expect(many.count).toBeGreaterThan(exact.count - 1)
    expect(exact.regular).toBe(1)
    expect(exact.spread).toBeLessThan(many.spread)
    expect(cleared.erase).toBeGreaterThan(exact.erase)
    expect(cleared.erase).toBeGreaterThan(many.erase)
  })

  it('draws each release over the erased ghost of the one before', () => {
    const plans = seriesPlans()
    expect(plans.map((p) => p.version)).toEqual(RELEASES)
    for (let i = 1; i < plans.length; i++) {
      expect(plans[i].ghost.version).toBe(plans[i - 1].version)
      expect(plans[i].ghost.swaths).toEqual(plans[i - 1].plan.swaths)
    }
    // The first release in the folder gets the release before it by number, from neutral themes.
    expect(plans[0].ghost.version).toBe('v0.2.1')
    expect(plans[0].ghost.swaths).toEqual(planPiece('v0.2.1', NEUTRAL).swaths)
  })

  it('draws a release nobody has seen from its notes alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'palimpsest-next-'))
    writeFileSync(join(dir, 'v0.2.5.md'), readFileSync(join(NOTES, 'v0.2.5.md')))
    writeFileSync(join(dir, 'v0.3.0.md'), '* Split the board into rooms\n* Agents share a room\n')
    const files = renderSeries(dir)

    expect(Object.keys(files).sort()).toEqual([
      'manifest.json',
      'v0.2.5-dark.svg',
      'v0.2.5-light.svg',
      'v0.3.0-dark.svg',
      'v0.3.0-light.svg',
    ])
    expect(JSON.parse(files['manifest.json']).releases[1].ghostOf).toBe('v0.2.5')
    expect(files['v0.3.0-light.svg']).not.toBe(renderSeries(dir)['v0.2.5-light.svg'])
    expect(renderSeries(dir)['v0.3.0-dark.svg']).toBe(files['v0.3.0-dark.svg'])
  })
})
