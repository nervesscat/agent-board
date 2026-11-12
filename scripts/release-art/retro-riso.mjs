#!/usr/bin/env node
// Release artwork: retro riso.
//
// The approved register is a contour field: an implied terrain seen from above, seeded iso-lines,
// three line weights, and one deliberate interruption. This direction prints it: two ink drums on
// one sheet, a 2-6 px misregistration between them, halftone dots in the wide bands, a drum whose
// density is uneven, paper fibre, and a second pass of the ink plate that landed off its bed and
// went soft. Nothing here is a filter over the finished image: the soft plate, the density and the
// grain each act on their own layer, the way a press would.
//
// The release's notes are read for three themes — many hands, precision, wayfinding — and the
// version seeds every remaining choice, so the same version and notes write the same bytes every
// run. A release nobody has seen needs only its notes file.
//
// Usage:
//   node scripts/release-art/retro-riso.mjs                      # regenerate the committed series
//   node scripts/release-art/retro-riso.mjs --out /tmp/art       # write somewhere else
//   node scripts/release-art/retro-riso.mjs --version v0.3.0 \
//     --notes scripts/release-art/notes/v0.3.0.md --out /tmp/art
//
// To draw the next release:
//   gh release view vX.Y.Z --json body --jq .body > scripts/release-art/notes/vX.Y.Z.md
//   node scripts/release-art/retro-riso.mjs

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const NOTES_DIR = join(ROOT, 'scripts/release-art/notes')
const ASSET_DIR = join(ROOT, 'src/assets/release-art/retro-riso')

const WIDTH = 1600
const HEIGHT = 900
const CELL = 7
const SIMPLIFY = 1.7
const HALFTONE_PITCH = 9
const HALFTONE_RADIUS = 2.4
const SPOT_SCREEN_ANGLE = 15
const INK_WEIGHTS = { heavy: 3, medium: 2.1, light: 1.4 }
const SPOT_WEIGHT = 2.8

// The palette is fixed by the direction: paper, ink, one spot, one shadow. Nothing else is
// allowed on the sheet. The dark piece swaps the roles of paper and ink; the spot and the shadow
// stay themselves, so the series still reads as one press.
export const PALETTE = {
  paper: '#F4EFE6',
  ink: '#1F2A44',
  spot: '#FF5A3C',
  shadow: '#DCD3C4',
}
export const PALETTE_HEXES = Object.values(PALETTE)

const VARIANTS = {
  light: {
    ground: PALETTE.paper,
    line: PALETTE.ink,
    accent: PALETTE.spot,
    haze: PALETTE.shadow,
    grain: 'multiply',
    grainOpacity: 0.13,
    lineOpacity: { heavy: 0.95, medium: 0.78, light: 0.6 },
    spotOpacity: 0.82,
    bandOpacity: { ink: 0.34, spot: 0.68 },
    hazeOpacity: 0.22,
    softOpacity: 0.22,
    fibreOpacity: 0.05,
    drumSeed: 17,
  },
  dark: {
    ground: PALETTE.ink,
    line: PALETTE.paper,
    accent: PALETTE.spot,
    haze: PALETTE.shadow,
    grain: 'screen',
    grainOpacity: 0.1,
    lineOpacity: { heavy: 0.95, medium: 0.76, light: 0.56 },
    spotOpacity: 0.86,
    bandOpacity: { ink: 0.24, spot: 0.66 },
    hazeOpacity: 0.1,
    softOpacity: 0.15,
    fibreOpacity: 0.05,
    drumSeed: 41,
  },
}

