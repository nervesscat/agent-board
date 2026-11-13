#!/usr/bin/env node
// Release artwork: retro blueprint.
//
// The approved contour-field direction, printed as a cyanotype contact print: the iso-lines are
// exposed white, the ground is the prussian wash, a blurred mid-wash plate sits behind the linework,
// the chemistry failed in patches (so lines fade there instead of ending at a cut), and the paper's
// fibre and grain sit over all of it. The edges dissolve into the ground, the way an unexposed
// print does.
//
// A release's notes are read for three themes — many hands, precision, wayfinding — and those, with
// the version's seed, set the field: how many summits, how tight the interval, where the wash sat,
// how much of the linework the chemistry ate, and where the ground is quiet. Nothing is random at
// render time: the same version and notes write the same bytes on every run.
//
// Usage:
//   node scripts/release-art/retro-blueprint.mjs                  # regenerate the committed series
//   node scripts/release-art/retro-blueprint.mjs --out /tmp/art   # write somewhere else
//   node scripts/release-art/retro-blueprint.mjs --version v0.3.0 \
//     --notes scripts/release-art/notes/v0.3.0.md --out /tmp/art
//
// A new release needs nothing but its notes: drop `gh release view vX.Y.Z --json body --jq .body`
// into scripts/release-art/notes/vX.Y.Z.md and run the first command again. `--version` renders one
// release for a look; only the full run writes the series manifest.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const NOTES_DIR = join(ROOT, 'scripts/release-art/notes')
const ASSET_DIR = join(ROOT, 'src/assets/release-art/retro-blueprint')

const WIDTH = 1600
const HEIGHT = 900
const CELL = 7
const SIMPLIFY = 1.6

// The lane's fixed palette. Nothing else is painted: every visible ink is one of these four, and
// pure black and white appear only inside the exposure mask, where they are opacity, not pigment.
export const PALETTE = {
  ground: '#0E2438',
  exposed: '#EAF3F8',
  wash: '#7FB6D9',
  shadow: '#081826',
}

const VARIANTS = {
  dark: {
    // The print as it comes off the bath: a deep prussian sheet, lines lifted out of it.
    ground: PALETTE.ground,
    line: PALETTE.exposed,
    plate: PALETTE.wash,
    patch: PALETTE.wash,
    highlight: PALETTE.exposed,
    depth: PALETTE.shadow,
    deep: PALETTE.shadow,
    plateOpacity: 0.3,
    bloomOpacity: 0.34,
    ghostOpacity: 0.18,
    lineOpacity: { light: 0.3, medium: 0.52, heavy: 0.84 },
    washScale: 1.25,
    fibreBlend: 'screen',
    fibreOpacity: 0.06,
    grainBlend: 'screen',
    grainOpacity: 0.1,
  },
  light: {
    // The same print on paper: the sheet is the ground, the image sits in it as blue.
    ground: PALETTE.exposed,
    line: PALETTE.ground,
    plate: PALETTE.wash,
    patch: PALETTE.wash,
    highlight: PALETTE.wash,
    depth: PALETTE.ground,
    deep: PALETTE.shadow,
    plateOpacity: 0.42,
    bloomOpacity: 0.2,
    ghostOpacity: 0.16,
    lineOpacity: { light: 0.42, medium: 0.68, heavy: 0.95 },
    washScale: 2.3,
    fibreBlend: 'multiply',
    fibreOpacity: 0.05,
    grainBlend: 'multiply',
    grainOpacity: 0.09,
  },
}

// Three line weights, in pixels at 1600 wide. The heaviest survives the card's thumbnail at a third
// of the size; the lightest is texture and is allowed to dissolve.
const WEIGHTS = { light: 1.15, medium: 2.05, heavy: 3.3 }

const THEME_WORDS = {
  // Many hands: agents, shared tickets, lanes, reviews, decisions — the release as a crowd.
  hands: [
    'agent',
    'shared',
    'sharing',
    'ticket',
    'lane',
    'delegat',
    'review',
    'post',
    'repl',
    'decision',
    'mention',
    'collab',
    'tool',
    'forum',
    'pick',
  ],
  // Precision: small fixes that hold — a still hand, a tight interval, less chemistry drifting.
  precision: [
    'focus',
    'ring',
    'cache',
    'safe',
    'sticky',
    'proxy',
    'clock',
    'cap',
    'retry',
    'keep',
    'hold',
    'count',
    'guard',
    'exact',
    'fix',
    'fit',
    'warm',
    'quiet',
    'websocket',
    'sync',
  ],
  // Wayfinding: things moved, split, renamed, removed — a way washed through the field.
  wayfinding: [
    'move',
    'split',
    'remove',
    'menu',
    'palette',
    'rename',
    'fold',
    'find',
    'search',
    'settings',
    'reorganiz',
    'resume',
    'cleanup',
    'command',
    'tab',
  ],
}

