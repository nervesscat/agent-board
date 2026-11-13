#!/usr/bin/env node
// Release artwork: retro-thermal, a heat-pressed contour field.
//
// The shape is the approved contour register: an implied terrain seen from straight above, seeded
// iso-lines at an interval the release's notes choose, three line weights, one deliberate
// interruption. The treatment is what makes it retro: the lines are raised bone on char, each one
// carried by a blurred emboss pair (a light pass off to the upper left, a dark pass off to the
// lower right), the densest part of the field is stained with rust, the bands between contours are
// dot-matrix, and a soft bloom sits behind the summits as if the plate were still warm.
//
// Usage:
//   node scripts/release-art/retro-thermal.mjs                  # regenerate the committed series
//   node scripts/release-art/retro-thermal.mjs --out /tmp/art   # write somewhere else
//   node scripts/release-art/retro-thermal.mjs --version v0.3.0 \
//     --notes scripts/release-art/notes/v0.3.0.md --out /tmp/art
//
// A release nobody has drawn needs only its notes: drop `gh release view vX.Y.Z --json body --jq
// .body` into scripts/release-art/notes/vX.Y.Z.md and run the first command. `--version` renders
// one release for a look and leaves the series manifest alone.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const NOTES_DIR = join(ROOT, 'scripts/release-art/notes')
const ASSET_DIR = join(ROOT, 'src/assets/release-art/retro-thermal')

const WIDTH = 1600
const HEIGHT = 900
const CELL = 7
const SIMPLIFY = 1.6

// The established palette, and nothing else. Black and white appear only as the emboss pair's
// shadow and highlight: they are light on the printed sheet, not hues of their own.
export const PALETTE = {
  char: '#201A17',
  bone: '#D8C7A6',
  rust: '#A34A2A',
  shadow: '#120E0C',
  highlight: '#FFFFFF',
  black: '#000000',
}

const VARIANTS = {
  dark: {
    ground: PALETTE.char,
    ink: PALETTE.bone,
    stain: PALETTE.rust,
    // The pressed edge: white lifts the upper-left, black sinks the lower-right.
    lift: PALETTE.highlight,
    press: PALETTE.black,
    liftOpacity: 0.2,
    pressOpacity: 0.55,
    lineOpacity: { heavy: 0.92, medium: 0.72, light: 0.48 },
    bloom: PALETTE.bone,
    bloomOpacity: 0.13,
    stainOpacity: 0.2,
    ghostOpacity: 0.1,
    matrix: PALETTE.bone,
    matrixOpacity: 0.42,
    matrixAccent: PALETTE.rust,
    matrixAccentOpacity: 0.72,
    grainBlend: 'screen',
    grainOpacity: 0.13,
    toothBlend: 'multiply',
    toothOpacity: 0.05,
  },
  light: {
    ground: PALETTE.bone,
    ink: PALETTE.char,
    stain: PALETTE.rust,
    lift: PALETTE.highlight,
    press: PALETTE.shadow,
    liftOpacity: 0.56,
    pressOpacity: 0.2,
    lineOpacity: { heavy: 0.9, medium: 0.72, light: 0.5 },
    bloom: PALETTE.shadow,
    bloomOpacity: 0.09,
    stainOpacity: 0.22,
    ghostOpacity: 0.14,
    matrix: PALETTE.char,
    matrixOpacity: 0.42,
    matrixAccent: PALETTE.rust,
    matrixAccentOpacity: 0.66,
    grainBlend: 'multiply',
    grainOpacity: 0.15,
    toothBlend: 'multiply',
    toothOpacity: 0.07,
  },
}

const THEME_WORDS = {
  // Many hands: agents working together, each one a summit of its own.
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
    'mention',
    'pick',
  ],
  // Precision: small things that hold — one steady crest, tight intervals, little drift.
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
  // Wayfinding: things moved, split, renamed, dropped — open ground and a way through it.
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

