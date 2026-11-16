#!/usr/bin/env node
// Release artwork: green-phosphor CRT.
//
// A piece is a contour field on a vector display, seen through a monitor: seeded summits, iso-lines
// at an interval the release's notes choose, three trace weights, one blanked interval. The notes
// are read for four signals — many hands, precision, wayfinding, density — and those set the
// terrain and the monitor's condition: how many summits, how tight the interval, whether the beam
// holds a ridge or clears a way, how far it wanders, how wide the blanking is and how much of the
// trace it drops. The version seeds everything else, so the same version and notes write the same
// bytes on every run.
//
// Usage:
//   node scripts/release-art/retro-crt.mjs                  # regenerate the committed series
//   node scripts/release-art/retro-crt.mjs --out /tmp/art   # write somewhere else
//   node scripts/release-art/retro-crt.mjs --version v0.3.0 \
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
const ASSET_DIR = join(ROOT, 'src/assets/release-art/retro-crt')

const WIDTH = 1600
const HEIGHT = 900
const CELL = 7
const SIMPLIFY = 1.6
const SCAN_PITCH = 6

// The lane's palette, exact and closed. Nothing else but true black or white may appear, and this
// piece never needs those: the highlight is bright enough for the hottest trace and the shadow dark
// enough for the glass. `ground` is the phosphor's dark, `phosphor` the beam, `highlight` the hottest
// trace, `shadow` the glass.
export const PALETTE = {
  ground: '#0B1A12',
  phosphor: '#7CFFA8',
  highlight: '#E8FFE9',
  shadow: '#04100A',
}

// Dark is the monitor as it is. Light is the same screen printed as a positive: the highlight becomes
// the field, the ground becomes the trace, and the phosphor survives as the green underglow. Both
// variants use only the four hexes; what changes is which one is ground and which one is ink.
const VARIANTS = {
  dark: {
    field: PALETTE.ground,
    trace: PALETTE.phosphor,
    hot: PALETTE.highlight,
    bloom: PALETTE.phosphor,
    trail: PALETTE.phosphor,
    glass: PALETTE.shadow,
    opacity: { heavy: 0.95, medium: 0.8, light: 0.52 },
    scanlineOpacity: 0.34,
    vignetteStart: 58,
    vignetteOpacity: 0.55,
    refreshOpacity: 0.05,
    grain: 'screen',
    grainOpacity: 0.12,
    sheenOpacity: 0.05,
    burnInOpacity: 0.16,
    blend: null,
  },
  light: {
    field: PALETTE.highlight,
    trace: PALETTE.ground,
    hot: PALETTE.ground,
    bloom: PALETTE.phosphor,
    trail: PALETTE.phosphor,
    glass: PALETTE.shadow,
    opacity: { heavy: 0.97, medium: 0.86, light: 0.64 },
    scanlineOpacity: 0.1,
    vignetteStart: 66,
    vignetteOpacity: 0.13,
    refreshOpacity: 0.03,
    grain: 'multiply',
    grainOpacity: 0.09,
    sheenOpacity: 0,
    burnInOpacity: 0.3,
    // A positive print of the same screen: the green glow has to sit on the paper like ink, so the
    // halo and trail multiply instead of adding.
    blend: 'multiply',
  },
}

const THEME_WORDS = {
  // Many hands: agents working together, each contribution a summit of its own.
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
    'orchestrat',
  ],
  // Precision: small fixes that hold — one steady trace, tight intervals, few drops.
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
    'websocket',
  ],
  // Wayfinding: things moved, merged, renamed, dropped — a wider blanking, more wander.
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
    'window',
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

// Smooth one-dimensional value noise, used to let a trace breathe along its length.
function smoothNoise(seed, at) {
  const index = Math.floor(at)
  const fraction = at - index
  const eased = fraction * fraction * (3 - 2 * fraction)
  const a = latticeNoise(seed, index)
  const b = latticeNoise(seed, index + 1)
  return a + (b - a) * eased
}