// ---------------------------------------------------------------- deterministic randomness

function hashString(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
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

function latticeNoise(seed, index) {
  let hash = Math.imul(seed ^ Math.imul(index, 0x9e3779b1), 0x27d4eb2d)
  hash ^= hash >>> 15
  hash = Math.imul(hash, 0x85ebca6b)
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35)
  hash ^= hash >>> 16
  return (hash >>> 0) / 4294967296
}

// Smooth one-dimensional value noise: the slow drift that lets parallel lines breathe apart.
function smoothNoise(seed, at) {
  const index = Math.floor(at)
  const fraction = at - index
  const eased = fraction * fraction * (3 - 2 * fraction)
  const a = latticeNoise(seed, index)
  const b = latticeNoise(seed, index + 1)
  return a + (b - a) * eased
}

function valueNoise(seed, x, y) {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const ux = x - x0
  const uy = y - y0
  const ease = (t) => t * t * (3 - 2 * t)
  const corner = (i, j) => latticeNoise(seed, Math.imul(i, 73856093) ^ Math.imul(j, 19349663))
  const a = corner(x0, y0)
  const b = corner(x0 + 1, y0)
  const c = corner(x0, y0 + 1)
  const d = corner(x0 + 1, y0 + 1)
  const sx = ease(ux)
  const sy = ease(uy)
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy
}

// Three octaves of value noise: the ground under the summits, so lines bend the way ground does
// instead of closing into clean ovals around each peak.
function relief(seed, x, y) {
  let total = 0
  let amplitude = 1
  let frequency = 1
  let normal = 0
  for (let octave = 0; octave < 3; octave++) {
    total += amplitude * valueNoise(seed + octave * 1013, (x * frequency) / 390, (y * frequency) / 390)
    normal += amplitude
    amplitude *= 0.52
    frequency *= 2.1
  }
  return total / normal
}

// ---------------------------------------------------------------- reading a release

function countStems(body, stems) {
  let total = 0
  for (const stem of stems) {
    total += (body.match(new RegExp(`(?:^|[^a-z])${stem}`, 'g')) || []).length
  }
  return total
}

export function readThemes(notes) {
  const body = notes.toLowerCase()
  const bullets = (body.match(/^\s*[*+-]\s/gm) || []).length || 1
  const scale = Math.sqrt(bullets)
  const saturate = (raw, knee) => 1 - Math.exp(-raw / knee)
  return {
    bullets,
    density: Math.min(1, Math.log10(1 + bullets) / Math.log10(201)),
    hands: saturate(countStems(body, THEME_WORDS.hands) / scale, 10),
    precision: saturate(countStems(body, THEME_WORDS.precision) / scale, 4),
    wayfinding: saturate(countStems(body, THEME_WORDS.wayfinding) / scale, 5),
  }
}

// ---------------------------------------------------------------- the plan

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

export function planPiece(version, themes, seed) {
  const random = mulberry32(seed)
  const jitter = (amount) => (random() - 0.5) * amount

  const summits = clamp(
    Math.round(
      4 + themes.hands * 11 + themes.density * 7 - themes.precision * 4 - themes.wayfinding * 3 + jitter(2),
    ),
    4,
    16,
  )
  const levels = clamp(
    Math.round(12 + themes.precision * 7 + themes.density * 6 - themes.wayfinding * 1 + jitter(2)),
    10,
    21,
  )
  // A held ridge when the release was about things holding; a cleared way through the wash when it
  // was about moving things and dropping clutter. The two pull against each other in a busy release.
  const ridge = themes.precision > 0.55
  const corridor = themes.wayfinding - themes.precision * 0.8 > 0.25

  return {
    version,
    seed,
    themes,
    summits,
    levels,
    ridge,
    corridor,
    // The hand behind the lines and the interval it plots: precision steadies both.
    wobble: clamp(1.85 - themes.precision * 0.7 + themes.wayfinding * 0.25, 0.9, 2.3),
    intervalJitter: clamp(0.012 - themes.precision * 0.009, 0.002, 0.014),
    // The chemistry: how many tonal patches sit under the field, and how much of the linework it ate.
    patches: Math.round(3 + themes.density * 4 + themes.hands * 3 + jitter(1)),
    fades: Math.round(6 + themes.density * 16 + themes.wayfinding * 8 + jitter(2)),
    haze: Math.round(3 + themes.density * 7 + jitter(2)),
    bloom: clamp(0.2 + themes.density * 0.16 + themes.hands * 0.06, 0.2, 0.42),
    bleed: clamp(0.7 + (1 - themes.precision) * 0.45 + themes.density * 0.15, 0.7, 1.3),
    bloomRadius: clamp(2.6 + themes.density * 1.4, 2.6, 4.2),
    weights: WEIGHTS,
  }
}