const THEME_WORDS = {
  hands: [
    'agent',
    'shared',
    'sharing',
    'tool',
    'lane',
    'delegat',
    'collaborat',
    'ticket',
    'post',
    'repl',
    'review',
    'forum',
    'mention',
    'pick',
  ],
  precision: [
    'focus',
    'ring',
    'cache',
    'safe',
    'sticky',
    'proxy',
    'clock',
    'retry',
    'retries',
    'cap',
    'keep',
    'exact',
    'warm',
    'count',
    'hold',
    'fallback',
    'fix',
    'fit',
    'quiet',
    'guard',
  ],
  wayfinding: [
    'move',
    'split',
    'remove',
    'menu',
    'palette',
    'rename',
    'fold',
    'clean',
    'clutter',
    'reorganiz',
    'resume',
    'settings',
    'find',
    'search',
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

function relief(seed, x, y) {
  let total = 0
  let amplitude = 1
  let frequency = 1
  let normal = 0
  for (let octave = 0; octave < 3; octave++) {
    total += amplitude * valueNoise(seed + octave * 1013, (x * frequency) / 380, (y * frequency) / 380)
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
      4 + themes.hands * 11 + themes.density * 7 - themes.precision * 5 - themes.wayfinding * 3 + jitter(2),
    ),
    4,
    15,
  )
  const levels = clamp(
    Math.round(9 + themes.precision * 8 + themes.density * 6 - themes.wayfinding * 2 + jitter(2)),
    8,
    18,
  )
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
    base: clamp(300 - summits * 12, 128, 260),
    wobble: 1.9 - themes.precision * 0.8,
    nickCount: Math.round(18 + themes.density * 34),
    warp: 0.18 + themes.density * 0.12,
    // The spot drum takes every third contour; the drum's registration drifts 2-6 px, the kind of
    // error a hand-fed sheet gets, large enough to still read at a third of the size.
    spotStride: 3,
    spotPhase: Math.floor(random() * 3),
    registration: {
      // The sheet's two drums are a hair out of register: 1.2-2 px, the direction's whole
      // mistake. At a third of the size it falls below a device pixel, which is deliberate: the
      // print feel then has to come from the screen, the drum density and the tear.
      x: 1.2 + random() * 0.8,
      y: -(0.8 + random() * 0.8),
    },
    halftone: {
      pitch: HALFTONE_PITCH,
      radius: HALFTONE_RADIUS,
      screenAngle: SPOT_SCREEN_ANGLE,
    },
    drum: {
      frequency: [0.0028 + random() * 0.0012, 0.009 + random() * 0.003],
      strength: 0.2 + themes.density * 0.14,
    },
  }
}

// ---------------------------------------------------------------- terrain