// Smooth two-dimensional value noise, and three octaves of it: the ground under the summits.
function valueNoise(seed, x, y) {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const ease = (t) => t * t * (3 - 2 * t)
  const corner = (i, j) => latticeNoise(seed, Math.imul(i, 73856093) ^ Math.imul(j, 19349663))
  const a = corner(x0, y0)
  const b = corner(x0 + 1, y0)
  const c = corner(x0, y0 + 1)
  const d = corner(x0 + 1, y0 + 1)
  const sx = ease(x - x0)
  const sy = ease(y - y0)
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
      4 + themes.hands * 11 + themes.density * 6 - themes.precision * 4 - themes.wayfinding * 2 + jitter(2),
    ),
    4,
    16,
  )
  const levels = clamp(
    Math.round(9 + themes.precision * 9 + themes.density * 8 - themes.wayfinding * 2 + jitter(2)),
    8,
    20,
  )
  // A held ridge when the release was about things holding; a cleared interval when it was about
  // moving things and dropping clutter. The two pull against each other in a busy release.
  const ridge = themes.precision > 0.55
  const cleared = themes.wayfinding - themes.precision * 0.8 > 0.22

  return {
    version,
    seed,
    themes,
    summits,
    levels,
    // The interval is not an even division of the height: a release with more to say gets closer
    // contours, and the manifest records the step the notes chose.
    interval: 0.9 / Math.max(1, levels - 1),
    ridge,
    cleared,
    base: clamp(300 - summits * 12, 128, 260),
    wobble: 1.9 - themes.precision * 0.8,
    // The beam wanders more at the edges on a busy, reorganising release and barely at all on a
    // release about things holding still.
    jitter: clamp(0.7 + themes.density * 2.2 + themes.wayfinding * 1.4 - themes.precision * 0.9, 0.5, 4),
    // The blanked interval: narrow on a precise release, wide enough to be a way through on one
    // that reorganised. Never so narrow that the cut stops being composition.
    gap: clamp(30 + themes.wayfinding * 122 - themes.precision * 12 + jitter(10), 30, 150),
    gapPull: 2.4 + themes.wayfinding * 1.6,
    dropouts: Math.round(14 + themes.density * 36),
    // A better-focused beam: a tighter glow.
    bloom: clamp(8.6 - themes.precision * 3 + jitter(0.8), 5, 10),
    burnIn: 0.45 + themes.density * 0.25,
    warp: 0.18 + themes.density * 0.12,
  }
}

// ---------------------------------------------------------------- terrain

function makeTerrain(plan, seed) {
  const random = mulberry32(seed ^ 0x51ed270b)
  const peaks = []
  const range = (low, high) => low + random() * (high - low)

  // Broad swells under everything: the field has a shape beyond its summits, so traces cross the
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
    // Stretched summits: an elongated crest draws a trace that narrows and opens again instead of a
    // clean ring.
    const aspect = range(0.65, 2.1)
    peaks.push({
      cx,
      cy,
      sx: plan.base * range(0.6, 1.2) * aspect,
      sy: (plan.base * range(0.55, 1.1)) / aspect,
      rotation: range(-1.1, 1.1),
      amplitude: range(0.3, 0.8),
    })
    // A shoulder: rings around one summit lean into the next and stop being circles.
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
    // Ground, not a set of dunes: the relief noise is what keeps the traces from closing into clean
    // rings around each summit.
    return height + (relief(reliefSeed, x, y) - 0.5) * reliefStrength
  }
  return sample
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

// A hand, not a plotter: offset every point along its normal by slow noise, so parallel traces
// drift near and apart instead of holding a constant distance.
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

// The beam's horizontal wander: nothing at the centre of the glass, a few pixels near its edges,
// smooth along the trace like a deflection that cannot quite hold its timing.
function beamJitter(points, amplitude, seed) {
  const out = []
  let travelled = 0
  for (let i = 0; i < points.length; i++) {
    if (i > 0) travelled += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
    const edge = Math.pow(Math.min(1, Math.abs(points[i][0] - WIDTH / 2) / (WIDTH / 2)), 2)
    const slow = (smoothNoise(seed, travelled * 0.01) - 0.5) * 2
    const quick = (smoothNoise(seed + 31, travelled * 0.055) - 0.5) * 2
    const shift = (slow * 0.72 + quick * 0.28) * amplitude * (0.35 + edge * 1.65)
    out.push([points[i][0] + shift, points[i][1]])
  }
  return out
}

