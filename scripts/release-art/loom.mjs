#!/usr/bin/env node
// Release artwork, direction "Loom": every release is woven, not drawn.
//
// Pale warp threads run top to bottom; the release's notes are carried across them as weft. Most of
// the cloth is undyed, and the notes decide where dyed weft is laid in: as blocks of two or three
// dyes, the way a Bauhaus tapestry builds a composition out of nothing but interlacing. Nothing is
// drawn on top of the cloth, so there is no object to name: only threads, the structure they are
// woven in (plain, twill, a twill that turns), and the faults of a hand loom (an uneven beat, dye that
// is not quite even from pick to pick, a broken warp, a weft that floats over too many threads).
//
// The notes are read as four themes, each with its own way of laying weft in:
//   agency      many small blocks in every dye, abutting with slits: many hands on one cloth
//   precision   a few long narrow bands squared to one shared edge, a tight beat: things holding
//   wayfinding  blocks moved to one side, a twill that turns, a ghost where a block was taken out
//   signal      thin full-width picks at a steady interval that stall and resume: a pulse
// The version seeds every remaining choice, so the same version and notes write the same bytes
// every time.
//
//   node scripts/release-art/loom.mjs                       # the series, into src/assets/release-art/loom
//   node scripts/release-art/loom.mjs --out /tmp/art        # write somewhere else
//   node scripts/release-art/loom.mjs --version v0.3.0 \
//     --notes scripts/release-art/notes/v0.3.0.md --out /tmp/art

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const NOTES = join(ROOT, 'scripts/release-art/notes')
const DEFAULT_OUT = join(ROOT, 'src/assets/release-art/loom')
export const SERIES = ['v0.2.2', 'v0.2.3', 'v0.2.4', 'v0.2.5']

export const WIDTH = 1600
export const HEIGHT = 900
// One warp thread every WARP_PITCH px; a third of the size keeps each thread over 5 px.
export const WARP_PITCH = 16
const WARP_WIDTH = 0.6
const WEFT_WIDTH = 0.8

export const PALETTE = {
  light: {
    ground: '#E3DBCA',
    warp: '#ECE6DA',
    warpShade: '#E1D9C8',
    weft: '#DBD3C2',
    dyes: ['#2F3E66', '#B04A30', '#C59A3E'],
    fibre: '#5B5242',
  },
  dark: {
    ground: '#15171C',
    warp: '#2C2F37',
    warpShade: '#23262D',
    weft: '#1E2026',
    dyes: ['#6A7FB6', '#C65F40', '#C6A04C'],
    fibre: '#C9C1B0',
  },
}
export const PALETTE_HEXES = [
  ...new Set(
    Object.values(PALETTE).flatMap((p) => [p.ground, p.warp, p.warpShade, p.weft, p.fibre, ...p.dyes]),
  ),
]

const STEMS = {
  agency: [
    'agent',
    'delegat',
    'orchestrat',
    'review',
    'lane',
    'verdict',
    'share',
    'team',
    'decision',
    'skill',
    'session',
    'hand-off',
    'handoff',
    'connect',
    'brief',
  ],
  precision: [
    'focus',
    'safe area',
    'cache',
    'clock',
    'proxy',
    'sticky',
    'cap ',
    'retry',
    'keep',
    'fix',
    'exact',
    'inside',
    'settle',
    'reliab',
    'lock',
    'timing',
    'idle',
    'forward',
  ],
  wayfinding: [
    'move',
    'split',
    'remove',
    'menu',
    'palette',
    'fold',
    'rename',
    'drop',
    'leave',
    ' into ',
    'beside',
    'selector',
    'reorder',
    'find',
    'search',
    'lives on',
  ],
  signal: [
    'stall',
    'alive',
    'live',
    'progress',
    'notification',
    'notice',
    'heartbeat',
    'wait',
    'tracked',
    'job',
    'state',
    'restart',
    'release',
    'update',
  ],
}
export const THEMES = Object.keys(STEMS)

// ---------------------------------------------------------------- seeded numbers

function hashString(text) {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value))
const between = (random, low, high) => low + random() * (high - low)
const whole = (random, low, high) => Math.floor(between(random, low, high + 1))
const round = (value, places = 1) => Number(value.toFixed(places))