// ---------------------------------------------------------------- terrain

function makeTerrain(plan, seed) {
  const random = mulberry32(seed ^ 0x51ed270b)
  const peaks = []
  const range = (low, high) => low + random() * (high - low)

  // Broad swells under everything: the field has a shape beyond its summits, so lines cross the
  // whole frame instead of closing into a lone hill.
  for (let i = 0; i < 3; i++) {
    peaks.push({
      cx: range(-0.1, 1.1) * WIDTH,
      cy: range(-0.1, 1.1) * HEIGHT,
      sx: range(0.42, 0.85) * WIDTH,
      sy: range(0.35, 0.8) * HEIGHT,
      rotation: range(-0.2, 0.2),
      amplitude: range(0.16, 0.3),
    })
  }

  if (plan.ridge) {
    // One long crest off the middle of the frame, its ends running off the edges: a thing held,
    // never a bullseye in the centre of the piece.
    peaks.push({
      cx: range(0.28, 0.72) * WIDTH,
      cy: (random() < 0.5 ? range(0.2, 0.37) : range(0.63, 0.8)) * HEIGHT,
      sx: range(0.5, 0.64) * WIDTH,
      sy: range(0.07, 0.1) * HEIGHT,
      rotation: random() < 0.5 ? range(-0.55, -0.14) : range(0.14, 0.55),
      amplitude: range(0.62, 0.78),
    })
    for (let i = 0; i < 2; i++) {
      peaks.push({
        cx: range(0.1, 0.9) * WIDTH,
        cy: range(0.2, 0.8) * HEIGHT,
        sx: range(0.1, 0.18) * WIDTH,
        sy: range(0.08, 0.14) * HEIGHT,
        rotation: range(-0.5, 0.5),
        amplitude: range(0.3, 0.45),
      })
    }
  }

  const base = clamp(300 - plan.summits * 12, 128, 260)
  for (let i = 0; i < plan.summits; i++) {
    const cx = range(-0.08, 1.08) * WIDTH
    const cy = range(-0.05, 1.05) * HEIGHT
    // Stretched summits: an elongated crest draws a line that narrows and opens again, instead of a
    // clean ring with a logo's symmetry.
    const aspect = range(0.55, 2.35)
    peaks.push({
      cx,
      cy,
      sx: base * range(0.6, 1.2) * aspect,
      sy: (base * range(0.55, 1.1)) / aspect,
      rotation: range(-1.1, 1.1),
      amplitude: range(0.28, 0.68),
    })
    // A shoulder: rings around one summit lean into the next and stop being circles.
    if (random() < 0.55) {
      peaks.push({
        cx: cx + range(-0.14, 0.14) * WIDTH,
        cy: cy + range(-0.1, 0.1) * HEIGHT,
        sx: base * range(0.3, 0.7),
        sy: base * range(0.25, 0.6),
        rotation: range(-1.2, 1.2),
        amplitude: range(0.15, 0.4),
      })
    }
  }

  const warp = 0.18 + plan.themes.density * 0.12
  const phases = [random(), random(), random(), random()].map((n) => n * Math.PI * 2)
  const reliefSeed = seed ^ 0x1b873593
  const reliefStrength = 0.32 + (1 - plan.themes.precision) * 0.22
  const sample = (x, y) => {
    const wx =
      x +
      warp * WIDTH * 0.14 * Math.sin(y / (HEIGHT * 0.23) + phases[0]) +
      warp * WIDTH * 0.055 * Math.sin(y / (HEIGHT * 0.07) + phases[1])
    const wy =
      y +
      warp * HEIGHT * 0.14 * Math.cos(x / (WIDTH * 0.19) + phases[2]) +
      warp * HEIGHT * 0.06 * Math.cos(x / (WIDTH * 0.06) + phases[3])
    let height = 0
    for (const peak of peaks) {
      const dx = wx - peak.cx
      const dy = wy - peak.cy
      const cos = Math.cos(peak.rotation)
      const sin = Math.sin(peak.rotation)
      const u = (dx * cos + dy * sin) / peak.sx
      const v = (-dx * sin + dy * cos) / peak.sy
      height += peak.amplitude * Math.exp(-0.5 * (u * u + v * v))
    }
    return height + (relief(reliefSeed, x, y) - 0.5) * reliefStrength
  }
  return { sample, peaks }
}