// ---------------------------------------------------------------- interruptions

// One blanked interval across the raster, plus the trace dropouts where the beam loses the line for
// a moment. The blanking is the composition's one cut; the dropouts are the screen's condition.
function makeBlanks(plan, seed) {
  const random = mulberry32(seed ^ 0x2f6b1d3d)
  const range = (low, high) => low + random() * (high - low)
  const blanks = []
  const band = {
    kind: 'band',
    cy: range(0.34, 0.62) * HEIGHT,
    halfHeight: plan.gap / 2,
    wobble: 3.5 + plan.themes.wayfinding * 4,
    pull: plan.gapPull,
    reach: 34 + plan.gap * 0.22,
    edgeSeed: seed ^ 0x5eb1a3,
  }
  blanks.push(band)

  for (let i = 0; i < plan.dropouts; i++) {
    blanks.push({
      kind: 'bite',
      cx: range(-0.02, 1.02) * WIDTH,
      cy: range(-0.02, 1.02) * HEIGHT,
      hx: range(0.9, 2.6),
      hy: range(3, 13),
      angle: range(-1.4, 1.4),
    })
  }

  for (const blank of blanks) {
    if (blank.kind === 'bite') {
      blank.cos = Math.cos(blank.angle)
      blank.sin = Math.sin(blank.angle)
    }
  }
  return { band, blanks }
}

function bandEdgeY(band, x) {
  return band.cy + (smoothNoise(band.edgeSeed, x * 0.008) - 0.5) * 2 * band.wobble
}

