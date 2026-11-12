#!/usr/bin/env node
// Release artwork: contour field, recorded to tape.
//
// The shape is the approved one: an implied terrain seen from above, iso-lines at an interval the
// release's notes pick, three line weights, and a deliberate interruption. What this direction adds
// is the recording. The contours are a signal read back off analog tape, so they carry a one to
// three pixel chroma split, a soft bloom under the crisp lines, a few tracking bands that pull the
// field sideways, dropouts that take short bites out of it, a slow wobble along the y-axis, and a
// grain finer than paper's. Nothing here is a gradient: every mark is a line, a cut, or noise.
//
// The palette is fixed by the lane and declared in PALETTE; ground and ink swap between the two
// variants and nothing else does.
//
// Usage:
//   node scripts/release-art/retro-vhs.mjs                  # regenerate the committed series
//   node scripts/release-art/retro-vhs.mjs --out /tmp/art   # write somewhere else
//   node scripts/release-art/retro-vhs.mjs --version v0.3.0 \
//     --notes scripts/release-art/notes/v0.3.0.md --out /tmp/art
//
// A new release needs nothing but its notes: drop `gh release view vX.Y.Z --json body --jq .body`
// into scripts/release-art/notes/vX.Y.Z.md and run the first command again.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const NOTES_DIR = join(ROOT, 'scripts/release-art/notes')
const ASSET_DIR = join(ROOT, 'src/assets/release-art/retro-vhs')

const WIDTH = 1600
const HEIGHT = 900
const CELL = 7
const SIMPLIFY = 1.7

// The lane's four hexes, written once. Every fill and stroke in a piece comes from this object, so
// the palette can be checked by reading the files: no other value is written.
const PALETTE = {
  tapeBlack: '#101014',
  signal: '#E6E1D6',
  chromaRed: '#FF4D6D',
  chromaCyan: '#4DE1FF',
}

// Paper and ink swap; the chroma channels do not, because they belong to the tape and not to the
// theme. The chroma sits low over the ground so it reads as a fringe and never as a neon glow.
const VARIANTS = {
  light: {
    ground: PALETTE.signal,
    ink: PALETTE.tapeBlack,
    red: PALETTE.chromaRed,
    cyan: PALETTE.chromaCyan,
    grainBlend: 'multiply',
    grainOpacity: 0.12,
    trackBlend: 'multiply',
    trackOpacity: 0.05,
    washOpacity: 0.05,
    chromaOpacity: 0.34,
    bloomOpacity: 0.12,
  },
  dark: {
    ground: PALETTE.tapeBlack,
    ink: PALETTE.signal,
    red: PALETTE.chromaRed,
    cyan: PALETTE.chromaCyan,
    grainBlend: 'screen',
    grainOpacity: 0.1,
    trackBlend: 'screen',
    trackOpacity: 0.06,
    washOpacity: 0.06,
    chromaOpacity: 0.3,
    bloomOpacity: 0.1,
  },
}