// ---------------------------------------------------------------- reading the notes

export function readItems(notes) {
  return (
    notes
      .split(/\r?\n/)
      .filter((line) => /^\s*[*-]\s+/.test(line))
      .map((line) =>
        line
          .replace(/^\s*[*-]\s+/, '')
          .replace(/\s+by @\S+.*$/, '')
          .trim(),
      )
      .filter((line) => line && !/made their first contribution/.test(line))
      // A bare version bump says nothing about the release.
      .filter(
        (line) =>
          !/^(release|version)\s+v?\d+\.\d+\.\d+$/i.test(line) &&
          !/^(bump|set the desktop app version)\b/i.test(line),
      )
  )
}

export function readThemes(notes) {
  const items = readItems(notes)
  const counts = Object.fromEntries(THEMES.map((theme) => [theme, 0]))
  let other = 0
  for (const item of items) {
    const text = ` ${item.toLowerCase()} `
    const verb = text.trim().split(/\s+/)[0]
    let best = null
    let bestScore = 0
    for (const theme of THEMES) {
      // The verb an item opens with says what kind of change it is, so it counts for more.
      const opens = STEMS[theme].some((stem) => stem.trim() && verb.startsWith(stem.trim())) ? 1.5 : 0
      const score = STEMS[theme].filter((stem) => text.includes(stem)).length + opens
      if (score > bestScore) {
        best = theme
        bestScore = score
      }
    }
    if (best) counts[best] += 1
    else other += 1
  }
  const themed = THEMES.reduce((sum, theme) => sum + counts[theme], 0) || 1
  const weights = Object.fromEntries(THEMES.map((theme) => [theme, round(counts[theme] / themed, 3)]))
  return { items: items.length, counts, other, ...weights }
}

function dominant(themes) {
  return THEMES.reduce((best, theme) => (themes[theme] > themes[best] ? theme : best), THEMES[0])
}

// ---------------------------------------------------------------- planning the cloth

// Structures are written as [over, under, shift]: the weft floats over `over` warps, under `under`,
// and each pick moves the interlacing `shift` warps along. A shift of 1 is plain weave (1/1) or a
// twill (2/2, 3/1); the turned twill flips the shift at a column.
const STRUCTURES = {
  plain: [1, 1, 1],
  twill: [2, 2, 1],
  satin: [3, 1, 1],
  basket: [2, 2, 0],
}

