import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HEIGHT, SIZE_BUDGET, WIDTH, renderPiece, themesOf } from './generate.mjs'

const RELEASES = ['0.2.2', '0.2.3', '0.2.4']
const MODES = ['dark', 'light']

const notes = (version) => readFileSync(new URL(`./releases/v${version}.md`, import.meta.url), 'utf8')
const bytes = (svg) => Buffer.byteLength(svg)
const count = (svg, needle) => svg.split(needle).length - 1

describe('release art', () => {
  it('draws the same bytes for the same release and mode', () => {
    expect(renderPiece('0.2.4', notes('0.2.4'), 'light')).toBe(renderPiece('0.2.4', notes('0.2.4'), 'light'))
  })

  it('gives every release its own piece', () => {
    const pieces = RELEASES.map((version) => renderPiece(version, notes(version), 'dark'))
    expect(new Set(pieces).size).toBe(RELEASES.length)
  })

  it("keeps a release's dark and light variants on the same composition", () => {
    for (const version of RELEASES) {
      const dark = renderPiece(version, notes(version), 'dark')
      const light = renderPiece(version, notes(version), 'light')
      expect(dark).not.toBe(light)
      expect(count(dark, '<path')).toBe(count(light, '<path'))
    }
  })

  it('stays a 16:9 SVG inside the size budget', () => {
    for (const version of RELEASES) {
      for (const mode of MODES) {
        const svg = renderPiece(version, notes(version), mode)
        expect(svg).toContain(`viewBox="0 0 ${WIDTH} ${HEIGHT}"`)
        expect(svg.startsWith('<svg')).toBe(true)
        expect(svg.trimEnd().endsWith('</svg>')).toBe(true)
        expect(bytes(svg)).toBeLessThan(SIZE_BUDGET)
      }
    }
  })

  it('reads the release notes as themes', () => {
    const busy = themesOf(notes('0.2.2'))
    const quiet = themesOf(notes('0.2.3'))
    const tidy = themesOf(notes('0.2.4'))
    expect(busy.density).toBeGreaterThan(quiet.density + 0.3)
    expect(quiet.holding).toBeGreaterThan(busy.holding + 0.5)
    expect(tidy.clearing).toBeGreaterThan(quiet.clearing + 0.5)
  })
})