const THEME_WORDS = {
  // Many hands: the release was about agents working together, each one a small summit.
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
  // Precision: small fixes that hold — one steady ridge, tight intervals, few tears.
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
  // Wayfinding: things moved, merged, renamed, dropped — a field pulled sideways and cleared.
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

// Smooth one-dimensional value noise, used to let a line breathe along its length and to let the
// whole field drift up and down as a tape head does.
function smoothNoise(seed, at) {
  const index = Math.floor(at)
  const fraction = at - index
  const eased = fraction * fraction * (3 - 2 * fraction)
  const a = latticeNoise(seed, index)
  const b = latticeNoise(seed, index + 1)
  return a + (b - a) * eased
}

// Smooth two-dimensional value noise, and three octaves of it: the ground under the summits.
// Without it a field of gaussians draws ovals; with it the lines bend the way ground does.
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

function readThemes(notes) {
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

function planPiece(version, themes, seed) {
  const random = mulberry32(seed)
  const jitter = (amount) => (random() - 0.5) * amount

  const summits = clamp(
    Math.round(
      4 + themes.hands * 11 + themes.density * 7 - themes.precision * 5 - themes.wayfinding * 3 + jitter(2),
    ),
    4,
    16,
  )
  const levels = clamp(
    Math.round(9 + themes.precision * 9 + themes.density * 8 - themes.wayfinding * 2 + jitter(2)),
    8,
    20,
  )
  // A held ridge when the release was about things holding; a cleared corridor when it was about
  // moving things and dropping clutter. The two pull against each other in a busy release.
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
    // A busy release takes smaller summits; a calm one lets them spread.
    base: clamp(300 - summits * 12, 128, 260),
    wobble: 1.9 - themes.precision * 0.8,
    nickCount: Math.round(16 + themes.density * 34),
    warp: 0.18 + themes.density * 0.12,
    // The tape, not the terrain. Many hands lay the line down a little apart (the chroma split);
    // a reorganising release is the one that gets pulled sideways (tracking bands); a busy release
    // is the one that loses signal (dropouts).
    tape: {
      split: round(clamp(1.8 + themes.hands * 1.3 + jitter(0.5), 1.8, 3), 2),
      bands: clamp(Math.round(2 + themes.wayfinding * 2 + jitter(1)), 2, 4),
      bandShift: clamp(round(2 + themes.wayfinding * 5, 2), 2, 8),
      dropouts: Math.round(5 + themes.density * 12 + themes.wayfinding * 4),
      drift: round(clamp(2.2 - themes.precision * 1.2 + themes.wayfinding * 0.9, 0.8, 3.4), 2),
    },
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
    // Stretched summits: an elongated crest draws a line that narrows and opens again instead of a
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
    // A shoulder: contour rings around one summit lean into the next and stop being circles.
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
    // Ground, not a set of dunes: the relief noise is what keeps the lines from closing into
    // clean rings around each summit.
    return height + (relief(reliefSeed, x, y) - 0.5) * reliefStrength
  }
  return sample
}

function fieldGrid(sample) {
  const nx = Math.floor(WIDTH / CELL) + 1
  const ny = Math.floor(HEIGHT / CELL) + 1
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

// A hand, not a plotter: offset every point along its normal by slow noise, so parallel lines
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

// ---------------------------------------------------------------- the tape's hand

// The head does not sit perfectly: the whole field drifts up and down at a long wavelength, a few
// pixels over the frame, which reads as a slow wobble and never as a squiggle.
function drift(points, amplitude, seed, phase) {
  let travelled = 0
  return points.map((p, i) => {
    if (i > 0) travelled += Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1])
    const slow = (smoothNoise(seed, p[0] * 0.0026 + phase * 0.13) - 0.5) * 2 * amplitude
    const along = (smoothNoise(seed + 53, travelled * 0.004) - 0.5) * 0.8
    return [p[0], p[1] + slow + along]
  })
}

// ---------------------------------------------------------------- interruptions