function inside(blank, p) {
  if (blank.kind === 'band') return Math.abs(p[1] - bandEdgeY(blank, p[0])) < blank.halfHeight
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

// The beam is pulled toward the blanking as it approaches it: traces bend into the gap and stop,
// which reads as a deflection losing the line rather than as a strip cut out of a drawing.
function deflect(points, band) {
  const edge = (y, x) => bandEdgeY(band, x)
  return points.map(([x, y]) => {
    const distance = Math.abs(y - edge(y, x)) - band.halfHeight
    if (distance >= band.reach) return [x, y]
    const pull = Math.pow(1 - Math.max(0, distance) / band.reach, 2) * band.pull
    return [x, y + (y < edge(y, x) ? pull : -pull)]
  })
}

// Where a segment crosses into a blank, land the line just outside it, so the cut reads as the beam
// lifting rather than as a straight crop.
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

// ---------------------------------------------------------------- SVG

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

// A batch of path data becomes the path elements of one group.
function pathElements(data) {
  return (data.match(/M[^M]+/g) || []).map((one) => `<path d="${one}"/>`).join('')
}

function piece(version, plan, variant) {
  const palette = VARIANTS[variant]
  const label = version.replace(/^v/, '')
  const seed = plan.seed
  const terrain = makeTerrain(plan, seed)
  const grid = fieldGrid(terrain)
  const { band, blanks } = makeBlanks(plan, seed)
  const random = mulberry32(seed ^ 0x7a3c93f1)

  const levelValues = []
  for (let i = 0; i < plan.levels; i++) {
    // Contour intervals, not quite even: a plotted field, with the plotter's hand in it.
    const base = 0.05 + (i / (plan.levels - 1)) * 0.9
    levelValues.push(base + (random() - 0.5) * 0.008)
  }

  const byLevel = levelValues.map((level, index) => {
    const rings = []
    const opens = []
    for (const line of isoLines(grid, level)
      .map((points) => simplify(points, SIMPLIFY))
      .filter((points) => points.length > 2)
      .map((points) => breathe(points, plan.wobble, seed + index * 131))
      .map((points) => deflect(points, band))
      .map((points) => beamJitter(points, plan.jitter, seed + index * 313))) {
      const closed =
        Math.abs(line[0][0] - line[line.length - 1][0]) < 0.5 &&
        Math.abs(line[0][1] - line[line.length - 1][1]) < 0.5
      if (closed) rings.push(line)
      else opens.push(line)
    }
    return { index, level, rings, opens }
  })

  // Burn-in: a wide, dim trace under one measured level, where the phosphor has been worked hardest.
  // It follows the terrain, so the glow sits in ground that was actually plotted.
  const blend = palette.blend ? ` style="mix-blend-mode:${palette.blend}"` : ''
  const burnIndex = Math.round(plan.levels * plan.burnIn)
  const burnLevel = byLevel[burnIndex]
  const burnData = burnLevel
    ? [...burnLevel.rings, ...burnLevel.opens]
        .flatMap((line) => cut(line, blanks))
        .filter((run) => runLength(run) > 14)
        .map((run) => pathData(run))
        .join('')
    : ''
  const burnIn = burnData
    ? `<g filter="url(#burn)" stroke="${palette.bloom}" stroke-opacity="${palette.burnInOpacity}" stroke-width="26"${blend}>${pathElements(burnData)}</g>`
    : ''

  // Three trace weights rather than one: the beam bears down on some contours and barely touches
  // others. The heavy trace is the brightest on the screen, and the one that blooms.
  const classes = {
    heavy: { weight: 1.9, paths: [] },
    medium: { weight: 1.25, paths: [] },
    light: { weight: 0.82, paths: [] },
  }
  const heavyShare = 0.07 + (1 - plan.themes.density) * 0.1
  let lineCount = 0

  for (const { index, rings, opens } of byLevel) {
    const indexLine = index % 5 === 0
    for (const line of [...opens, ...rings]) {
      const roll = random()
      const name = indexLine || roll < heavyShare ? 'heavy' : roll < heavyShare + 0.3 ? 'medium' : 'light'
      for (const run of cut(line, blanks)) {
        if (runLength(run) < 12) continue
        classes[name].paths.push(pathData(run))
        lineCount++
      }
    }
  }

  const heavy = classes.heavy.paths.join('')
  const medium = classes.medium.paths.join('')
  const light = classes.light.paths.join('')

  const layer = (body, stroke, width, opacity) =>
    body
      ? `<g stroke="${stroke}" stroke-opacity="${opacity}" stroke-width="${width}">${pathElements(body)}</g>`
      : ''

  // The persistence trail: where the beam was a moment ago, displaced along its sweep and already
  // decaying. It sits under everything, so the crisp trace reads as the current frame.
  const trail =
    heavy || medium
      ? `<g transform="translate(${7 + Math.round(plan.jitter)} 1.5)" filter="url(#trail)" stroke="${
          palette.trail
        }" stroke-opacity="${variant === 'dark' ? 0.15 : 0.42}" stroke-width="1.35"${blend}>${pathElements(
          heavy + medium,
        )}</g>`
      : ''

  // Bloom: a blurred copy of the brightest trace under the crisp one, plus a tight unfiltered halo.
  const halo = heavy
    ? `<g filter="url(#bloom)" stroke="${palette.bloom}" stroke-opacity="${
        variant === 'dark' ? 0.5 : 0.55
      }" stroke-width="${(plan.bloom / 5).toFixed(2)}"${blend}>${pathElements(heavy)}</g><g stroke="${
        palette.bloom
      }" stroke-opacity="${variant === 'dark' ? 0.14 : 0.3}" stroke-width="5.5"${blend}>${pathElements(
        heavy,
      )}</g>`
    : ''

  const grainSeed = plan.seed % 1000
  const refreshTop = Math.round((0.18 + ((plan.seed >>> 8) % 100) / 200) * HEIGHT)
  const sheen =
    palette.sheenOpacity > 0 ? `<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#sheen)"/>` : ''

  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="title describe">
<title id="title">Contour field on a green phosphor display, CrossBoard ${label}</title>
<desc id="describe">Abstract contour lines drawn like a vector display on a green phosphor monitor, with bloom, scanlines, one blanked interval and screen noise.</desc>
<defs><filter id="bloom" x="-12%" y="-18%" width="124%" height="136%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${plan.bloom.toFixed(2)}"/></filter><filter id="trail" x="-8%" y="-12%" width="116%" height="124%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="2.2"/></filter><filter id="burn" x="-15%" y="-25%" width="130%" height="150%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="16"/></filter><filter id="grain" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" seed="${grainSeed}" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><radialGradient id="glass" cx="50%" cy="47%" r="72%"><stop offset="${palette.vignetteStart}%" stop-color="${palette.glass}" stop-opacity="0"/><stop offset="100%" stop-color="${palette.glass}" stop-opacity="${palette.vignetteOpacity}"/></radialGradient><radialGradient id="sheen" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="${palette.hot}" stop-opacity="${palette.sheenOpacity}"/><stop offset="100%" stop-color="${palette.hot}" stop-opacity="0"/></radialGradient><linearGradient id="refresh" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${palette.trace}" stop-opacity="0"/><stop offset="50%" stop-color="${palette.trace}" stop-opacity="${palette.refreshOpacity}"/><stop offset="100%" stop-color="${palette.trace}" stop-opacity="0"/></linearGradient><pattern id="scan" width="${WIDTH}" height="${SCAN_PITCH}" patternUnits="userSpaceOnUse"><rect width="${WIDTH}" height="1" fill="${palette.glass}" fill-opacity="${palette.scanlineOpacity}"/></pattern></defs>
<rect width="${WIDTH}" height="${HEIGHT}" fill="${palette.field}"/>
${sheen}<g fill="none" stroke-linecap="round" stroke-linejoin="round">${burnIn}${trail}${halo}${layer(
      light,
      palette.trace,
      classes.light.weight,
      palette.opacity.light,
    )}${layer(medium, palette.trace, classes.medium.weight, palette.opacity.medium)}${layer(
      heavy,
      palette.hot,
      classes.heavy.weight,
      palette.opacity.heavy,
    )}</g>
<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#scan)"/>
<rect y="${refreshTop}" width="${WIDTH}" height="120" fill="url(#refresh)"/>
<rect width="${WIDTH}" height="${HEIGHT}" filter="url(#grain)" style="mix-blend-mode:${palette.grain}" opacity="${palette.grainOpacity}"/>
<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glass)"/>
</svg>
`,
    stats: { lines: lineCount, heavy: classes.heavy.paths.length },
  }
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
      console.log('Usage: node scripts/release-art/retro-crt.mjs [--version vX.Y.Z --notes FILE] [--out DIR]')
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
    const seed = hashString(`retro-crt/${version}`)
    const themes = readThemes(notes)
    const plan = planPiece(version, themes, seed)
    const files = {}

    for (const { variant, svg, stats } of variantsFor(plan)) {
      const name = `${version}-${variant}.svg`
      writeFileSync(join(outDir, name), svg)
      files[variant] = name
      console.log(`${version} ${variant}: ${Buffer.byteLength(svg)} bytes, ${stats.lines} traces`)
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
        jitter: round(plan.jitter),
        ridge: plan.ridge,
        cleared: plan.cleared,
      },
      screen: {
        bloom: round(plan.bloom),
        gap: round(plan.gap),
        dropouts: plan.dropouts,
        scanlinePitch: SCAN_PITCH,
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
    direction: 'retro-crt',
    generator: 'scripts/release-art/retro-crt.mjs',
    canvas: { width: WIDTH, height: HEIGHT },
    palette: PALETTE,
    roles: {
      dark: {
        field: 'ground',
        trace: 'phosphor',
        hot: 'highlight',
        bloom: 'phosphor',
        trail: 'phosphor',
        glass: 'shadow',
      },
      light: {
        field: 'highlight',
        trace: 'ground',
        hot: 'ground',
        bloom: 'phosphor',
        trail: 'phosphor',
        glass: 'shadow',
      },
    },
    scanlinePitch: SCAN_PITCH,
    releases,
  }
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Wrote ${releases.length * 2} pieces and manifest.json to ${outDir}`)
}

function round(value) {
  return Math.round(value * 1000) / 1000
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(`retro-crt: ${error.message}`)
    process.exitCode = 1
  }
}