function makeTerrain(plan, seed) {
  const random = mulberry32(seed ^ 0x51ed270b)
  const peaks = []
  const range = (low, high) => low + random() * (high - low)

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
    peaks.push({
      cx: range(0.38, 0.62) * WIDTH,
      cy: range(0.4, 0.58) * HEIGHT,
      sx: range(0.42, 0.5) * WIDTH,
      sy: range(0.09, 0.125) * HEIGHT,
      rotation: range(-0.42, -0.18),
      amplitude: range(0.72, 0.88),
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

  for (let i = 0; i < plan.summits; i++) {
    const cx = range(-0.08, 1.08) * WIDTH
    const cy = range(-0.05, 1.05) * HEIGHT
    const aspect = range(0.65, 2.1)
    peaks.push({
      cx,
      cy,
      sx: plan.base * range(0.6, 1.2) * aspect,
      sy: (plan.base * range(0.55, 1.1)) / aspect,
      rotation: range(-1.1, 1.1),
      amplitude: range(0.3, 0.8),
    })
    if (random() < 0.55) {
      peaks.push({
        cx: cx + range(-0.14, 0.14) * WIDTH,
        cy: cy + range(-0.1, 0.1) * HEIGHT,
        sx: plan.base * range(0.3, 0.7),
        sy: plan.base * range(0.25, 0.6),
        rotation: range(-1.2, 1.2),
        amplitude: range(0.15, 0.4),
      })
    }
  }

  const warp = plan.warp
  const phases = [random(), random(), random(), random()].map((n) => n * Math.PI * 2)
  const reliefSeed = seed ^ 0x1b873593
  const reliefStrength = 0.3 + (1 - plan.themes.precision) * 0.18
  return (x, y) => {
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

// A hand, not a plotter: offset every point along its normal by slow noise, so parallel lines
// drift near and apart. The press keeps this; the plate is drawn by a person before it is burned.
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

// ---------------------------------------------------------------- interruptions

function makeBlanks(plan, seed) {
  const random = mulberry32(seed ^ 0x2f6b1d3d)
  const range = (low, high) => low + random() * (high - low)
  const blanks = []

  // The drum miss is not cut out of the geometry: it is a hole in the plate's mask (missShape),
  // so the ink simply stops there instead of the lines politely ending.

  if (plan.corridor) {
    // Wayfinding: a cleared way through the field, wider than the miss, with a companion tear.
    const angle = range(-0.35, 0.35)
    blanks.push({
      cx: range(0.35, 0.65) * WIDTH,
      cy: range(0.35, 0.65) * HEIGHT,
      hx: WIDTH * 1.1,
      hy: range(0.055, 0.085) * HEIGHT,
      angle,
    })
    if (plan.themes.wayfinding > 0.6) {
      blanks.push({
        cx: range(0.2, 0.8) * WIDTH,
        cy: range(0.2, 0.8) * HEIGHT,
        hx: WIDTH * 0.75,
        hy: range(0.028, 0.05) * HEIGHT,
        angle: angle + range(0.8, 1.3),
      })
    }
  }

  // Nicks: small bites where the paper did not take ink. Spread evenly, kept small.
  for (let i = 0; i < plan.nickCount; i++) {
    blanks.push({
      cx: range(-0.02, 1.02) * WIDTH,
      cy: range(-0.02, 1.02) * HEIGHT,
      hx: range(1.1, 3.6),
      hy: range(4, 18),
      angle: range(-1.4, 1.4),
    })
  }

  for (const blank of blanks) {
    blank.cos = Math.cos(blank.angle)
    blank.sin = Math.sin(blank.angle)
  }
  return blanks
}

function inside(blank, p) {
  const dx = p[0] - blank.cx
  const dy = p[1] - blank.cy
  const u = (dx * blank.cos + dy * blank.sin) / blank.hx
  const v = (-dx * blank.sin + dy * blank.cos) / blank.hy
  return u * u + v * v < 1
}

function erase(p, blanks) {
  if (p[0] < 0 || p[0] > WIDTH || p[1] < 0 || p[1] > HEIGHT) return true
  for (const blank of blanks) if (inside(blank, p)) return true
  return false
}

function boundary(a, b, blanks) {
  let outsidePoint = a
  let insidePoint = b
  for (let step = 0; step < 9; step++) {
    const middle = [(outsidePoint[0] + insidePoint[0]) / 2, (outsidePoint[1] + insidePoint[1]) / 2]
    if (erase(middle, blanks)) insidePoint = middle
    else outsidePoint = middle
  }
  return outsidePoint
}

function cut(points, blanks) {
  const runs = []
  let run = []
  let previous = points[0]
  if (!erase(previous, blanks)) run.push(previous)

  for (let i = 1; i < points.length; i++) {
    const current = points[i]
    const previousInside = erase(previous, blanks)
    const currentInside = erase(current, blanks)
    if (!previousInside && !currentInside) {
      run.push(current)
    } else if (!previousInside && currentInside) {
      run.push(boundary(previous, current, blanks))
      if (run.length > 1) runs.push(run)
      run = []
    } else if (previousInside && !currentInside) {
      run = [boundary(previous, current, blanks), current]
    }
    previous = current
  }
  if (run.length > 1) runs.push(run)
  return runs
}

// ---------------------------------------------------------------- printing

function runLength(points) {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
  }
  return total
}

function pathData(points) {
  const round = (n) => Math.round(n * 10) / 10
  let data = `M${round(points[0][0])} ${round(points[0][1])}`
  for (let i = 1; i < points.length; i++) {
    data += `${i === 1 ? 'L' : ' '}${round(points[i][0])} ${round(points[i][1])}`
  }
  return data
}

function pathGroup(paths, attributes) {
  if (!paths.length) return ''
  return `<g ${attributes}>${paths.map((data) => `<path d="${data}"/>`).join('')}</g>`
}

// A torn edge for the drum miss: black, because the mask reads luminance. The ellipse's own
// outline would be too clean for a miss, so small bites are knocked out of its ends.
function missShape(plan, seed) {
  const random = mulberry32(seed ^ 0x6d2b79f5)
  const angle = random() * 0.9 - 0.45
  const cx = (0.3 + random() * 0.4) * WIDTH
  const cy = (0.26 + random() * 0.48) * HEIGHT
  const hx = WIDTH * (0.12 + random() * 0.07)
  const hy = HEIGHT * (0.018 + random() * 0.016)
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const steps = 30
  const points = []
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2
    const rag = 0.72 + random() * 0.5
    points.push([
      cx + cos * Math.cos(t) * hx * rag - sin * Math.sin(t) * hy * rag,
      cy + sin * Math.cos(t) * hx * rag + cos * Math.sin(t) * hy * rag,
    ])
  }
  // A companion tear a little above: a second pull on the same sheet, shorter and thinner.
  const companionAngle = angle + (random() - 0.5) * 0.9
  const companionCx = cx + (random() - 0.5) * hx * 0.9
  const companionCy = cy - hy * (2.2 + random() * 1.6)
  const companionHx = hx * (0.32 + random() * 0.28)
  const companionHy = hy * (0.28 + random() * 0.24)
  const companionCos = Math.cos(companionAngle)
  const companionSin = Math.sin(companionAngle)
  const companion = []
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2
    const rag = 0.7 + random() * 0.55
    companion.push([
      companionCx +
        companionCos * Math.cos(t) * companionHx * rag -
        companionSin * Math.sin(t) * companionHy * rag,
      companionCy +
        companionSin * Math.cos(t) * companionHx * rag +
        companionCos * Math.sin(t) * companionHy * rag,
    ])
  }
  const data = `${pathData([...points, points[0]])}${pathData([...companion, companion[0]])}`
  return { data, cx, cy, hx, hy, cos, sin, angle }
}

function defs(plan, variant, miss) {
  const drum = plan.drum
  return `<defs>
<filter id="soft" filterUnits="userSpaceOnUse" x="-64" y="-64" width="${WIDTH + 128}" height="${HEIGHT + 128}" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="2.8"/></filter>
<filter id="haze" filterUnits="userSpaceOnUse" x="-64" y="-64" width="${WIDTH + 128}" height="${HEIGHT + 128}" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="11"/></filter>
<filter id="density-ink" filterUnits="userSpaceOnUse" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="${drum.frequency[0].toFixed(4)} ${drum.frequency[1].toFixed(4)}" numOctaves="3" seed="${variant.drumSeed}" stitchTiles="stitch"/>
<feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  ${(drum.strength * 0.55).toFixed(3)} ${(drum.strength * 0.55).toFixed(3)} ${(drum.strength * 0.55).toFixed(3)} 0 ${(1 - drum.strength * 0.95).toFixed(3)}"/>
</filter>
<filter id="density-spot" filterUnits="userSpaceOnUse" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="${(drum.frequency[0] * 1.4).toFixed(4)} ${(drum.frequency[1] * 0.8).toFixed(4)}" numOctaves="2" seed="${variant.drumSeed + 7}" stitchTiles="stitch"/>
<feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  ${(drum.strength * 0.4).toFixed(3)} ${(drum.strength * 0.4).toFixed(3)} ${(drum.strength * 0.4).toFixed(3)} 0 ${(1 - drum.strength * 0.7).toFixed(3)}"/>
</filter>
<filter id="grain" filterUnits="userSpaceOnUse" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.82" numOctaves="3" seed="${plan.seed % 997}" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter>
<pattern id="dots-ink" patternUnits="userSpaceOnUse" width="${HALFTONE_PITCH}" height="${HALFTONE_PITCH}" patternTransform="rotate(-12)"><circle cx="2.3" cy="2.3" r="${HALFTONE_RADIUS}" fill="${variant.line}"/><circle cx="6.8" cy="6.8" r="${(HALFTONE_RADIUS * 0.72).toFixed(2)}" fill="${variant.line}"/></pattern>
<pattern id="dots-spot" patternUnits="userSpaceOnUse" width="${HALFTONE_PITCH}" height="${HALFTONE_PITCH}" patternTransform="rotate(${SPOT_SCREEN_ANGLE})"><circle cx="2.3" cy="2.3" r="${HALFTONE_RADIUS}" fill="${variant.accent}"/><circle cx="6.8" cy="6.8" r="${(HALFTONE_RADIUS * 0.66).toFixed(2)}" fill="${variant.accent}"/></pattern>
<mask id="drum-ink" maskUnits="userSpaceOnUse" x="0" y="0" width="${WIDTH}" height="${HEIGHT}"><rect width="${WIDTH}" height="${HEIGHT}" fill="#FFFFFF" filter="url(#density-ink)"/><path d="${miss.data}" fill="#000000" opacity="0.92"/></mask>
<mask id="drum-spot" maskUnits="userSpaceOnUse" x="0" y="0" width="${WIDTH}" height="${HEIGHT}"><rect width="${WIDTH}" height="${HEIGHT}" fill="#FFFFFF" filter="url(#density-spot)"/><path d="${miss.data}" fill="#000000" opacity="0.8"/></mask>
</defs>`
}

function piece(version, plan) {
  const label = version.replace(/^v/, '')
  const seed = plan.seed
  const terrain = makeTerrain(plan, seed)
  const grid = fieldGrid(terrain)
  const blanks = makeBlanks(plan, seed)
  const random = mulberry32(seed ^ 0x7a3c93f1)
  const registration = plan.registration
  const miss = missShape(plan, seed)

  const levelValues = []
  for (let i = 0; i < plan.levels; i++) {
    // Contour intervals, not quite even: a drawn field, with the cartographer's hand in it.
    const base = 0.05 + (i / (plan.levels - 1)) * 0.9
    levelValues.push(base + (random() - 0.5) * 0.008)
  }

  const byLevel = levelValues.map((level, index) => {
    const rings = []
    const opens = []
    for (const line of isoLines(grid, level)
      .map((points) => simplify(points, SIMPLIFY))
      .filter((points) => points.length > 2)
      .map((points) => breathe(points, plan.wobble, seed + index * 131))) {
      const closed =
        Math.abs(line[0][0] - line[line.length - 1][0]) < 0.5 &&
        Math.abs(line[0][1] - line[line.length - 1][1]) < 0.5
      if (closed) rings.push(line)
      else opens.push(line)
    }
    return { index, level, rings, opens }
  })

  // Bands are printed as wide strokes along measured contours and filled with the drum's dot
  // screen: a halftone band that follows the ground instead of pouring a disk over a summit.
  const bandAt = (index, width, paint, opacity) => {
    const level = byLevel[index]
    if (!level) return null
    const lines = [...level.rings, ...level.opens]
      .sort((a, b) => b.length - a.length)
      .slice(0, plan.themes.density > 0.82 ? 2 : 1)
    const data = lines
      .flatMap((line) => cut(line, blanks))
      .filter((run) => runLength(run) > 40)
      .map((run) => pathData(run))
      .join('')
    return data ? { index, width, paint, opacity, data } : null
  }

  const bands = [
    bandAt(Math.round(plan.levels * 0.36), 48, 'url(#dots-ink)', plan.variantBandOpacity.ink),
    bandAt(Math.round(plan.levels * 0.64), 34, 'url(#dots-spot)', plan.variantBandOpacity.spot),
  ].filter(Boolean)

  const classes = {
    heavy: { weight: INK_WEIGHTS.heavy, opacity: plan.variantLineOpacity.heavy, paths: [] },
    medium: { weight: INK_WEIGHTS.medium, opacity: plan.variantLineOpacity.medium, paths: [] },
    light: { weight: INK_WEIGHTS.light, opacity: plan.variantLineOpacity.light, paths: [] },
  }
  const spotPaths = []
  const heavyShare = 0.12 + (1 - plan.themes.density) * 0.12
  let lineCount = 0
  let spotCount = 0

  for (const { index, rings, opens } of byLevel) {
    const indexLine = index % 5 === 0
    // The contour is split between the two drums: every nth level is printed only in spot, and
    // some ink lines also take a spot pass a hair off their bed. Both survive a downscale because
    // the spot-only levels are drawn as heavy lines, not as a 1 px fringe.
    const spotOnly = index % plan.spotStride === plan.spotPhase
    const spotEdge = !spotOnly && index % 4 === (plan.spotPhase + 1) % 4
    for (const line of [...opens, ...rings]) {
      const roll = random()
      const name = indexLine || roll < heavyShare ? 'heavy' : roll < heavyShare + 0.3 ? 'medium' : 'light'
      for (const run of cut(line, blanks)) {
        if (runLength(run) < 12) continue
        const data = pathData(run)
        if (spotOnly) {
          spotPaths.push(data)
          spotCount++
        } else {
          classes[name].paths.push(data)
          if (spotEdge) spotPaths.push(data)
        }
        lineCount++
      }
    }
  }

  const inkPaths = ['light', 'medium', 'heavy'].flatMap((name) => classes[name].paths)
  const inkGroups = ['light', 'medium', 'heavy']
    .map((name) =>
      pathGroup(
        classes[name].paths,
        `stroke="${plan.variant.line}" stroke-opacity="${classes[name].opacity}" stroke-width="${classes[name].weight}"`,
      ),
    )
    .join('')

  // The second pass of the ink plate: the same drawing, a little off its bed, gone soft. This is
  // the only blur in the piece, and it acts on the plate, never on the finished sheet.
  const softPass = pathGroup(
    inkPaths,
    `filter="url(#soft)" transform="translate(2.2 -1.4)" stroke="${plan.variant.line}" stroke-opacity="${plan.variant.softOpacity}" stroke-width="2.6"`,
  )
  const spotPass = pathGroup(
    spotPaths,
    `stroke="${plan.variant.accent}" stroke-opacity="${plan.variant.spotOpacity}" stroke-width="${SPOT_WEIGHT}"`,
  )

  // Paper fibre: short, seeded hairs that only show when looked for. They are what makes the
  // ground paper rather than a fill.
  const fibreRandom = mulberry32(seed ^ 0x1f83d9ab)
  const fibres = []
  for (let i = 0; i < 150; i++) {
    const x = fibreRandom() * WIDTH
    const y = fibreRandom() * HEIGHT
    const angle = fibreRandom() * Math.PI
    const length = 2 + fibreRandom() * 9
    fibres.push(
      `<path d="M${Math.round(x * 10) / 10} ${Math.round(y * 10) / 10}l${Math.round(Math.cos(angle) * length * 10) / 10} ${Math.round(Math.sin(angle) * length * 10) / 10}"/>`,
    )
  }

  // One wide, very soft shadow band under the field: the sheet's tooth catching the drum edge.
  const haze = bands.length
    ? `<path filter="url(#haze)" stroke="${plan.variant.haze}" stroke-opacity="${plan.variant.hazeOpacity}" stroke-width="76" d="${bands[0].data}"/>`
    : ''

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="title describe">
<title id="title">Risograph contour field, CrossBoard ${label}</title>
<desc id="describe">Abstract contour lines of an implied terrain, printed in two misregistered riso inks with halftone bands, drum density and paper grain.</desc>
${defs(plan, plan.variant, plan, miss)}
<rect width="${WIDTH}" height="${HEIGHT}" fill="${plan.variant.ground}"/>
<g fill="none" stroke-linecap="round" stroke-linejoin="round">${haze}
<g mask="url(#drum-ink)">${bands
    .filter((band) => band.paint === 'url(#dots-ink)')
    .map(
      (band) =>
        `<path stroke="${band.paint}" stroke-opacity="${band.opacity}" stroke-width="${band.width}" d="${band.data}"/>`,
    )
    .join('')}${softPass}${inkGroups}</g>
<g mask="url(#drum-spot)" transform="translate(${registration.x.toFixed(2)} ${registration.y.toFixed(2)})">${bands
    .filter((band) => band.paint === 'url(#dots-spot)')
    .map(
      (band) =>
        `<path stroke="${band.paint}" stroke-opacity="${band.opacity}" stroke-width="${band.width}" d="${band.data}"/>`,
    )
    .join('')}${spotPass}</g>
</g>
<g fill="none" stroke="${plan.variant.line}" stroke-opacity="${plan.variant.fibreOpacity}" stroke-width="0.7">${fibres.join('')}</g>
<rect width="${WIDTH}" height="${HEIGHT}" filter="url(#grain)" style="mix-blend-mode:${plan.variant.grain}" opacity="${plan.variant.grainOpacity}"/>
</svg>
`

  return {
    svg,
    stats: { lines: lineCount, spot: spotCount, bands: bands.length },
  }
}

// ---------------------------------------------------------------- plan to files

function variantsFor(plan) {
  return ['light', 'dark'].map((name) => {
    const variant = VARIANTS[name]
    const withVariant = {
      ...plan,
      variant,
      variantLineOpacity: variant.lineOpacity,
      variantBandOpacity: variant.bandOpacity,
    }
    const { svg, stats } = piece(plan.version, withVariant)
    return { variant: name, svg, stats }
  })
}

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
        'Usage: node scripts/release-art/retro-riso.mjs [--version vX.Y.Z --notes FILE] [--out DIR]',
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

function round(value) {
  return Math.round(value * 1000) / 1000
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
    const seed = hashString(`retro-riso/${version}`)
    const themes = readThemes(notes)
    const plan = planPiece(version, themes, seed)
    const files = {}

    for (const { variant, svg, stats } of variantsFor(plan)) {
      const name = `${version}-${variant}.svg`
      writeFileSync(join(outDir, name), svg)
      files[variant] = name
      console.log(
        `${version} ${variant}: ${Buffer.byteLength(svg)} bytes, ${stats.lines} lines, ${stats.spot} spot`,
      )
    }

    releases.push({
      version,
      seed,
      notes: job.file.startsWith(NOTES_DIR) ? `scripts/release-art/notes/${version}.md` : job.file,
      themes: {
        density: round(themes.density),
        hands: round(themes.hands),
        precision: round(themes.precision),
        wayfinding: round(themes.wayfinding),
      },
      field: {
        summits: plan.summits,
        levels: plan.levels,
        wobble: round(plan.wobble),
        ridge: plan.ridge,
        corridor: plan.corridor,
      },
      print: {
        registration: { x: round(plan.registration.x), y: round(plan.registration.y) },
        spotStride: plan.spotStride,
        spotPhase: plan.spotPhase,
        halftone: plan.halftone,
        drumMottle: { frequency: plan.drum.frequency.map(round), strength: round(plan.drum.strength) },
      },
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
    direction: 'retro-riso',
    generator: 'scripts/release-art/retro-riso.mjs',
    canvas: { width: WIDTH, height: HEIGHT },
    palette: {
      hexes: PALETTE_HEXES,
      light: { ground: PALETTE.paper, line: PALETTE.ink, spot: PALETTE.spot, shadow: PALETTE.shadow },
      dark: { ground: PALETTE.ink, line: PALETTE.paper, spot: PALETTE.spot, shadow: PALETTE.shadow },
    },
    print: {
      halftone: { pitch: HALFTONE_PITCH, radius: HALFTONE_RADIUS, screenAngle: SPOT_SCREEN_ANGLE },
      inkWeights: INK_WEIGHTS,
      spotWeight: SPOT_WEIGHT,
      sheet: { width: WIDTH, height: HEIGHT, thirdScale: { width: WIDTH / 3, height: HEIGHT / 3 } },
    },
    releases,
  }
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Wrote ${releases.length * 2} pieces and manifest.json to ${outDir}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(`retro-riso: ${error.message}`)
    process.exitCode = 1
  }
}