// Smooth one-dimensional value noise: the slow breathe of a line along its length.
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
    // The length of the release: how many things happened, which is how much ink it earns.
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
    16,
  )
  // The interval: how many iso-lines the notes buy. A release about things holding gets many,
  // packed close; a release about clearing ground gets few, with air between them.
  const levels = clamp(
    Math.round(9 + themes.precision * 9 + themes.density * 8 - themes.wayfinding * 2 + jitter(2)),
    8,
    20,
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
    // One deliberate interruption, always: a cleared way when the release moved things, otherwise
    // a pressed crease — the fold of paper run through the press, where the lines are interrupted
    // and the emboss turns into a hard lit edge.
    interruption: corridor ? 'corridor' : 'crease',
    // Interval in normalised height between neighbouring contours; the notes set it.
    interval: 0.9 / (levels - 1),
    base: clamp(300 - summits * 12, 128, 260),
    wobble: 1.9 - themes.precision * 0.8,
    nickCount: Math.round(8 + themes.density * 16),
    warp: 0.18 + themes.density * 0.12,
    // Heat: a busy release is worked hotter, so its bloom is broader and its stains heavier.
    bloom: 0.55 + themes.density * 0.45,
    stain: 0.5 + themes.density * 0.5,
  }
}

// ---------------------------------------------------------------- terrain

