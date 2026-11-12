import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = new URL('../../', import.meta.url).pathname
const SCRIPT = join(ROOT, 'scripts/release-art/retro-vhs.mjs')
const COMMITTED = join(ROOT, 'src/assets/release-art/retro-vhs')
const BUDGET = 150 * 1024

// The lane's palette, fixed: four hexes and nothing else.
const PALETTE = ['#101014', '#E6E1D6', '#FF4D6D', '#4DE1FF']

function generate(out, extra = []) {
  execFileSync(process.execPath, [SCRIPT, '--out', out, ...extra], { cwd: ROOT })
}

function pieceFiles(dir) {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.svg'))
    .sort()
}

function readManifest(dir) {
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
}

function hexesIn(svg) {
  return (svg.match(/#[0-9a-fA-F]{6}/g) || []).map((hex) => hex.toUpperCase())
}

describe('release artwork: retro VHS contour field', () => {
  it('writes the same bytes on every run', { timeout: 60_000 }, () => {
    const first = mkdtempSync(join(tmpdir(), 'retro-vhs-a-'))
    const second = mkdtempSync(join(tmpdir(), 'retro-vhs-b-'))
    generate(first)
    generate(second)

    const files = pieceFiles(first)
    expect(files.length).toBe(6)
    for (const file of files) {
      expect(readFileSync(join(second, file)).equals(readFileSync(join(first, file)))).toBe(true)
    }
    expect(
      readFileSync(join(second, 'manifest.json')).equals(readFileSync(join(first, 'manifest.json'))),
    ).toBe(true)
  })

  it('matches the pieces committed beside the app', { timeout: 60_000 }, () => {
    const fresh = mkdtempSync(join(tmpdir(), 'retro-vhs-committed-'))
    generate(fresh)

    expect(pieceFiles(fresh)).toEqual(pieceFiles(COMMITTED))
    for (const file of pieceFiles(fresh)) {
      expect(readFileSync(join(COMMITTED, file)).equals(readFileSync(join(fresh, file)))).toBe(true)
    }
    expect(
      readFileSync(join(COMMITTED, 'manifest.json')).equals(readFileSync(join(fresh, 'manifest.json'))),
    ).toBe(true)
  })

  it('keeps every piece 16:9, in two variants under the size budget', () => {
    for (const file of pieceFiles(COMMITTED)) {
      const svg = readFileSync(join(COMMITTED, file), 'utf8')
      expect(svg).toMatch(/viewBox="0 0 1600 900"/)
      expect(svg).toMatch(/width="1600" height="900"/)
      expect(Buffer.byteLength(svg)).toBeLessThan(BUDGET)
    }
    for (const version of ['v0.2.2', 'v0.2.3', 'v0.2.4']) {
      expect(pieceFiles(COMMITTED)).toContain(`${version}-dark.svg`)
      expect(pieceFiles(COMMITTED)).toContain(`${version}-light.svg`)
    }
  })

  it('draws only the declared palette, and no text or outside asset', () => {
    for (const file of pieceFiles(COMMITTED)) {
      const svg = readFileSync(join(COMMITTED, file), 'utf8')
      const stray = [...new Set(hexesIn(svg))].filter((hex) => !PALETTE.includes(hex))
      expect(stray).toEqual([])
      expect(svg).not.toMatch(/<text[\s>]/)
      // The SVG namespace is the only address a piece may carry: no outside image, font or link.
      expect(svg.match(/https?:\/\/[^"' )]+/g)).toEqual(['http://www.w3.org/2000/svg'])
      expect(svg).not.toMatch(/xlink:href="(?!#)/)
    }
  })

  it('records the tape: chroma both ways, bloom, bands and grain in every piece', () => {
    const manifest = readManifest(COMMITTED)
    for (const release of manifest.releases) {
      expect(release.tape.split).toBeGreaterThanOrEqual(1)
      expect(release.tape.split).toBeLessThanOrEqual(3)
      for (const file of Object.values(release.files)) {
        const svg = readFileSync(join(COMMITTED, file), 'utf8')
        expect(hexesIn(svg)).toContain('#FF4D6D')
        expect(hexesIn(svg)).toContain('#4DE1FF')
        expect(svg).toContain('id="bloom"')
        expect(svg).toContain('id="grain"')
        expect(svg).toContain('id="track"')
        expect(svg.match(/<clipPath id="band-/g) || []).toHaveLength(release.tape.bands)
      }
    }
  })

  it('makes a piece for a release it has never seen', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'retro-vhs-new-'))
    const notes = join(dir, 'v9.9.9.md')
    writeFileSync(
      notes,
      [
        "## What's Changed",
        '* Move the settings into their own menu',
        '* Remove the old palette from every screen',
        '* Split the daily view and fold the resume card away',
        '* Rename the cleanup page and find things by search',
        '',
      ].join('\n'),
    )

    generate(dir, ['--version', 'v9.9.9', '--notes', notes])

    expect(pieceFiles(dir)).toEqual(['v9.9.9-dark.svg', 'v9.9.9-light.svg'])
    const manifest = readManifest(dir)
    expect(manifest.releases).toHaveLength(1)
    // Wayfinding notes clear a corridor through the field; the next release is made, not drawn.
    expect(manifest.releases[0].field.corridor).toBe(true)
    expect(manifest.releases[0].files).toEqual({
      light: 'v9.9.9-light.svg',
      dark: 'v9.9.9-dark.svg',
    })
  })

  it('gives different releases different fields and different tape', () => {
    const manifest = readManifest(COMMITTED)
    const looks = manifest.releases.map((release) =>
      JSON.stringify([release.field, release.tape, release.seed]),
    )
    expect(new Set(looks).size).toBe(manifest.releases.length)
  })
})