function fieldGrid(sample) {
  const nx = Math.ceil(WIDTH / CELL) + 1
  const ny = Math.ceil(HEIGHT / CELL) + 1
  const values = new Float64Array(nx * ny)

  let low = Infinity
  let high = -Infinity
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const value = sample(i * CELL, j * CELL)
      values[j * nx + i] = value
      if (value < low) low = value
      if (value > high) high = value
    }
  }
  const span = high - low || 1
  for (let k = 0; k < values.length; k++) values[k] = (values[k] - low) / span
  return { nx, ny, values }
}

// ---------------------------------------------------------------- iso-lines

function isoLines(grid, level) {
  const { nx, ny, values } = grid
  const at = (i, j) => values[j * nx + i]
  const segments = []

  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const h00 = at(i, j)
      const h10 = at(i + 1, j)
      const h01 = at(i, j + 1)
      const h11 = at(i + 1, j + 1)
      let mask = 0
      if (h00 > level) mask |= 1
      if (h10 > level) mask |= 2
      if (h11 > level) mask |= 4
      if (h01 > level) mask |= 8
      if (mask === 0 || mask === 15) continue

      const x0 = i * CELL
      const y0 = j * CELL
      const top = () => [x0 + (CELL * (level - h00)) / (h10 - h00), y0]
      const right = () => [x0 + CELL, y0 + (CELL * (level - h10)) / (h11 - h10)]
      const bottom = () => [x0 + (CELL * (level - h01)) / (h11 - h01), y0 + CELL]
      const left = () => [x0, y0 + (CELL * (level - h00)) / (h01 - h00)]

      switch (mask) {
        case 1:
        case 14:
          segments.push([left(), top()])
          break
        case 2:
        case 13:
          segments.push([top(), right()])
          break
        case 3:
        case 12:
          segments.push([left(), right()])
          break
        case 4:
        case 11:
          segments.push([right(), bottom()])
          break
        case 6:
        case 9:
          segments.push([top(), bottom()])
          break
        case 7:
        case 8:
          segments.push([left(), bottom()])
          break
        case 5: {
          const centre = (h00 + h10 + h01 + h11) / 4
          if (centre > level) segments.push([top(), right()], [left(), bottom()])
          else segments.push([left(), top()], [right(), bottom()])
          break
        }
        case 10: {
          const centre = (h00 + h10 + h01 + h11) / 4
          if (centre > level) segments.push([left(), top()], [right(), bottom()])
          else segments.push([top(), right()], [left(), bottom()])
          break
        }
        default:
          break
      }
    }
  }
  return stitch(segments)
}