export function planPiece(version, themes, seed) {
  const random = mulberry32(seed)
  const lead = dominant(themes)
  const warps = Math.ceil(WIDTH / WARP_PITCH)

  // The beat: precise releases are beaten tight and even, the rest a little looser and uneven.
  const beat = round(13.5 - 2.5 * themes.precision, 2)
  const unevenness = round(0.04 + 0.16 * (1 - themes.precision), 3)
  const picks = []
  let y = between(random, -beat * 0.6, 0)
  while (y < HEIGHT + beat) {
    picks.push(round(y, 2))
    y += beat * (1 + (random() * 2 - 1) * unevenness)
  }
  const rows = picks.length

  const ground = { agency: 'plain', precision: 'plain', wayfinding: 'twill', signal: 'satin' }[lead]

  // Cells: which dye, structure and turn each (warp, pick) carries; -1 is undyed.
  const cells = Array.from({ length: rows }, () => Array.from({ length: warps }, () => null))
  const taken = (w0, w1, r0, r1, pad) => {
    for (let r = Math.max(0, r0 - pad); r <= Math.min(rows - 1, r1 + pad); r++)
      for (let w = Math.max(0, w0 - pad); w <= Math.min(warps - 1, w1 + pad); w++)
        if (cells[r][w]) return true
    return false
  }
  const lay = (block) => {
    for (let r = block.r0; r <= block.r1; r++) {
      if (r < 0 || r >= rows) continue
      if (block.every && (r - block.r0) % block.every !== 0) continue
      for (let w = block.w0; w <= block.w1; w++) {
        if (w < 0 || w >= warps) continue
        cells[r][w] = {
          dye: block.dye,
          structure: block.structure,
          turn: block.turn ?? null,
          fine: block.fine,
          bare: block.bare,
        }
      }
    }
  }

  const items = Math.max(1, themes.items)
  // How much dyed cloth: a busy release gets more blocks; a release that reorganized and removed
  // things gets fewer, the cloth left emptier.
  const total = clamp(Math.round((2 + 2.4 * Math.log2(items + 1)) * (1 - 0.45 * themes.wayfinding)), 4, 20)
  // A theme under a fifth of the release lays nothing: the cloth says what the release was mostly.
  const share = Object.fromEntries(
    THEMES.map((theme) => [theme, themes[theme] >= 0.2 ? Math.max(1, Math.round(total * themes[theme])) : 0]),
  )
  share[lead] = Math.max(share[lead], 2)
  const blocks = []

  // The composition leans to one side of the cloth, chosen by the seed, so the four releases do not
  // all put their weight in the same place.
  const side = random() < 0.5 ? -1 : 1
  const centre = WIDTH / 2 + side * between(random, 120, 300)

  // Precision: a few bands squared to one shared edge and run off the cloth's far edge, so nothing
  // ends raggedly; one band is broad, the rest narrow, and a hairline of the second dye holds them.
  if (share.precision > 0) {
    const bands = clamp(Math.round(share.precision * 0.75), 2, 5)
    const edge = clamp(Math.round(centre / WARP_PITCH + side * -between(random, 16, 26)), 6, warps - 30)
    const [w0, w1] = side > 0 ? [edge, warps - 1] : [0, edge]
    const broad = whole(random, 0, bands - 1)
    let r = whole(random, Math.round(rows * 0.12), Math.round(rows * 0.3))
    for (let i = 0; i < bands && r < rows - 8; i++) {
      const height = i === broad ? whole(random, 6, 9) : whole(random, 2, 3)
      const block = { kind: 'precision', w0, w1, r0: r, r1: r + height - 1, dye: 0, structure: 'plain' }
      lay(block)
      blocks.push(block)
      r += height + (i === broad ? 2 : whole(random, 3, 5))
      if (i === broad) {
        const hair = { kind: 'hairline', w0, w1, r0: r - 1, r1: r - 1, dye: 1, structure: 'plain' }
        lay(hair)
        blocks.push(hair)
        r += 1
      }
    }
  }

  // Wayfinding: a few big blocks on the far side, woven in a twill that turns, and one ghost: the
  // block that was taken out, a window where no weft was laid at all and only the bare warp shows.
  if (share.wayfinding > 0) {
    const count = clamp(Math.ceil(share.wayfinding / 2), 1, 3)
    const farSide = side > 0 ? warps - 1 : 0
    let r = whole(random, 3, Math.round(rows * 0.22))
    for (let i = 0; i < count && r < rows - 8; i++) {
      const width = whole(random, 18, 32)
      const height = whole(random, 9, 16)
      const inset = whole(random, 4, 10) + i * whole(random, 3, 8)
      const w0 = side > 0 ? farSide - inset - width : farSide + inset
      const block = { kind: 'wayfinding', w0, w1: w0 + width, r0: r, r1: r + height - 1 }
      block.dye = i % 2 === 0 ? 0 : 2
      block.structure = 'twill'
      block.turn = w0 + whole(random, Math.round(width * 0.3), Math.round(width * 0.7))
      if (!taken(block.w0, block.w1, block.r0, block.r1, 1)) {
        lay(block)
        blocks.push(block)
      }
      r += height + whole(random, 4, 8)
    }
    const ghostWidth = whole(random, 16, 26)
    const ghostRows = whole(random, 9, 14)
    for (let attempt = 0; attempt < 60; attempt++) {
      const w0 = Math.round(centre / WARP_PITCH - side * whole(random, 6, 22) - ghostWidth / 2)
      const r0 = whole(random, 2, rows - ghostRows - 2)
      if (w0 < 2 || w0 + ghostWidth > warps - 3) continue
      if (taken(w0, w0 + ghostWidth, r0, r0 + ghostRows, 2)) continue
      const ghost = {
        kind: 'ghost',
        w0,
        w1: w0 + ghostWidth,
        r0,
        r1: r0 + ghostRows,
        dye: 1,
        structure: 'plain',
        bare: true,
      }
      lay(ghost)
      blocks.push(ghost)
      break
    }
  }

  // Agency: many small inlays in every dye, packed around the centre, abutting with slits.
  if (share.agency > 0) {
    const count = clamp(share.agency * 2, 3, 26)
    const spreadW = 14 + 22 * themes.agency
    const spreadR = rows * (0.12 + 0.2 * themes.agency)
    const cw = centre / WARP_PITCH
    const cr = rows * between(random, 0.42, 0.58)
    let dye = whole(random, 0, 2)
    for (let i = 0, attempt = 0; i < count && attempt < count * 30; attempt++) {
      const width = whole(random, 4, 13)
      const height = whole(random, 3, 9)
      const w0 = Math.round(cw + (random() * 2 - 1) * spreadW - width / 2)
      const r0 = Math.round(cr + (random() * 2 - 1) * spreadR - height / 2)
      if (w0 < 1 || w0 + width > warps - 2 || r0 < 1 || r0 + height > rows - 2) continue
      if (taken(w0, w0 + width - 1, r0, r0 + height - 1, 0)) continue
      dye = (dye + 1 + (random() < 0.3 ? 1 : 0)) % 3
      const structures = ['plain', 'plain', 'twill', 'basket']
      const block = {
        kind: 'agency',
        w0,
        w1: w0 + width - 1,
        r0,
        r1: r0 + height - 1,
        dye,
        structure: structures[whole(random, 0, 3)],
      }
      lay(block)
      blocks.push(block)
      i++
    }
  }

  // Signal: one row of small equal inlays across the whole cloth at a steady interval, a pulse;
  // it stalls (a stretch with none), then catches up with two close together. A beat that would land
  // on a block is skipped: the pulse never covers what is already there.
  const pulses = []
  if (share.signal > 0) {
    const size = 3
    const interval = whole(random, 7, 9)
    const lines = 1
    for (let line = 0; line < lines; line++) {
      const r0 =
        line === 0
          ? whole(random, Math.round(rows * 0.62), rows - size - 4)
          : whole(random, 3, Math.round(rows * 0.2))
      const stallAt = whole(random, 3, Math.floor(warps / interval) - 4)
      const stallLength = whole(random, 2, 3)
      const offset = whole(random, 1, interval - 1)
      let beat = 0
      for (let w = offset; w + size < warps; w += interval, beat++) {
        if (beat > stallAt && beat <= stallAt + stallLength) continue
        const pulse = {
          kind: 'signal',
          w0: w,
          w1: w + size - 1,
          r0: r0,
          r1: r0 + size - 1,
          dye: 2,
          structure: 'plain',
        }
        if (beat === stallAt + stallLength + 1) {
          pulse.w0 -= Math.round(interval / 2)
          pulse.w1 = w + size - 1
        }
        if (taken(pulse.w0, pulse.w1, pulse.r0, pulse.r1, 0)) continue
        lay(pulse)
        blocks.push(pulse)
        pulses.push(pulse.w0)
      }
    }
  }

  // Faults of the hand: broken warps, floats, and the dye's pick-to-pick unevenness (abrash).
  const faults = clamp(Math.round(1 + Math.log2(themes.other + 1) / 2 + (1 - themes.precision) * 2), 1, 6)
  const breaks = []
  for (let i = 0; i < Math.ceil(faults / 2); i++) {
    const r0 = whole(random, 4, rows - 8)
    breaks.push({ warp: whole(random, 2, warps - 3), r0, r1: r0 + whole(random, 2, 4) })
  }
  const floats = []
  for (let i = 0; i < faults; i++) {
    floats.push({
      row: whole(random, 1, rows - 2),
      warp: whole(random, 2, warps - 12),
      span: whole(random, 4, 9),
    })
  }
  const abrash = round(0.05 + 0.1 * (1 - themes.precision), 3)
  const tones = picks.map(() => round(1 - random() * abrash, 3))
  const warpTones = Array.from({ length: warps }, () => (random() < 0.22 ? 1 : 0))

  return {
    version,
    seed,
    lead,
    ground,
    warps,
    beat,
    unevenness,
    picks,
    cells,
    blocks,
    pulses,
    breaks,
    floats,
    abrash,
    tones,
    warpTones,
    hand: {
      wobble: round(2.5 + 3.5 * (1 - themes.precision), 2),
      wobbleFrequency: [0.004, 0.009],
      fuzz: 1.4,
      seed: seed % 9973,
    },
    shares: share,
  }
}

