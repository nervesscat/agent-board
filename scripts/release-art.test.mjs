import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { planRelease, readNotes, renderRelease, renderSVG } from './release-art.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const notesOf = (version) => readFileSync(join(here, 'release-art/notes', `${version}.md`), 'utf8')
const SERIES = ['v0.2.2', 'v0.2.3', 'v0.2.4']
const THEMES = ['dark', 'light']

const transforms = (svg) =>
  [...svg.matchAll(/translate\(([^)]*)\) rotate\(([^)]*)\) scale\(([^)]*)\)/g)].map((match) =>
    match.slice(1).join('|'),
  )

describe('release art', () => {
  it('renders the same bytes for the same version and notes', () => {
    for (const version of SERIES) {
      for (const theme of THEMES) {
        expect(renderRelease(version, notesOf(version), theme)).toBe(
          renderRelease(version, notesOf(version), theme),
        )
      }
    }
  })

  it('keeps the committed files equal to what the generator makes', () => {
    for (const version of SERIES) {
      for (const theme of THEMES) {
        const committed = readFileSync(join(here, `../public/release-art/${version}-${theme}.svg`), 'utf8')
        expect(committed).toBe(renderRelease(version, notesOf(version), theme))
      }
    }
  })

  it('draws the dark and the light variant as one drawing', () => {
    const plan = planRelease({ version: 'v0.2.2', notes: notesOf('v0.2.2') })
    const dark = renderSVG(plan, 'dark')
    const light = renderSVG(plan, 'light')
    expect(transforms(dark)).toEqual(transforms(light))
    expect(dark.match(/<use /g)?.length).toBe(light.match(/<use /g)?.length)
  })

  it('keeps each piece under the size budget and free of visible text', () => {
    for (const version of SERIES) {
      for (const theme of THEMES) {
        const svg = renderRelease(version, notesOf(version), theme)
        expect(Buffer.byteLength(svg)).toBeLessThan(150 * 1024)
        expect(svg).not.toMatch(/<text|<tspan|<foreignObject|<image/)
        expect(svg).not.toMatch(/href="https?:|url\(https?:/)
      }
    }
  })

  it('makes a piece for a release nobody has drawn yet', () => {
    const notes =
      '* Command palette: search tickets, pages and actions by @someone in https://example.com/1\n' +
      '* Move reports into the project menu by @someone in https://example.com/2\n' +
      '* Split instructions from settings by @someone in https://example.com/3\n'
    const piece = renderRelease('v0.9.0', notes, 'dark')
    expect(piece).toContain('<svg')
    expect(piece).not.toBe(renderRelease('v0.2.4', notesOf('v0.2.4'), 'dark'))
    expect(renderRelease('v0.9.0', notes, 'light')).toContain('<svg')
  })

  it('reads a release by what its notes are about', () => {
    const busy = readNotes(notesOf('v0.2.2'))
    const quiet = readNotes(notesOf('v0.2.3'))
    const reorganized = readNotes(notesOf('v0.2.4'))
    expect(busy.changes).toBeGreaterThan(quiet.changes * 5)
    expect(busy.collab).toBeGreaterThan(quiet.collab)
    expect(quiet.precision).toBeGreaterThan(busy.precision)
    expect(reorganized.wayfinding).toBeGreaterThan(quiet.wayfinding)
  })

  it('gives the series one family and three different pieces', () => {
    const plans = SERIES.map((version) => planRelease({ version, notes: notesOf(version) }))
    expect(new Set(plans.map((plan) => plan.angle)).size).toBe(3)
    expect(new Set(plans.map((plan) => plan.pigment.name)).size).toBe(3)
    expect(plans[0].streaks.length).toBeGreaterThan(plans[1].streaks.length)
    for (const plan of plans) expect(plan.streaks.every((stroke) => stroke.width > 0)).toBe(true)
  })
})