function makeTerrain(plan, seed) {
  const random = mulberry32(seed ^ 0x51ed270b)
  const peaks = []
  const range = (low, high) => low + random() * (high - low)

  // Broad swells under everything, so lines cross the frame instead of closing on one hill.
  for (let i = 0; i < 3; i++) {
    peaks.push({
      cx: range(-0.1, 1.1) * WIDTH,
      cy: range(-0.1, 1.1) * HEIGHT,
      sx: range(0.42, 0.85) * WIDTH,
      sy: range(0.35, 0.8) * HEIGHT,
      rotation: range(-0.2, 0.2),
      amplitude: range(0.16, 0.3),
      swell: true,
    })
  }

  if (plan.ridge) {
    // One long crest through the middle, its ends running off the frame.
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
    // A shoulder, so rings lean into the next summit instead of staying circles.
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
  return { sample, peaks: peaks.filter((peak) => !peak.swell) }
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
  const point = (x, y) => [x, y]

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
      const top = () => point(x0 + (CELL * (level - h00)) / (h10 - h00), y0)
      const right = () => point(x0 + CELL, y0 + (CELL * (level - h10)) / (h11 - h10))
      const bottom = () => point(x0 + (CELL * (level - h01)) / (h11 - h01), y0 + CELL)
      const left = () => point(x0, y0 + (CELL * (level - h00)) / (h01 - h00))

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
          if (centre > level) {
            segments.push([top(), right()], [left(), bottom()])
          } else {
            segments.push([left(), top()], [right(), bottom()])
          }
          break
        }
        case 10: {
          const centre = (h00 + h10 + h01 + h11) / 4
          if (centre > level) {
            segments.push([left(), top()], [right(), bottom()])
          } else {
            segments.push([top(), right()], [left(), bottom()])
          }
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

// A hand, not a plotter: offset each point along its normal by slow noise so neighbouring lines
// drift together and apart instead of holding a constant distance.
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
  let crease = null

  if (plan.interruption === 'corridor') {
    // A wide cleared way through the field: the release moved things and dropped what it did not
    // need, so the ground has somewhere it is silent.
    const angle = range(-0.35, 0.35)
    blanks.push({
      cx: range(0.35, 0.65) * WIDTH,
      cy: range(0.35, 0.65) * HEIGHT,
      hx: WIDTH * 1.1,
      hy: range(0.055, 0.08) * HEIGHT,
      angle,
    })
    if (plan.themes.wayfinding > 0.6) {
      blanks.push({
        cx: range(0.2, 0.8) * WIDTH,
        cy: range(0.2, 0.8) * HEIGHT,
        hx: WIDTH * 0.75,
        hy: range(0.03, 0.05) * HEIGHT,
        angle: angle + range(0.8, 1.3),
      })
    }
  } else {
    // A pressed crease: one straight fold across the sheet. The contours stop at it and start
    // again on the far side, and the emboss turns into a hard edge along it.
    crease = {
      x: range(0.18, 0.82) * WIDTH,
      y: range(0.2, 0.8) * HEIGHT,
      angle: range(-0.55, 0.55),
      half: range(7, 10),
      // How far the sheet has slipped along the fold: the ground on one side of it sits a little
      // further along than the ground on the other.
      slip: range(6, 9),
    }
    blanks.push({
      cx: crease.x,
      cy: crease.y,
      hx: WIDTH * 1.4,
      hy: crease.half,
      angle: crease.angle,
    })
  }

  // Nicks: small bites that eat a line for a few pixels. These are the sheet's grain, not a
  // composition choice, so they stay small and spread.
  for (let i = 0; i < plan.nickCount; i++) {
    blanks.push({
      cx: range(-0.02, 1.02) * WIDTH,
      cy: range(-0.02, 1.02) * HEIGHT,
      hx: range(1.1, 3.2),
      hy: range(4, 16),
      angle: range(-1.4, 1.4),
    })
  }

  for (const blank of blanks) {
    blank.cos = Math.cos(blank.angle)
    blank.sin = Math.sin(blank.angle)
  }
  return { blanks, crease }
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

// Land a cut just outside the blank, so a line reads as lifted rather than cropped.
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

// ---------------------------------------------------------------- SVG helpers

function runLength(points) {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
  }
  return total
}

function pathData(points) {
  const round = (n) => Math.round(n)
  let data = `M${round(points[0][0])} ${round(points[0][1])}`
  if (points.length > 1) data += 'L'
  for (let i = 1; i < points.length; i++) {
    data += `${i > 1 ? ' ' : ''}${round(points[i][0])} ${round(points[i][1])}`
  }
  return data
}

function round(value) {
  return Math.round(value * 1000) / 1000
}

// Three weights, chosen heavier than a drawn field would use: this piece has to hold its edges at
// a third of its size, where a 1 px line would disappear into the grain.
const WEIGHTS = {
  heavy: { width: 3.7, share: 0.12 },
  medium: { width: 2.5, share: 0.3 },
  light: { width: 1.7, share: 0.58 },
}

// ---------------------------------------------------------------- the piece

function piece(version, plan, variant) {
  const label = version.replace(/^v/, '')
  const seed = plan.seed
  const palette = VARIANTS[variant]
  const { sample, peaks } = makeTerrain(plan, seed)
  const grid = fieldGrid(sample)
  const { blanks, crease } = makeBlanks(plan, seed)
  const random = mulberry32(seed ^ 0x7a3c93f1)

  const levelValues = []
  for (let i = 0; i < plan.levels; i++) {
    const base = 0.05 + (i / (plan.levels - 1)) * 0.9
    levelValues.push(base + (random() - 0.5) * 0.008)
  }

  // The fold slips the ground on each side of it along the fold's own direction; the band around
  // the fold is cleared, so the step never shows as a broken line, only as ground that does not
  // line up across the crease.
  const slipLines = (points) => {
    if (!crease) return points
    const nx = -Math.sin(crease.angle)
    const ny = Math.cos(crease.angle)
    const tx = Math.cos(crease.angle) * crease.slip
    const ty = Math.sin(crease.angle) * crease.slip
    return points.map((point) => {
      const side = (point[0] - crease.x) * nx + (point[1] - crease.y) * ny
      return side >= 0 ? [point[0] + tx, point[1] + ty] : [point[0] - tx, point[1] - ty]
    })
  }

  const byLevel = levelValues.map((level, index) => {
    const rings = []
    const opens = []
    for (const line of isoLines(grid, level)
      .map((points) => simplify(points, SIMPLIFY))
      .filter((points) => points.length > 2)
      .map((points) => breathe(points, plan.wobble, seed + index * 131))
      .map(slipLines)) {
      const closed =
        Math.abs(line[0][0] - line[line.length - 1][0]) < 0.5 &&
        Math.abs(line[0][1] - line[line.length - 1][1]) < 0.5
      if (closed) rings.push(line)
      else opens.push(line)
    }
    return { index, level, rings, opens }
  })

  // ---- contours, grouped by weight so each group's path data is written once and printed four
  // times: a shadow pass, a light pass and the crisp line itself.
  const groups = { heavy: [], medium: [], light: [] }
  const heavyShare = WEIGHTS.heavy.share + (1 - plan.themes.density) * 0.08
  let lineCount = 0

  for (const { index, rings, opens } of byLevel) {
    // Every fifth level is pressed deeper: the plate bites harder on the index lines.
    const indexLine = index % 5 === 0
    for (const line of [...opens, ...rings]) {
      const roll = random()
      const name = indexLine || roll < heavyShare ? 'heavy' : roll < heavyShare + 0.3 ? 'medium' : 'light'
      for (const run of cut(line, blanks)) {
        if (runLength(run) < 12) continue
        groups[name].push(pathData(run))
        lineCount++
      }
    }
  }

  // ---- dot-matrix bands: two contour lines carry a stencil of dots instead of ink, one in rust
  // where the field is steepest, one in the sheet's own colour lower down.
  const runsOf = (points) => cut(points, blanks).filter((run) => runLength(run) > 40)

  // The colour band follows the contour nearest the hottest summit; the matrix band follows the
  // longest contours lower down. Both are stencils, so they read as tone from a distance.
  const nearHottest = (lines, reach, window) => {
    const [hottest] = [...peaks].sort((a, b) => b.amplitude - a.amplitude)
    // A stain is a patch, not a ribbon: keep the stretch of contour around the point closest to
    // the summit, and let the rest of that line stay plain.
    const patch = (run) => {
      let nearest = 0
      let best = Infinity
      for (let i = 0; i < run.length; i++) {
        const away = Math.hypot(run[i][0] - hottest.cx, run[i][1] - hottest.cy)
        if (away < best) {
          best = away
          nearest = i
        }
      }
      if (best > reach) return null
      let low = nearest
      let high = nearest
      let travelled = 0
      while (low > 0 && travelled < window / 2) {
        travelled += Math.hypot(run[low][0] - run[low - 1][0], run[low][1] - run[low - 1][1])
        low--
      }
      travelled = 0
      while (high < run.length - 1 && travelled < window / 2) {
        travelled += Math.hypot(run[high + 1][0] - run[high][0], run[high + 1][1] - run[high][1])
        high++
      }
      return { run: run.slice(low, high + 1), away: best }
    }
    const patchOf = (candidate, from, to) =>
      pathData(
        candidate.run.slice(
          Math.floor(from * (candidate.run.length - 1)),
          Math.max(
            Math.floor(from * (candidate.run.length - 1)) + 1,
            Math.floor(to * (candidate.run.length - 1)),
          ),
        ),
      )
    // The stain fades at both ends the way a screen tint runs out, so the band does not stop at a
    // straight edge in the middle of the field.
    return lines
      .flatMap(runsOf)
      .map(patch)
      .filter(Boolean)
      .sort((a, b) => a.away - b.away)
      .slice(0, 2)
      .flatMap((candidate) => [
        { data: patchOf(candidate, 0, 1), fade: 0.42 },
        { data: patchOf(candidate, 0.16, 0.84), fade: 0.62 },
        { data: patchOf(candidate, 0.34, 0.66), fade: 0.8 },
      ])
  }

  const longest = (lines, take) =>
    lines
      .flatMap(runsOf)
      .sort((a, b) => runLength(b) - runLength(a))
      .slice(0, take)
      .map((run) => pathData(run))

  const accentLevel = byLevel[Math.round(plan.levels * 0.62)]
  const inkLevel = byLevel[Math.round(plan.levels * 0.34)]
  const accentBand = accentLevel ? nearHottest([...accentLevel.rings, ...accentLevel.opens], 320, 820) : []
  const inkBand = inkLevel
    ? longest([...inkLevel.rings, ...inkLevel.opens], 2).map((data) => ({ data, fade: 0.9 }))
    : []

  // ---- heat: bloom behind the highest summits, rust stain where the contours are densest.
  const hot = [...peaks].sort((a, b) => b.amplitude - a.amplitude)
  const bloomCount = Math.round(2 + plan.bloom * 3)
  const blooms = hot.slice(0, bloomCount).map((peak, index) => {
    const scale = 0.45 + ((index * 0.37) % 1) * 0.3
    return `<ellipse cx="${Math.round(peak.cx)}" cy="${Math.round(peak.cy)}" rx="${Math.round(
      Math.min(420, peak.sx * scale),
    )}" ry="${Math.round(Math.min(260, peak.sy * scale))}" transform="rotate(${Math.round(
      (peak.rotation * 180) / Math.PI,
    )} ${Math.round(peak.cx)} ${Math.round(peak.cy)})" fill="${palette.bloom}" opacity="${palette.bloomOpacity}"/>`
  })

  const stainCount = Math.round(1 + plan.stain * 3)
  const stains = hot.slice(0, stainCount).map((peak, index) => {
    const stretch = 0.6 + ((index * 0.53) % 1) * 0.35
    return `<ellipse cx="${Math.round(peak.cx + 26)}" cy="${Math.round(peak.cy - 16)}" rx="${Math.round(
      Math.min(360, peak.sx * stretch),
    )}" ry="${Math.round(Math.min(220, peak.sy * stretch))}" transform="rotate(${Math.round(
      (peak.rotation * 180) / Math.PI,
    )} ${Math.round(peak.cx)} ${Math.round(peak.cy)})" fill="${palette.stain}" opacity="${palette.stainOpacity}"/>`
  })

  // ---- the crease: one straight fold across the sheet. Its shadow is laid under the contours so
  // it shades the paper rather than the ink; its lit edge is a thin line over them, the way a fold
  // catches the light. Both fade out towards the edges, so it reads as a fold and not as a strip of
  // tape laid across the piece, and the contours are interrupted along it.
  const creaseLines = crease
    ? (() => {
        const half = Math.hypot(WIDTH, HEIGHT)
        const dx = Math.cos(crease.angle) * half
        const dy = Math.sin(crease.angle) * half
        const nx = -Math.sin(crease.angle)
        const ny = Math.cos(crease.angle)
        const at = (along) => [crease.x + dx * along, crease.y + dy * along]
        const segment = (from, to, distance, width, blur, opacity, color) => {
          const a = at(from)
          const b = at(to)
          return `<path d="M${Math.round(a[0])} ${Math.round(a[1])}L${Math.round(b[0])} ${Math.round(
            b[1],
          )}" fill="none" stroke="${color}" stroke-opacity="${round(opacity)}" stroke-width="${width}" filter="url(#${blur})" stroke-linecap="round" transform="translate(${Math.round(
            nx * distance,
          )} ${Math.round(ny * distance)})"/>`
        }
        const shadow = segment(0, 1, 0, 3.2, 'fold', variant === 'dark' ? 0.42 : 0.2, palette.press)
        const light = segment(0, 1, -2.6, 1.6, 'lift', variant === 'dark' ? 0.1 : 0.28, palette.lift)
        return {
          under: `<g fill="none" stroke-linecap="round">${shadow}</g>`,
          over: `<g fill="none" stroke-linecap="round">${light}</g>`,
        }
      })()
    : null

  const groupDefs = ['heavy', 'medium', 'light']
    .filter((name) => groups[name].length)
    .map((name) => `<g id="${name}">${groups[name].map((data) => `<path d="${data}"/>`).join('')}</g>`)
    .join('')

  // Each group printed three times: shadow (down-right, blurred), light (up-left, blurred), then
  // the line itself. The blurred pair is the emboss — the ink sits in a pressed groove.
  const printed = ['heavy', 'medium', 'light']
    .filter((name) => groups[name].length)
    .flatMap((name) => {
      const width = WEIGHTS[name].width
      const passes = [
        `<use href="#${name}" stroke="${palette.press}" stroke-opacity="${palette.pressOpacity}" stroke-width="${width}" filter="url(#press)" transform="translate(2 2.4)"/>`,
        `<use href="#${name}" stroke="${palette.lift}" stroke-opacity="${palette.liftOpacity}" stroke-width="${width}" filter="url(#lift)" transform="translate(-2 -2.4)"/>`,
      ]
      // The heaviest lines are struck twice, the rust plate a hair off its bed: misregistration
      // rather than a second colour, and only on the lines that carry the field.
      if (name === 'heavy') {
        passes.push(
          `<use href="#${name}" stroke="${palette.stain}" stroke-opacity="${palette.ghostOpacity}" stroke-width="${width}" transform="translate(1.8 -1.4)"/>`,
        )
      }
      passes.push(
        `<use href="#${name}" stroke="${palette.ink}" stroke-opacity="${palette.lineOpacity[name]}" stroke-width="${width}"/>`,
      )
      return passes
    })
    .join('')

  const dotMask = (id, parts, width) => {
    const paths = parts.filter((part) => part.data)
    if (!paths.length) return ''
    const mouth = paths
      .map(
        (part) =>
          `<path d="${part.data}" fill="none" stroke="#ffffff" stroke-opacity="${part.fade ?? 1}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`,
      )
      .join('')
    return `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${WIDTH}" height="${HEIGHT}">${mouth}</mask>`
  }
  const rest = (id, paint) =>
    paint ? `<rect width="${WIDTH}" height="${HEIGHT}" mask="url(#${id})" fill="${paint}"/>` : ''

  const grainSeed = plan.seed % 1000
  const dotPitch = 5.5
  const finePitch = 6

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" data-release="${version}" data-variant="${variant}" aria-labelledby="title describe">
<title id="title">Thermal contour, CrossBoard ${label}</title>
<desc id="describe">An abstract contour field printed warm: raised lines with an embossed shadow, rust staining where the field is dense, dot-matrix bands and a heat bloom behind the summits.</desc>
<defs>
<filter id="bloom" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${Math.round(26 + plan.bloom * 12)}"/></filter>
<filter id="stain" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="30"/></filter>
<filter id="lift" x="-6%" y="-6%" width="112%" height="112%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="1.3"/></filter>
<filter id="press" x="-6%" y="-6%" width="112%" height="112%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="2.4"/></filter>
<filter id="fold" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="9"/></filter>
<filter id="grain" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="3" seed="${grainSeed}" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter>
<filter id="tooth" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.055" numOctaves="2" seed="${
    grainSeed + 7
  }" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter>
<pattern id="matrix" width="${dotPitch}" height="${dotPitch}" patternUnits="userSpaceOnUse"><circle cx="${
    dotPitch / 2
  }" cy="${dotPitch / 2}" r="1.55" fill="${palette.matrix}" fill-opacity="${palette.matrixOpacity}"/></pattern>
<pattern id="matrix-fine" width="${finePitch}" height="${finePitch}" patternUnits="userSpaceOnUse"><circle cx="${
    finePitch / 2
  }" cy="${finePitch / 2}" r="1.85" fill="${
    palette.matrixAccent
  }" fill-opacity="${palette.matrixAccentOpacity}"/></pattern>