// ---------------------------------------------------------------- drawing

function cellKey(cell) {
  return cell ? `${cell.dye}|${cell.structure}|${cell.turn}|${cell.fine}|${cell.bare}` : 'u'
}

function runsOf(row) {
  const runs = []
  let start = 0
  for (let w = 1; w <= row.length; w++) {
    if (w === row.length || cellKey(row[w]) !== cellKey(row[start])) {
      runs.push({ w0: start, w1: w - 1, cell: row[start] })
      start = w
    }
  }
  return runs
}

const mod = (a, b) => ((a % b) + b) % b

// The weft's floats over the warp, as a dash pattern along one pick. Round caps turn each dash into
// the lozenge a float makes as it bends over a thread.
// With `ribs`, the same pattern seen the other way: the short stretch of warp that crosses over the
// pick where the weft goes under, as a square-ended mark on a solid, weft-faced pick.
function overDashes(x0, x1, y, row, structure, turn, width, ribs = false) {
  const [over, under, shift] = STRUCTURES[structure]
  const period = over + under
  const dash = ribs
    ? Math.max(0.6, under * WARP_PITCH - WARP_PITCH * 0.56)
    : Math.max(0.6, over * WARP_PITCH - width * 0.95)
  const gap = period * WARP_PITCH - dash
  const lead = ribs ? over : 0
  const segments = []
  const pieces =
    turn == null
      ? [[x0, x1, 1]]
      : [
          [x0, turn * WARP_PITCH, 1],
          [turn * WARP_PITCH, x1, -1],
        ]
  for (const [a, b, direction] of pieces) {
    if (b - a < 1) continue
    const phase = structure === 'basket' ? Math.floor(row / 2) * 2 : row * shift * direction
    // First warp k at or after a whose (k + phase) % period == 0 starts a float.
    const k0 = Math.ceil(a / WARP_PITCH - 1e-6)
    const k = k0 + mod(lead - (k0 + phase), period)
    const start = k * WARP_PITCH + (WARP_PITCH - dash) / 2
    const offset = mod(-(start - a), period * WARP_PITCH)
    segments.push(
      `<path d="M${round(a)} ${round(y)}H${round(b)}" stroke-dasharray="${round(dash)} ${round(gap)}" stroke-dashoffset="${round(offset)}"/>`,
    )
  }
  return segments.join('')
}