function stitch(segments) {
  const key = (p) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`
  const ends = new Map()
  for (let index = 0; index < segments.length; index++) {
    for (const end of segments[index]) {
      const k = key(end)
      const list = ends.get(k)
      if (list) list.push(index)
      else ends.set(k, [index])
    }
  }

  const used = new Uint8Array(segments.length)
  const lines = []
  const next = (k) => (ends.get(k) || []).find((index) => !used[index])

  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue
    used[start] = 1
    const line = [segments[start][0], segments[start][1]]

    for (;;) {
      const k = key(line[line.length - 1])
      const index = next(k)
      if (index === undefined) break
      used[index] = 1
      const segment = segments[index]
      line.push(key(segment[0]) === k ? segment[1] : segment[0])
    }

    for (;;) {
      const k = key(line[0])
      const index = next(k)
      if (index === undefined) break
      used[index] = 1
      const segment = segments[index]
      line.unshift(key(segment[0]) === k ? segment[1] : segment[0])
    }

    lines.push(line)
  }
  return lines
}

function segmentDistance(p, a, b) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(p[0] - a[0], p[1] - a[1])
  const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared, 0, 1)
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

function simplify(points, tolerance) {
  if (points.length < 3) return points
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack = [[0, points.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    let furthest = -1
    let index = -1
    for (let i = a + 1; i < b; i++) {
      const distance = segmentDistance(points[i], points[a], points[b])
      if (distance > furthest) {
        furthest = distance
        index = i
      }
    }
    if (furthest > tolerance && index > 0) {
      keep[index] = 1
      stack.push([a, index], [index, b])
    }
  }
  return points.filter((_, i) => keep[i])
}

// One round of corner-cutting: a plotted line that was later gone over by hand is not made of
// straight runs between vertices.
function smooth(points) {
  if (points.length < 3) return points
  const out = [points[0]]
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    out.push([a[0] * 0.72 + b[0] * 0.28, a[1] * 0.72 + b[1] * 0.28])
    out.push([a[0] * 0.28 + b[0] * 0.72, a[1] * 0.28 + b[1] * 0.72])
  }
  out.push(points[points.length - 1])
  return out
}

// A hand, not a plotter: offset every point along its normal by slow noise, so parallel lines drift
// near and apart instead of holding a constant distance.
function breathe(points, amplitude, seed) {
  const out = []
  let travelled = 0
  for (let i = 0; i < points.length; i++) {
    if (i > 0) travelled += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
    const previous = points[Math.max(0, i - 1)]
    const following = points[Math.min(points.length - 1, i + 1)]
    let nx = -(following[1] - previous[1])
    let ny = following[0] - previous[0]
    const length = Math.hypot(nx, ny) || 1
    nx /= length
    ny /= length
    const slow = (smoothNoise(seed, travelled * 0.02) - 0.5) * 2 * amplitude * 0.72
    const quick = (smoothNoise(seed + 17, travelled * 0.09) - 0.5) * 2 * amplitude * 0.28
    out.push([points[i][0] + nx * (slow + quick), points[i][1] + ny * (slow + quick)])
  }
  return out
}

function runLength(points) {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
  }
  return total
}

function pathData(points) {
  const round = (n) => Math.round(n)
  let data = `M${round(points[0][0])} ${round(points[0][1])}L`
  for (let i = 1; i < points.length; i++) {
    data += `${i > 1 ? ' ' : ''}${round(points[i][0])} ${round(points[i][1])}`
  }
  return data
}

// ---------------------------------------------------------------- chemistry

// The wash under the field: broad, soft patches of tone, mostly hung on high ground so the tonal
// blotches agree with the terrain rather than floating over it.
function makeWash(plan, seed, terrain) {
  const random = mulberry32(seed ^ 0x4f1bbcdc)
  const range = (low, high) => low + random() * (high - low)
  const patches = []

  // One broad tonal drift across the whole sheet: the print is not evenly exposed corner to corner,
  // and this is what still reads as uneven chemistry when the piece is shown small.
  patches.push({
    cx: range(0.1, 0.9) * WIDTH,
    cy: range(0.1, 0.9) * HEIGHT,
    rx: range(620, 1000),
    ry: range(380, 620),
    rotation: range(-0.9, 0.9),
    tone: 'patch',
    opacity: round3(range(0.07, 0.13)),
  })

  // A second drift, off the first one's shoulder: the chemistry sat heavier in more than one place.
  patches.push({
    cx: range(0.05, 0.95) * WIDTH,
    cy: range(0.05, 0.95) * HEIGHT,
    rx: range(520, 860),
    ry: range(320, 540),
    rotation: range(-0.9, 0.9),
    tone: 'depth',
    opacity: round3(range(0.04, 0.08)),
  })

  // A third drift, so no corner of the sheet is left as bare paper: the wash is uneven, not absent.
  patches.push({
    cx: range(0.02, 0.98) * WIDTH,
    cy: range(0.02, 0.98) * HEIGHT,
    rx: range(480, 800),
    ry: range(300, 520),
    rotation: range(-0.9, 0.9),
    tone: 'patch',
    opacity: round3(range(0.05, 0.09)),
  })

  const tall = terrain.peaks.filter((peak) => peak.amplitude > 0.25)
  for (let i = 0; i < plan.patches; i++) {
    const host = tall.length && random() < 0.68 ? tall[Math.floor(random() * tall.length)] : null
    const roll = random()
    patches.push({
      cx: host ? host.cx + range(-0.08, 0.08) * WIDTH : range(-0.05, 1.05) * WIDTH,
      cy: host ? host.cy + range(-0.08, 0.08) * HEIGHT : range(-0.05, 1.05) * HEIGHT,
      rx: range(110, 360) * (host ? 0.85 : 1.1),
      ry: range(80, 300),
      rotation: range(-1.2, 1.2),
      tone: roll < 0.62 ? 'patch' : roll < 0.85 ? 'highlight' : 'depth',
      opacity: round3(roll < 0.62 ? range(0.06, 0.15) : roll < 0.85 ? range(0.04, 0.09) : range(0.05, 0.11)),
    })
  }

  // A few small splashes with a sharper edge: where a drop of sensitiser sat on the paper.
  const splashes = Math.round(3 + plan.themes.density * 6)
  for (let i = 0; i < splashes; i++) {
    const radius = range(3, 13)
    patches.push({
      cx: range(0.04, 0.96) * WIDTH,
      cy: range(0.04, 0.92) * HEIGHT,
      rx: radius,
      ry: radius * range(0.7, 1.3),
      rotation: range(-1.4, 1.4),
      tone: random() < 0.5 ? 'patch' : random() < 0.75 ? 'highlight' : 'deep',
      opacity: round3(range(0.1, 0.2)),
      sharp: true,
    })
  }
  return patches
}

// Where the chemistry failed: soft dark shapes in the exposure mask, so the linework fades out
// there instead of being cut out of it. A wayfinding release also gets a broad, quiet corridor.
function makeFades(plan, seed) {
  const random = mulberry32(seed ^ 0x2f6b1d3d)
  const range = (low, high) => low + random() * (high - low)
  const shapes = []

  if (plan.corridor) {
    const angle = range(-0.34, 0.34)
    shapes.push({
      cx: range(0.38, 0.62) * WIDTH,
      cy: range(0.36, 0.62) * HEIGHT,
      rx: WIDTH * 0.68,
      ry: range(0.06, 0.085) * HEIGHT,
      rotation: angle,
      opacity: 0.78,
      haze: false,
    })
    if (plan.themes.wayfinding > 0.62) {
      shapes.push({
        cx: range(0.2, 0.8) * WIDTH,
        cy: range(0.24, 0.76) * HEIGHT,
        rx: WIDTH * 0.42,
        ry: range(0.035, 0.06) * HEIGHT,
        rotation: angle + range(0.9, 1.4),
        opacity: 0.6,
        haze: false,
      })
    }
  }

  // Patches where the exposure failed: a few are large enough to read as weather on the sheet, the
  // rest are small bites of the same chemistry.
  for (let i = 0; i < plan.fades; i++) {
    const large = random() < 0.34
    shapes.push({
      cx: range(-0.03, 1.03) * WIDTH,
      cy: range(-0.03, 1.03) * HEIGHT,
      rx: large ? range(70, 240) : range(14, 64),
      ry: large ? range(50, 170) : range(10, 50),
      rotation: range(-1.4, 1.4),
      opacity: round3(large ? range(0.45, 0.8) : range(0.35, 0.75)),
      haze: false,
    })
  }

  // Haze: the same failure, further gone — the line is still there, only half developed.
  for (let i = 0; i < plan.haze; i++) {
    shapes.push({
      cx: range(-0.02, 1.02) * WIDTH,
      cy: range(-0.02, 1.02) * HEIGHT,
      rx: range(60, 220),
      ry: range(45, 180),
      rotation: range(-1.4, 1.4),
      opacity: round3(range(0.18, 0.42)),
      haze: true,
    })
  }

  for (const shape of shapes) {
    shape.cos = Math.cos(shape.rotation)
    shape.sin = Math.sin(shape.rotation)
  }
  return shapes
}

function ellipse(shape, fill, extra = '') {
  return `<ellipse cx="${Math.round(shape.cx)}" cy="${Math.round(shape.cy)}" rx="${Math.round(
    shape.rx,
  )}" ry="${Math.round(shape.ry)}" transform="rotate(${round1(
    (shape.rotation * 180) / Math.PI,
  )} ${Math.round(shape.cx)} ${Math.round(shape.cy)})" fill="${fill}"${extra}/>`
}