${dotMask('band-accent', accentBand, 20)}${dotMask('band-ink', inkBand, 30)}
${groupDefs}
</defs>
<rect width="${WIDTH}" height="${HEIGHT}" fill="${palette.ground}"/>
<g filter="url(#bloom)">${blooms.join('')}</g>
<g filter="url(#stain)">${stains.join('')}</g>
${rest('band-ink', 'url(#matrix)')}${rest('band-accent', 'url(#matrix-fine)')}
${creaseLines ? creaseLines.under : ''}
<g fill="none" stroke-linejoin="round" stroke-linecap="round">${printed}</g>
${creaseLines ? creaseLines.over : ''}
<rect width="${WIDTH}" height="${HEIGHT}" filter="url(#grain)" style="mix-blend-mode:${palette.grainBlend}" opacity="${palette.grainOpacity}"/>
<rect width="${WIDTH}" height="${HEIGHT}" filter="url(#tooth)" style="mix-blend-mode:${palette.toothBlend}" opacity="${palette.toothOpacity}"/>
</svg>
`

  return { svg, stats: { lines: lineCount, blooms: blooms.length, stains: stains.length } }
}

// ---------------------------------------------------------------- plan to files

function variantsFor(plan) {
  return ['light', 'dark'].map((variant) => {
    const { svg, stats } = piece(plan.version, plan, variant)
    return { variant, svg, stats }
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
        'Usage: node scripts/release-art/retro-thermal.mjs [--version vX.Y.Z --notes FILE] [--out DIR]',
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
    const seed = hashString(`retro-thermal/${version}`)
    const themes = readThemes(notes)
    const plan = planPiece(version, themes, seed)
    const files = {}

    for (const { variant, svg, stats } of variantsFor(plan)) {
      const name = `${version}-${variant}.svg`
      writeFileSync(join(outDir, name), svg)
      files[variant] = name
      console.log(
        `${version} ${variant}: ${Buffer.byteLength(svg)} bytes, ${stats.lines} lines, ${stats.blooms} blooms, ${stats.stains} stains`,
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
        interval: round(plan.interval),
        wobble: round(plan.wobble),
        ridge: plan.ridge,
        interruption: plan.interruption,
      },
      treatment: {
        weight: round(plan.themes.density),
        bloom: round(plan.bloom),
        stain: round(plan.stain),
      },
      files,
    })
  }

  if (args.version) {
    console.log(`Wrote ${releases.length * 2} pieces to ${outDir} (manifest.json left as it was)`)
    return
  }

  const manifest = {
    direction: 'retro-thermal',
    generator: 'scripts/release-art/retro-thermal.mjs',
    canvas: { width: WIDTH, height: HEIGHT },
    palette: PALETTE,
    releases,
  }
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Wrote ${releases.length * 2} pieces and manifest.json to ${outDir}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(`retro-thermal: ${error.message}`)
    process.exitCode = 1
  }
}