function piece(plan, mode) {
  const palette = PALETTE[mode]
  const { picks, cells, warps } = plan
  const weftWidth = plan.beat * WEFT_WIDTH
  const colourOf = (cell) => (cell ? palette.dyes[cell.dye] : palette.weft)

  // Undyed cloth is a balanced weave: the warp over the ground, the weft's floats over the warp.
  // Dyed weft is weft-faced, as in a tapestry: the pick covers the warp, which shows only as ribs
  // where it crosses over, so a block reads as one field of colour from across the room and as
  // interlacing up close.
  const floats = new Map()
  const solid = new Map()
  const fine = new Map()
  const ribs = []
  const push = (map, colour, svg) => {
    if (!map.has(colour)) map.set(colour, [])
    map.get(colour).push(svg)
  }
  for (let r = 0; r < picks.length; r++) {
    const y = picks[r]
    const tone = plan.tones[r]
    const opacity = tone < 0.999 ? ` opacity="${tone}"` : ''
    for (const run of runsOf(cells[r])) {
      const colour = colourOf(run.cell)
      const x0 = run.w0 * WARP_PITCH
      const x1 = (run.w1 + 1) * WARP_PITCH
      const structure = run.cell ? run.cell.structure : plan.ground
      const turn = run.cell?.turn ?? null
      if (run.cell?.bare) continue
      if (!run.cell) {
        push(floats, colour, overDashes(x0, x1, y, r, structure, null, weftWidth))
      } else if (run.cell.fine) {
        push(fine, colour, `<path d="M${round(x0)} ${round(y)}H${round(x1)}"/>`)
      } else {
        push(solid, colour, `<path d="M${round(x0)} ${round(y)}H${round(x1)}"${opacity}/>`)
        ribs.push(overDashes(x0, x1, y, r, structure, turn, weftWidth, true))
      }
    }
  }
  for (const float of plan.floats) {
    const y = picks[float.row]
    const cell = cells[float.row][float.warp]
    if (cell?.bare || cell?.fine) continue
    const x0 = float.warp * WARP_PITCH + WARP_PITCH * 0.3
    push(
      cell ? solid : floats,
      colourOf(cell),
      `<path d="M${round(x0)} ${round(y)}h${round(float.span * WARP_PITCH - WARP_PITCH * 0.6)}"/>`,
    )
  }

  // Warps: one thread per pitch, a few in the shaded tone, the broken ones with their gap.
  const warpPaths = { warp: [], warpShade: [] }
  for (let w = 0; w < warps; w++) {
    const x = round(w * WARP_PITCH + WARP_PITCH / 2)
    const tone = plan.warpTones[w] ? 'warpShade' : 'warp'
    const broken = plan.breaks.find((b) => b.warp === w)
    if (broken) {
      const top = picks[broken.r0]
      const bottom = picks[broken.r1]
      warpPaths[tone].push(`M${x} -4V${round(top)}M${round(x + 1.5)} ${round(bottom)}V${HEIGHT + 4}`)
    } else warpPaths[tone].push(`M${x} -4V${HEIGHT + 4}`)
  }

  const group = (map, width, cap) =>
    [...map.entries()]
      .map(
        ([colour, paths]) =>
          `<g stroke="${colour}" stroke-width="${round(width, 2)}" stroke-linecap="${cap}" fill="none">${paths.join('')}</g>`,
      )
      .join('\n')

  const hand = plan.hand
  const fibre = palette.fibre
  const [fr, fg, fb] = [1, 3, 5].map((i) => round(parseInt(fibre.slice(i, i + 2), 16) / 255, 3))
  const grainAlpha = mode === 'light' ? 0.55 : 0.4

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-labelledby="t d">
<title id="t">Loom, ${plan.version}</title>
<desc id="d">Abstract woven field: undyed warp and weft with blocks of dyed weft laid in, generated from the release notes of ${plan.version}.</desc>
<defs>
<filter id="hand" filterUnits="userSpaceOnUse" x="-20" y="-20" width="${WIDTH + 40}" height="${HEIGHT + 40}" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="${hand.wobbleFrequency.join(' ')}" numOctaves="2" seed="${hand.seed}" result="slow"/>
<feDisplacementMap in="SourceGraphic" in2="slow" scale="${hand.wobble}" xChannelSelector="R" yChannelSelector="G" result="bent"/>
<feTurbulence type="fractalNoise" baseFrequency="0.9 0.35" numOctaves="1" seed="${hand.seed + 3}" result="quick"/>
<feDisplacementMap in="bent" in2="quick" scale="${hand.fuzz}" xChannelSelector="R" yChannelSelector="G" result="fuzzed"/>
<feGaussianBlur in="fuzzed" stdDeviation="0.45"/>
</filter>
<filter id="fibre" filterUnits="userSpaceOnUse" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="0.7 0.18" numOctaves="2" seed="${hand.seed + 11}"/>
<feColorMatrix type="matrix" values="0 0 0 0 ${fr} 0 0 0 0 ${fg} 0 0 0 0 ${fb} ${grainAlpha} 0 0 0 ${round(-grainAlpha * 0.42, 3)}"/>
</filter>
</defs>
<rect width="${WIDTH}" height="${HEIGHT}" fill="${palette.ground}"/>
<g filter="url(#hand)">
<g stroke-width="${round(WARP_PITCH * WARP_WIDTH, 2)}" fill="none"><path stroke="${palette.warp}" d="${warpPaths.warp.join('')}"/><path stroke="${palette.warpShade}" d="${warpPaths.warpShade.join('')}"/></g>
${group(floats, weftWidth, 'round')}
${group(fine, weftWidth * 0.34, 'round')}
${group(solid, weftWidth * 1.45, 'butt')}
<g stroke="${palette.warp}" stroke-width="${round(weftWidth * 0.86, 2)}" fill="none" opacity="${mode === 'light' ? 0.36 : 0.4}">${ribs.join('')}</g>
</g>
<rect width="${WIDTH}" height="${HEIGHT}" filter="url(#fibre)" opacity="0.65"/>
</svg>
`
}

// ---------------------------------------------------------------- the CLI

function describe(plan, themes) {
  const counts = {}
  for (const block of plan.blocks) counts[block.kind] = (counts[block.kind] || 0) + 1
  return {
    version: plan.version,
    seed: plan.seed,
    themes,
    lead: plan.lead,
    shares: plan.shares,
    cloth: {
      ground: plan.ground,
      beat: plan.beat,
      unevenness: plan.unevenness,
      picks: plan.picks.length,
      warps: plan.warps,
      blocks: counts,
      pulses: plan.pulses.length,
      brokenWarps: plan.breaks.length,
      floats: plan.floats.length,
      abrash: plan.abrash,
      wobble: plan.hand.wobble,
      wobbleFrequency: plan.hand.wobbleFrequency,
    },
  }
}

export function render(version, notes) {
  const themes = readThemes(notes)
  const plan = planPiece(version, themes, hashString(`loom:${version}`))
  return { plan, themes, light: piece(plan, 'light'), dark: piece(plan, 'dark') }
}

// JSON as the repo's Prettier prints it: objects one key per line, an array of plain values on one
// line when it fits in the print width, so the committed manifest passes the format check as written.
const PRINT_WIDTH = 110
function toJson(value) {
  const text = JSON.stringify(value, null, 2)
  return `${text.replace(
    /^( *)("[^"]*": )?\[\n((?:\1 {2}(?:"[^"]*"|-?[\d.e+-]+|true|false|null),?\n)+)\1\](,?)$/gm,
    (whole, indent, key = '', body, comma) => {
      const items = body
        .trim()
        .split(/,?\n\s*/)
        .map((item) => item.replace(/,$/, ''))
      const line = `${indent}${key}[${items.join(', ')}]${comma}`
      return line.length <= PRINT_WIDTH ? line : whole
    },
  )}\n`
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (!['--out', '--version', '--notes'].includes(flag)) throw new Error(`Unknown argument: ${flag}`)
    const value = argv[i + 1]
    if (value === undefined || value === '' || value.startsWith('--'))
      throw new Error(`${flag} needs a value`)
    args[flag.slice(2)] = value
    i++
  }
  if (Boolean(args.version) !== Boolean(args.notes)) throw new Error('--version and --notes go together')
  return args
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exit(2)
  }
  const out = args.out ?? DEFAULT_OUT
  mkdirSync(out, { recursive: true })
  const jobs = args.version
    ? [[args.version, args.notes]]
    : SERIES.map((version) => [version, join(NOTES, `${version}.md`)])
  const releases = []
  for (const [version, notesPath] of jobs) {
    const { plan, themes, light, dark } = render(version, readFileSync(notesPath, 'utf8'))
    writeFileSync(join(out, `${version}-light.svg`), light)
    writeFileSync(join(out, `${version}-dark.svg`), dark)
    releases.push({
      ...describe(plan, themes),
      files: {
        light: `${version}-light.svg`,
        dark: `${version}-dark.svg`,
      },
      bytes: { light: Buffer.byteLength(light), dark: Buffer.byteLength(dark) },
    })
    process.stdout.write(`${version}: ${Buffer.byteLength(light)} / ${Buffer.byteLength(dark)} bytes\n`)
  }
  if (!args.version) {
    const manifest = {
      direction: 'loom',
      madeBy: 'Claude Opus 5.5 (medium effort)',
      generator: 'scripts/release-art/loom.mjs',
      canvas: { width: WIDTH, height: HEIGHT },
      palette: { hexes: PALETTE_HEXES, light: PALETTE.light, dark: PALETTE.dark },
      thread: { warpPitch: WARP_PITCH, warpWidth: round(WARP_PITCH * WARP_WIDTH, 2), weftWidth: WEFT_WIDTH },
      releases,
    }
    writeFileSync(join(out, 'manifest.json'), toJson(manifest))
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