function round1(value) {
  return Math.round(value * 10) / 10
}

function round3(value) {
  return Math.round(value * 1000) / 1000
}

// ---------------------------------------------------------------- SVG

function piece(plan, variantName) {
  const palette = VARIANTS[variantName]
  const seed = plan.seed
  const label = plan.version.replace(/^v/, '')
  const { sample, peaks } = makeTerrain(plan, seed)
  const grid = fieldGrid(sample)
  const random = mulberry32(seed ^ 0x7a3c93f1)

  const levelValues = []
  for (let i = 0; i < plan.levels; i++) {
    // Intervals, not quite even: a plotted field with the plotter's hand in it.
    const base = 0.05 + (i / (plan.levels - 1)) * 0.9
    levelValues.push(base + (random() - 0.5) * plan.intervalJitter)
  }

  const byLevel = levelValues.map((level, index) => {
    const rings = []
    const opens = []
    for (const line of isoLines(grid, level)
      .map((points) => simplify(points, SIMPLIFY))
      .filter((points) => points.length > 2)
      .map((points) => smooth(points))
      .map((points) => breathe(points, plan.wobble, seed + index * 131))) {
      const closed =
        Math.abs(line[0][0] - line[line.length - 1][0]) < 0.5 &&
        Math.abs(line[0][1] - line[line.length - 1][1]) < 0.5
      if (closed) rings.push(line)
      else opens.push(line)
    }
    return { index, level, rings, opens }
  })

  // The mid-wash plate: a broad blurred stroke along one measured contour, so the tone follows
  // ground that was actually plotted instead of pouring a disc over a summit.
  const plateIndex = Math.round(plan.levels * 0.62)
  const plateLevel = byLevel[plateIndex]
  const plateLines = plateLevel
    ? [...plateLevel.rings, ...plateLevel.opens].sort((a, b) => runLength(b) - runLength(a)).slice(0, 2)
    : []
  const plateData = plateLines
    .filter((line) => runLength(line) > 40)
    .map(pathData)
    .join('')
  const plate = plateData
    ? `<g filter="url(#bleed)" fill="none" stroke="${palette.plate}" stroke-opacity="${palette.plateOpacity}" stroke-width="54" stroke-linecap="round"><path d="${plateData}"/></g>`
    : ''

  // Line classes: the pencil bears down on some lines and barely touches others, and every fifth
  // level is dug deeper. A few of the heaviest are repeated, once blurred (the bloom where the
  // chemistry soaked along a line) and once offset in mid wash (a second contact print a hair off).
  const classes = { heavy: [], medium: [], light: [] }
  const heavyShare = 0.07 + (1 - plan.themes.density) * 0.1

  for (const { index, rings, opens } of byLevel) {
    const indexLine = index % 5 === 0
    for (const line of [...opens, ...rings]) {
      const roll = random()
      const name = indexLine || roll < heavyShare ? 'heavy' : roll < heavyShare + 0.32 ? 'medium' : 'light'
      if (runLength(line) < 14) continue
      classes[name].push(pathData(line))
    }
  }

  const lineGroups = ['light', 'medium', 'heavy']
    .map((name) => {
      const paths = classes[name]
      if (!paths.length) return ''
      return `<g stroke="${palette.line}" stroke-opacity="${palette.lineOpacity[name]}" stroke-width="${plan.weights[name]}">${paths
        .map((data) => `<path d="${data}"/>`)
        .join('')}</g>`
    })
    .join('')

  const longest = (name, count) =>
    [...classes[name]]
      .sort((a, b) => b.length - a.length)
      .slice(0, count)
      .map((data) => `<path d="${data}"/>`)
      .join('')

  const bloomPaths = longest('heavy', 18) + longest('medium', 8)
  const bloom = bloomPaths
    ? `<g filter="url(#bloom)" stroke="${palette.line}" stroke-opacity="${palette.bloomOpacity}" stroke-width="${plan.weights.heavy}" stroke-linecap="round">${bloomPaths}</g>`
    : ''
  const ghostPaths = longest('heavy', 10)
  const ghost = ghostPaths
    ? `<g transform="translate(1.7 -1.2)" stroke="${palette.plate}" stroke-opacity="${palette.ghostOpacity}" stroke-width="${plan.weights.medium}">${ghostPaths}</g>`
    : ''

  const wash = makeWash(plan, seed, { peaks })
  const washOpacity = (shape) => Math.min(0.6, round3(shape.opacity * (palette.washScale ?? 1)))
  const washShapes = wash
    .filter((shape) => !shape.sharp)
    .map((shape) => ellipse(shape, palette[shape.tone] || palette.patch, ` opacity="${washOpacity(shape)}"`))
    .join('')
  const splashes = wash
    .filter((shape) => shape.sharp)
    .map((shape) => ellipse(shape, palette[shape.tone] || palette.patch, ` opacity="${washOpacity(shape)}"`))
    .join('')

  const fades = makeFades(plan, seed)
  const maskShapes = fades
    .map((shape) =>
      ellipse(
        shape,
        '#000',
        ` opacity="${shape.opacity}"${shape.haze ? ' filter="url(#haze)"' : ' filter="url(#feather)"'}`,
      ),
    )
    .join('')

  const grainSeed = (plan.seed % 997) + 1
  const fibreSeed = ((plan.seed >>> 8) % 991) + 1

  // The mask is opacity, so it speaks in true black and white only: a white sheet with black where
  // the exposure failed, its border and its foot bled into the ground.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="title describe">
<title id="title">Cyanotype contour field, CrossBoard ${label}</title>
<desc id="describe">Abstract contour lines on an unevenly exposed prussian ground: a washed mid-tone plate, paper fibre and grain, and edges that fade into the sheet.</desc>
<defs><radialGradient id="edge" cx="0.5" cy="0.46" r="0.78"><stop offset="0.58" stop-color="#fff"/><stop offset="0.86" stop-color="#b4b4b4"/><stop offset="1" stop-color="#2e2e2e"/></radialGradient><linearGradient id="foot" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.9"/></linearGradient><filter id="bleed" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${Math.round(20 + plan.bleed * 12)}"/></filter><filter id="feather" x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation="32"/></filter><filter id="haze" x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation="40"/></filter><filter id="bloom" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="${round1(plan.bloomRadius)}"/></filter><filter id="fibre" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.006 0.55" numOctaves="2" seed="${fibreSeed}" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><filter id="grain" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.92" numOctaves="3" seed="${grainSeed}" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><mask id="exposure" maskUnits="userSpaceOnUse" x="-100" y="-100" width="1800" height="1100"><rect width="${WIDTH}" height="${HEIGHT}" fill="url(#edge)"/><rect y="740" width="${WIDTH}" height="160" fill="url(#foot)"/>${maskShapes}</mask></defs>
<rect width="${WIDTH}" height="${HEIGHT}" fill="${palette.ground}"/>
<g filter="url(#bleed)">${washShapes}</g>${plate}
<g mask="url(#exposure)" fill="none" stroke-linecap="round" stroke-linejoin="round">${bloom}${ghost}${lineGroups}</g>
<g fill="${palette.patch}">${splashes}</g>
<rect width="${WIDTH}" height="${HEIGHT}" filter="url(#fibre)" style="mix-blend-mode:${palette.fibreBlend}" opacity="${palette.fibreOpacity}"/>
<rect width="${WIDTH}" height="${HEIGHT}" filter="url(#grain)" style="mix-blend-mode:${palette.grainBlend}" opacity="${palette.grainOpacity}"/>
</svg>
`
}

function variantsFor(plan) {
  return ['light', 'dark'].map((variant) => {
    const svg = piece(plan, variant)
    return { variant, svg }
  })
}

// ---------------------------------------------------------------- plan to files

function parseArgs(argv) {
  const args = { out: null, version: null, notes: null }
  const valueOf = (flag, index) => {
    const value = argv[index]
    if (value === undefined || value === '') throw new Error(`${flag} needs a value`)
    return value
  }

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--out') args.out = valueOf(flag, ++i)
    else if (flag === '--version') args.version = valueOf(flag, ++i)
    else if (flag === '--notes') args.notes = valueOf(flag, ++i)
    else if (flag === '--help' || flag === '-h') {
      console.log(
        'Usage: node scripts/release-art/retro-blueprint.mjs [--version vX.Y.Z --notes FILE] [--out DIR]',
      )
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${flag}`)
    }
  }
  if ((args.version === null) !== (args.notes === null)) {
    throw new Error('--version and --notes go together')
  }
  return args
}