function makeBlanks(plan, seed) {
  const random = mulberry32(seed ^ 0x2f6b1d3d)
  const range = (low, high) => low + random() * (high - low)
  const blanks = []

  if (plan.corridor) {
    // A wide cleared way through the field: the release moved things and dropped what it did not
    // need, so the ground has somewhere it is silent.
    const angle = range(-0.35, 0.35)
    blanks.push({
      cx: range(0.35, 0.65) * WIDTH,
      cy: range(0.35, 0.65) * HEIGHT,
      hx: WIDTH * 1.1,
      hy: range(0.06, 0.09) * HEIGHT,
      angle,
    })
    if (plan.themes.wayfinding > 0.6) {
      blanks.push({
        cx: range(0.2, 0.8) * WIDTH,
        cy: range(0.2, 0.8) * HEIGHT,
        hx: WIDTH * 0.75,
        hy: range(0.03, 0.055) * HEIGHT,
        angle: angle + range(0.8, 1.3),
      })
    }
  }

  // Nicks: small, elongated bites that eat a line for a few pixels. These are the grain's work,
  // not a composition choice, so they are spread evenly and kept small.
  for (let i = 0; i < plan.nickCount; i++) {
    blanks.push({
      cx: range(-0.02, 1.02) * WIDTH,
      cy: range(-0.02, 1.02) * HEIGHT,
      hx: range(1.1, 3.6),
      hy: range(4, 18),
      angle: range(-1.4, 1.4),
    })
  }

  // Dropouts: a tape that lost a line of signal for a moment. These are horizontal slots — longer
  // than the nicks and only a line or two tall — so the gap reads as the tape, not as the terrain.
  for (let i = 0; i < plan.tape.dropouts; i++) {
    blanks.push({
      cx: range(-0.03, 1.03) * WIDTH,
      cy: range(-0.03, 1.03) * HEIGHT,
      hx: range(4, 22),
      hy: range(0.8, 1.7),
      angle: range(-0.06, 0.06),
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

// Where a segment crosses into a blank, land the line just outside it, so the cut reads as the
// pencil lifting — or the tape losing the track — rather than as a straight crop.
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

// ---------------------------------------------------------------- tracking bands

// Two to four bands where the tape's tracking slipped: inside each, a copy of the field sits a few
// pixels to the side, its chroma further apart, its grain heavier. They are the piece's one big
// gesture of damage and they are placed off the vertical centre so the card's heading never sits on
// one. A band rarely runs the whole width: the head loses the track for a stretch, finds it again,
// so each one is one or two broken segments rather than a ruler line across the piece.
function makeTracking(plan, seed) {
  const random = mulberry32(seed ^ 0x6f4a91b7)
  const range = (low, high) => low + random() * (high - low)
  const bands = []
  const count = plan.tape.bands
  for (let i = 0; i < count; i++) {
    const slot = (i + 1) / (count + 1)
    const top = (slot + range(-0.06, 0.06)) * HEIGHT
    const height = range(14, 48)
    const direction = random() < 0.5 ? -1 : 1
    const segments = []
    let left = Math.round(range(-0.06, 0.14) * WIDTH)
    const pieces = random() < 0.5 ? 1 : 2
    for (let piece = 0; piece < pieces; piece++) {
      const width = Math.round(range(0.36, 0.66) * WIDTH)
      segments.push({ x: left, width })
      left += width + Math.round(range(0.1, 0.26) * WIDTH)
    }
    bands.push({
      y: Math.round(top),
      height: Math.round(height),
      // A band slips further than the field's own split, but never past the lane's 3 px ceiling.
      shift: Math.round(direction * Math.min(8, plan.tape.bandShift + range(0, 1.6)) * 10) / 10,
      split: Math.round(Math.min(3, plan.tape.split + range(0.8, 1.8)) * 10) / 10,
      noiseOpacity: Math.round(range(0.07, 0.13) * 100) / 100,
      segments,
    })
  }
  return bands
}

// The outline of one tracking segment: straight top and bottom, a ragged edge at each end. The
// numbers come from the segment's own index, so the same piece always draws the same tear.
function bandSegmentPath(segment, band, salt) {
  const round = (n) => Math.round(n)
  const left = segment.x
  const right = segment.x + segment.width
  const top = band.y
  const bottom = band.y + band.height
  const wobble = (side) => 2.4 + ((Math.sin(salt * 12.9898 + side * 78.233) + 1) / 2) * 3.6
  const a = wobble(1)
  const b = wobble(2)
  const c = wobble(3)
  const d = wobble(4)
  return `M${round(left + a)} ${top}L${round(right - a)} ${top}Q${round(right + b)} ${round(
    top + band.height * 0.32,
  )} ${round(right - c * 0.4)} ${round(top + band.height * 0.62)}Q${round(right + d * 0.7)} ${round(
    top + band.height * 0.86,
  )} ${round(right - b * 0.5)} ${bottom}L${round(left + c)} ${bottom}Q${round(left - d)} ${round(
    top + band.height * 0.68,
  )} ${round(left + b * 0.6)} ${round(top + band.height * 0.36)}Q${round(left - a * 0.5)} ${round(
    top + band.height * 0.14,
  )} ${round(left + a)} ${top}Z`
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

function piece(plan) {
  const label = plan.version.replace(/^v/, '')
  const seed = plan.seed
  const terrain = makeTerrain(plan, seed)
  const grid = fieldGrid(terrain)
  const blanks = makeBlanks(plan, seed)
  const tracking = makeTracking(plan, seed)
  const random = mulberry32(seed ^ 0x7a3c93f1)
  const palette = plan.palette

  const levelValues = []
  for (let i = 0; i < plan.levels; i++) {
    // Contour intervals, not quite even: a plotted field, with the plotter's hand in it.
    const base = 0.05 + (i / (plan.levels - 1)) * 0.9
    levelValues.push(base + (random() - 0.5) * 0.008)
  }

  const byLevel = levelValues.map((level, index) => {
    const rings = []
    const opens = []
    const lines = isoLines(grid, level)
      .map((points) => simplify(points, SIMPLIFY))
      .filter((points) => points.length > 2)
      .map((points) => breathe(points, plan.wobble, seed + index * 131))
      .map((points) => drift(points, plan.tape.drift, seed + index * 71, index))
    for (const line of lines) {
      const closed =
        Math.abs(line[0][0] - line[line.length - 1][0]) < 0.5 &&
        Math.abs(line[0][1] - line[line.length - 1][1]) < 0.5
      if (closed) rings.push(line)
      else opens.push(line)
    }
    return { index, level, rings, opens }
  })

  // Three weights rather than one: the tape's signal is strong on some passes and barely there on
  // others. They are heavier than a pencil's would be, because the bloom eats half a pixel off each
  // side and because they have to hold when the piece is shown at a third of its size.
  const classes = {
    heavy: { weight: 2.35, opacity: 0.8, paths: [] },
    medium: { weight: 1.62, opacity: 0.58, paths: [] },
    light: { weight: 1.12, opacity: 0.4, paths: [] },
  }
  const heavyShare = 0.08 + (1 - plan.themes.density) * 0.1
  let lineCount = 0
  let runCount = 0

  for (const { index, rings, opens } of byLevel) {
    const indexLine = index % 5 === 0
    for (const line of [...opens, ...rings]) {
      const roll = random()
      const name = indexLine || roll < heavyShare ? 'heavy' : roll < heavyShare + 0.3 ? 'medium' : 'light'
      for (const run of cut(line, blanks)) {
        if (runLength(run) < 12) continue
        classes[name].paths.push(pathData(run))
        lineCount++
        runCount++
      }
    }
  }

  // Path data is written once, in defs, and every layer re-uses it: bloom, chroma and ink are the
  // same field at different offsets and blurs. That keeps a piece small and guarantees the layers
  // cannot disagree about where the contours are.
  const groups = Object.entries(classes)
    .map(([name, group]) => {
      const paths = group.paths.map((data) => `<path d="${data}"/>`).join('')
      return `<g id="ink-${name}" fill="none" stroke-linecap="round" stroke-linejoin="round">${paths}</g>`
    })
    .join('')

  const use = (name, attributes) => `<use href="#ink-${name}" ${attributes}/>`
  const weightOf = (name) => classes[name].weight

  const inkLayer = Object.entries(classes)
    .map(
      ([name, group]) =>
        `<g stroke="${palette.ink}" stroke-width="${group.weight}" stroke-opacity="${group.opacity}">${use(
          name,
          '',
        )}</g>`,
    )
    .join('')

  const bloomLayer = Object.keys(classes)
    .map((name) =>
      use(
        name,
        `stroke="${palette.ink}" stroke-width="${round2(weightOf(name) + 0.7)}" stroke-opacity="${palette.bloomOpacity}" filter="url(#bloom)"`,
      ),
    )
    .join('')

  // Chroma is a lag, not an outline: the red and cyan passes sit a couple of pixels to either side
  // of the ink, softened, and each has a wider, fainter echo behind it the way a tape's colour
  // trails its brightness. It is always horizontal first; the few tenths of a pixel of vertical
  // offset are what keeps the fringe from looking printed.
  const split = plan.tape.split
  const fringe = (colour, opacity, offset, blur) =>
    `<g filter="url(#${blur})" transform="translate(${round2(offset)} ${round2(offset * 0.3)})"><g stroke="${colour}" stroke-opacity="${round2(opacity)}">${[
      'heavy',
      'medium',
    ]
      .map((name) => use(name, `stroke-width="${weightOf(name)}"`))
      .join('')}</g></g>`
  const chroma = [
    fringe(palette.red, palette.chromaOpacity * 0.4, split * 1.75, 'echo'),
    fringe(palette.cyan, palette.chromaOpacity * 0.34, -split * 1.75, 'echo'),
    fringe(palette.red, palette.chromaOpacity, split, 'fringe'),
    fringe(palette.cyan, palette.chromaOpacity * 0.86, -split, 'fringe'),
  ].join('')

  // The bands: the field, shifted, clipped to a horizontal strip, with its chroma pulled wider and
  // its own noise across the strip. A tear line at the lower edge says where the head lost track.
  // A lost track does not start at a clean rectangle edge. Each segment's two vertical ends are
  // drawn as a short irregular edge, so the band begins and ends the way a tape does: raggedly, and
  // with its top and bottom still straight, because those are the head's lines.
  const clips = tracking
    .map(
      (band, index) =>
        `<clipPath id="band-${index}">${band.segments
          .map((segment, piece) => bandSegmentPath(segment, band, index * 3 + piece))
          .join('')}</clipPath>`,
    )
    .join('')
  const bandLayers = tracking
    .map((band, index) => {
      const inner = [
        `<g stroke="${palette.red}" stroke-opacity="${palette.chromaOpacity * 1.15}">${['heavy', 'medium']
          .map((name) => use(name, `stroke-width="${weightOf(name)}"`))
          .join('')}</g>`,
        `<g stroke="${palette.cyan}" stroke-opacity="${palette.chromaOpacity}">${['heavy', 'medium']
          .map((name) => use(name, `stroke-width="${weightOf(name)}"`))
          .join('')}</g>`,
        `<g stroke="${palette.ink}">${['heavy', 'medium', 'light']
          .map((name) =>
            use(
              name,
              `stroke-width="${weightOf(name)}" stroke-opacity="${round2(classes[name].opacity * 0.92)}"`,
            ),
          )
          .join('')}</g>`,
      ].join('')
      const noise = band.segments
        .map(
          (segment) =>
            `<rect x="${segment.x}" y="${band.y}" width="${segment.width}" height="${band.height}" filter="url(#track)" style="mix-blend-mode:${palette.trackBlend}" opacity="${band.noiseOpacity}"/><rect x="${segment.x}" y="${band.y + band.height - 1.2}" width="${segment.width}" height="1.2" fill="${palette.ink}" opacity="0.08"/>`,
        )
        .join('')
      return `<g clip-path="url(#band-${index})"><g transform="translate(${band.shift} ${round2(band.shift * 0.18)})"><g filter="url(#fringe)" transform="translate(${band.split} 0)">${inner}</g></g>${noise}</g>`
    })
    .join('')

  // Tape hits: a handful of short signal flecks, brighter than the lines and gone in a few pixels,
  // and the other half of a dropout — a streak of bare ground where the head read nothing at all.
  const hits = mulberry32(seed ^ 0x45d9f3b)
  const flecks = []
  for (let i = 0; i < 7; i++) {
    const x = Math.round(hits() * WIDTH)
    const y = Math.round(hits() * HEIGHT)
    const width = Math.round(24 + hits() * 90)
    flecks.push(
      `<rect x="${x}" y="${y}" width="${width}" height="1" fill="${palette.ink}" opacity="${round2(
        0.13 + hits() * 0.14,
      )}"/>`,
    )
  }
  for (let i = 0; i < Math.round(plan.tape.dropouts * 0.5); i++) {
    const x = Math.round(hits() * WIDTH)
    const y = Math.round(hits() * HEIGHT)
    const width = Math.round(14 + hits() * 52)
    flecks.push(
      `<rect x="${x}" y="${y}" width="${width}" height="${round2(1 + hits())}" fill="${palette.ground}" opacity="${round2(
        0.6 + hits() * 0.35,
      )}"/>`,
    )
  }

  // Highlight rolloff: the tape does not hold a white, so the brightest part of the field is a soft
  // lift of the ground itself, laid under the lines with a wide blur.
  const dense = densityCentre(byLevel)
  const wash = `<g filter="url(#rolloff)"><ellipse cx="${Math.round(dense[0])}" cy="${Math.round(
    dense[1],
  )}" rx="${Math.round(WIDTH * 0.42)}" ry="${Math.round(HEIGHT * 0.34)}" fill="${palette.ink}" opacity="${palette.washOpacity}"/></g>`

  const grainSeed = seed % 1000
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="title describe">
<title id="title">Contour field on tape, CrossBoard ${label}</title>
<desc id="describe">Abstract topographic contour lines recorded to analog tape: a faint red and cyan chroma fringe, a soft bloom, tracking bands pulled sideways, dropouts and grain.</desc>
<defs>${groups}${clips}<filter id="bloom" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="3"/></filter><filter id="fringe" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="0.7"/></filter><filter id="echo" x="-8%" y="-8%" width="116%" height="116%"><feGaussianBlur stdDeviation="1.8"/></filter><filter id="rolloff" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="48"/></filter><filter id="track" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.55 0.03" numOctaves="2" seed="${grainSeed + 7}" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><filter id="grain" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="1.15" numOctaves="3" seed="${grainSeed}" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter></defs>
<rect width="${WIDTH}" height="${HEIGHT}" fill="${palette.ground}"/>
${wash}
<g fill="none">${bloomLayer}${chroma}${inkLayer}</g>
${bandLayers}
${flecks.join('')}
<rect width="${WIDTH}" height="${HEIGHT}" filter="url(#grain)" style="mix-blend-mode:${palette.grainBlend}" opacity="${palette.grainOpacity}"/>
</svg>
`

  return {
    svg,
    stats: { lines: lineCount, runs: runCount, bands: tracking.length, split, dropouts: plan.tape.dropouts },
  }
}

// The wash sits where the field is densest: the mean position of the level that carries the most
// line, so the piece has uneven illumination without a gradient.
function densityCentre(byLevel) {
  const busiest = byLevel
    .map((level) => ({ level, count: level.rings.length + level.opens.length }))
    .sort((a, b) => b.count - a.count)[0]
  const points = busiest ? [...busiest.level.rings, ...busiest.level.opens].flat() : []
  if (!points.length) return [WIDTH / 2, HEIGHT / 2]
  let x = 0
  let y = 0
  for (const point of points) {
    x += point[0]
    y += point[1]
  }
  return [x / points.length, y / points.length]
}

function round2(value) {
  return Math.round(value * 100) / 100
}

// ---------------------------------------------------------------- plan to files

function variantsFor(plan) {
  return ['light', 'dark'].map((variant) => {
    const { svg, stats } = piece({ ...plan, palette: VARIANTS[variant] })
    return { variant, svg, stats }
  })
}

function parseArgs(argv) {
  const args = { out: null, version: null, notes: null }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--out') args.out = argv[++i]
    else if (flag === '--version') args.version = argv[++i]
    else if (flag === '--notes') args.notes = argv[++i]
    else if (flag === '--help' || flag === '-h') {
      console.log('Usage: node scripts/release-art/retro-vhs.mjs [--version vX.Y.Z --notes FILE] [--out DIR]')
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
    const seed = hashString(`retro-vhs/${version}`)
    const themes = readThemes(notes)
    const plan = planPiece(version, themes, seed)
    const files = {}

    for (const { variant, svg, stats } of variantsFor(plan)) {
      const name = `${version}-${variant}.svg`
      writeFileSync(join(outDir, name), svg)
      files[variant] = name
      console.log(
        `${version} ${variant}: ${Buffer.byteLength(svg)} bytes, ${stats.lines} runs, split ${stats.split}px, ${stats.bands} bands, ${stats.dropouts} dropouts`,
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
      tape: plan.tape,
      files,
    })
  }

  const manifest = {
    direction: 'retro-vhs',
    generator: 'scripts/release-art/retro-vhs.mjs',
    canvas: { width: WIDTH, height: HEIGHT },
    palette: PALETTE,
    variants: {
      light: { ground: PALETTE.signal, ink: PALETTE.tapeBlack },
      dark: { ground: PALETTE.tapeBlack, ink: PALETTE.signal },
    },
    releases,
  }
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Wrote ${releases.length * 2} pieces and manifest.json to ${outDir}`)
}

function round(value) {
  return Math.round(value * 1000) / 1000
}

main()