function notesFiles() {
  return readdirSync(NOTES_DIR)
    .filter((file) => file.endsWith('.md'))
    .sort()
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const outDir = args.out ? resolve(args.out) : ASSET_DIR
  const jobs = args.version
    ? [{ version: `v${args.version.replace(/^v/, '')}`, file: resolve(args.notes) }]
    : notesFiles().map((file) => ({ version: file.replace(/\.md$/, ''), file: join(NOTES_DIR, file) }))

  mkdirSync(outDir, { recursive: true })
  const releases = []

  for (const job of jobs) {
    const notes = readFileSync(job.file, 'utf8')
    const version = job.version
    const seed = hashString(`retro-blueprint/${version}`)
    const themes = readThemes(notes)
    const plan = planPiece(version, themes, seed)
    const files = {}

    for (const { variant, svg } of variantsFor(plan)) {
      const name = `${version}-${variant}.svg`
      writeFileSync(join(outDir, name), svg)
      files[variant] = name
      console.log(`${version} ${variant}: ${Buffer.byteLength(svg)} bytes`)
    }

    releases.push({
      version,
      seed,
      notes: job.file.startsWith(NOTES_DIR) ? `scripts/release-art/notes/${version}.md` : job.file,
      themes: {
        density: round3(themes.density),
        hands: round3(themes.hands),
        precision: round3(themes.precision),
        wayfinding: round3(themes.wayfinding),
      },
      exposure: {
        summits: plan.summits,
        levels: plan.levels,
        wobble: round3(plan.wobble),
        patches: plan.patches,
        fades: plan.fades,
        bloom: round3(plan.bloom),
        ridge: plan.ridge,
        corridor: plan.corridor,
      },
      bytes: Object.fromEntries(
        Object.entries(files).map(([variant, name]) => [variant, svgBytes(name, outDir)]),
      ),
      files,
    })
  }

  if (args.version) {
    // One release at a time is for trying a piece out: it writes the two variants and leaves the
    // series manifest, which describes every release in the notes directory, untouched.
    console.log(`Wrote ${releases.length * 2} pieces to ${outDir} (manifest.json left as it was)`)
    return
  }

  const manifest = {
    direction: 'retro-blueprint',
    generator: 'scripts/release-art/retro-blueprint.mjs',
    canvas: { width: WIDTH, height: HEIGHT },
    palette: PALETTE,
    weights: WEIGHTS,
    releases,
  }
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Wrote ${releases.length * 2} pieces and manifest.json to ${outDir}`)
}

function svgBytes(name, dir) {
  return readFileSync(join(dir, name)).byteLength
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(`retro-blueprint: ${error.message}`)
    process.exitCode = 1
  }
}
