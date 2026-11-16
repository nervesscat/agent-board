#!/usr/bin/env node
// Release artwork: screen interference.
//
// A piece is two or three halftone screens, one per ink, printed on one sheet. Nothing is drawn
// but dots on a regular lattice, each dot sized by the tone of its screen at that point. The image
// is what happens between the screens: where two of them overlap at slightly different angles and
// pitches, their dots drift in and out of phase and the sheet fills with slow moiré fringes. A
// fringe magnifies the smallest difference between the screens, so a few pixels of warp in one
// lattice turn into a broad, bending band of colour, and a straight, untouched lattice gives
// straight, ruled fringes. That is the whole vocabulary: lattice, tone, angle, pitch and warp.
//
// Above the piece sit two levels of meaning. The major version picks a thematic (0.x is
// Make-ready, the proofing press before 1.0; 1.x is The run, the press in register), which sets
// how the bands lie, how true the screens are and the accent ink; the minor version is a chapter,
// one step along the arc the thematic declares. See THEMATICS below and RATIONALE.md.
//
// The release's notes are read for four themes (many hands, precision, wayfinding, signals) and
// for their volume, and the version seeds every remaining choice, so the same version and notes
// write the same bytes on every run. A release nobody has seen needs only its notes file.
//
// Usage:
//   node scripts/release-art/screen-interference.mjs                  # regenerate the series
//   node scripts/release-art/screen-interference.mjs --out /tmp/art   # write somewhere else
//   node scripts/release-art/screen-interference.mjs --version v0.3.0 \
//     --notes scripts/release-art/notes/v0.3.0.md --out /tmp/art
//
// To make the next release's piece:
//   gh release view vX.Y.Z --json body --jq .body > scripts/release-art/notes/vX.Y.Z.md
//   node scripts/release-art/screen-interference.mjs

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const NOTES_DIR = join(ROOT, 'scripts/release-art/notes')
const ASSET_DIR = join(ROOT, 'src/assets/release-art/screen-interference')
const DIRECTION = 'screen-interference'

const WIDTH = 1600
const HEIGHT = 900
// Dots are written in quarter pixels, so every coordinate is a short integer.
const UNIT = 4
// The screens' pitch, in pixels of the 1600-wide sheet: at a third of the size a dot still sits
// six pixels from its neighbour, coarse enough to read as a screen and not as a grey wash.
export const PITCH = 17
// Dots grow with the square root of the tone (area follows tone) up to this share of the pitch.
const MAX_TONE = 0.82
const MIN_RADIUS = 0.7
const RADIUS_STEP = 0.35

// Inks and a ground. Light prints the inks over paper and multiplies them where they overlap;
// dark prints lighter pulls of the same inks over a blue-black sheet and screens them, so the
// overlaps brighten instead of darkening. A piece prints three of these inks and nothing else:
// indigo and ochre are the style's and print in every major; the third is the thematic's accent.
export const PALETTE = {
  light: {
    ground: '#F0EBE1',
    inks: { indigo: '#2C467C', vermilion: '#D9553B', ochre: '#C99A2E', viridian: '#2D6B57', plum: '#74406B' },
    blend: 'multiply',
    grain: '#3A332A',
    grainOpacity: 0.16,
  },
  dark: {
    ground: '#14161C',
    inks: { indigo: '#6F93D8', vermilion: '#E8694D', ochre: '#D8B24E', viridian: '#5DB396', plum: '#B784AE' },
    blend: 'screen',
    grain: '#F0EBE1',
    grainOpacity: 0.09,
  },
}
export const PALETTE_HEXES = [
  ...new Set(Object.values(PALETTE).flatMap((v) => [v.ground, ...Object.values(v.inks), v.grain])),
]
export const STYLE_INKS = ['indigo', 'ochre']

// ---------------------------------------------------------------- version, thematic, variation
//
// Four levels. The style (everything above and the drawing below) never changes. The major
// version picks a thematic: what that phase of the product means, as a grammar of how the bands
// lie, how true the screens are and which accent ink prints. The minor version is a chapter of
// the thematic: a step along an arc the thematic declares. The patch is the piece: its notes
// steer the composition inside what the thematic and the chapter allow, and its version seeds
// the rest.

export function parseVersion(version) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(version))
  if (!match) throw new Error(`Not a release version (vMAJOR.MINOR.PATCH): ${version}`)
  const [major, minor, patch] = match.slice(1).map(Number)
  return { major, minor, patch, tag: `v${major}.${minor}.${patch}` }
}

// How the bands lie, for each axis a thematic can take: the band direction in degrees (0 runs
// left to right, 90 top to bottom), and whether its sign is the seed's to choose.
const AXES = {
  diagonal: { from: 8, to: 20, signed: true },
  upright: { from: 88, to: 92, signed: false },
  level: { from: -2, to: 2, signed: false },
  steep: { from: 56, to: 66, signed: true },
}
const AXIS_CYCLE = ['diagonal', 'upright', 'level', 'steep']
const ACCENT_CYCLE = ['vermilion', 'viridian', 'plum']

// Each arc is [first chapter (minor 1), last chapter (minor 3)].
//   gap:     degrees between the screens' lattices; a small gap is a long, slow fringe.
//   warp:    the most a later screen is pushed off true, in pixels; the only thing that bends
//            the fringes.
//   lean:    degrees between the bands; 0 is parallel.
//   spread:  how far apart the bands' centres sit, over the sheet's height (leaning bands), or
//            over a column's half-width (upright columns); less spread is more overlap.
//   reach:   a band's half-length over the sheet's half-diagonal; under 1 it stops inside the
//            sheet as a fragment, over it runs off.
//   breadth: a band's half-width over the sheet's height (across a level or leaning band) or
//            the share of a beat's slot a column fills (upright).
//   beats:   'one' prints one band per screen; 'chapter' prints as many beats as the minor.
//   hold:    'earned' holds an edge only when precision speaks; 'always' holds one on every piece.
export const THEMATICS = {
  0: {
    name: 'Make-ready',
    meaning:
      'Before 1.0 the product is on the proofing press: every release is a trial pull while the ' +
      'plates are moved toward register, and nothing is locked yet.',
    axis: 'diagonal',
    accent: 'vermilion',
    arc: {
      gap: [6.6, 2.4],
      warp: [7, 1.2],
      lean: [26, 4],
      spread: [0.1, 0.075],
      reach: [0.62, 1.6],
      breadth: [0.22, 0.25],
    },
    beats: 'one',
    hold: 'earned',
    chapters: { 1: 'First pull', 2: 'Finding register', 3: 'Near register' },
  },
  1: {
    name: 'The run',
    meaning:
      'From 1.0 the press is in register and the edition is printing: people take sheets off the ' +
      'pile and rely on each one being like the last; what grows is the weight, not the doubt.',
    axis: 'upright',
    accent: 'viridian',
    arc: {
      gap: [2.6, 1.5],
      warp: [0, 0],
      lean: [0, 0],
      spread: [0.5, 0.5],
      reach: [1.6, 1.6],
      breadth: [0.5, 0.62],
    },
    beats: 'chapter',
    hold: 'always',
    pair: 'indigo',
    chapters: { 1: 'First sheets', 2: 'Long run', 3: 'Full stack' },
  },
}

// A major nobody has designed yet still gets a thematic, by rule: its axis and accent come from
// two cycles of different lengths (so no two of the next twelve majors share both), and its arc
// is The run's, because a product past 1.0 stays in register. Its name and meaning are to be
// written by a person when that major starts; until then the manifest marks it derived.
export function thematicFor(major) {
  if (!Number.isInteger(major) || major < 0) throw new Error(`Not a major version: ${major}`)
  if (THEMATICS[major]) return { major, derived: false, ...THEMATICS[major] }
  return {
    major,
    derived: true,
    name: `Major ${major}`,
    meaning: 'Derived by rule; write its name and meaning when this major starts.',
    ...THEMATICS[1],
    axis: AXIS_CYCLE[major % AXIS_CYCLE.length],
    accent: ACCENT_CYCLE[major % ACCENT_CYCLE.length],
    chapters: {},
  }
}

// Where a minor sits on its thematic's arc: 0.1 at its start, 0.3 at its end, 0.0 a half step
// before it; minors after the third keep stepping by ever smaller amounts, toward the next
// thematic, so no two minors of one major are the same chapter.
export function chapterOf(minor) {
  if (!Number.isInteger(minor) || minor < 0) throw new Error(`Not a minor version: ${minor}`)
  if (minor <= 3) return (minor - 1) / 2
  return 1 + 0.35 * (1 - 0.7 ** (minor - 3))
}

export function variationFor(thematic, minor) {
  const t = chapterOf(minor)
  const along = ([from, to]) => from + (to - from) * t
  return {
    minor,
    chapter: thematic.chapters[minor] || `Chapter ${minor}`,
    t: round(t),
    gap: round(clamp(along(thematic.arc.gap), 1.1, 7), 3),
    warp: round(clamp(along(thematic.arc.warp), 0, 9), 3),
    lean: round(clamp(along(thematic.arc.lean), 0, 60), 3),
    spread: round(clamp(along(thematic.arc.spread), 0.04, 0.6), 3),
    reach: round(clamp(along(thematic.arc.reach), 0.4, 1.8), 3),
    breadth: round(clamp(along(thematic.arc.breadth), 0.12, 0.66), 3),
    beats: thematic.beats === 'chapter' ? clamp(minor, 1, 5) : 1,
  }
}

const THEME_WORDS = {
  hands: [
    'agent',
    'shared',
    'share',
    'tool',
    'lane',
    'delegat',
    'collaborat',
    'review',
    'mention',
    'repl',
    'orchestrat',
    'worker',
    'session',
    'connect',
    'token',
    'skill',
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
    'count',
    'hold',
    'lock',
    'fix',
    'settle',
    'remember',
  ],
  wayfinding: [
    'move',
    'split',
    'remove',
    'menu',
    'palette',
    'fold',
    'into',
    'rename',
    'own module',
    'lives on',
    'beside',
    'row',
    'drop',
    'leave',
  ],
  signals: [
    'progress',
    'job',
    'notif',
    'notice',
    'state',
    'live',
    'track',
    'stall',
    'alive',
    'icon',
    'tooltip',
    'idle',
    'panel',
    'one-read',
    'one read',
  ],
}

// ---------------------------------------------------------------- seeded numbers

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

function lattice(seed, i, j) {
  let hash = Math.imul(seed ^ Math.imul(i, 0x9e3779b1) ^ Math.imul(j, 0x85ebca6b), 0x27d4eb2d)
  hash ^= hash >>> 15
  hash = Math.imul(hash, 0x85ebca6b)
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35)
  hash ^= hash >>> 16
  return (hash >>> 0) / 4294967296
}

// Smooth value noise in [-1, 1], one cell every `scale` pixels.
function noise(seed, x, y, scale) {
  const fx = x / scale
  const fy = y / scale
  const i = Math.floor(fx)
  const j = Math.floor(fy)
  const s = smooth(fx - i)
  const t = smooth(fy - j)
  const a = lattice(seed, i, j)
  const b = lattice(seed, i + 1, j)
  const c = lattice(seed, i, j + 1)
  const d = lattice(seed, i + 1, j + 1)
  return (a + (b - a) * s + (c - a) * t + (a - b - c + d) * s * t) * 2 - 1
}

function smooth(t) {
  return t * t * (3 - 2 * t)
}

function smoothstep(low, high, value) {
  return smooth(clamp((value - low) / (high - low), 0, 1))
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

function lerp(a, b, t) {
  return a + (b - a) * t
}

function round(value, places = 3) {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
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
  // Only the change lines count: the links, authors and the changelog footer are not the release.
  const lines = notes
    .toLowerCase()
    .split('\n')
    .filter((line) => /^\s*[*+-]\s/.test(line))
    .map((line) => line.replace(/\s+by @\S+.*$/, '').replace(/https?:\/\/\S+/g, ''))
    .filter((line) => !/^\s*[*+-]\s+release\b/.test(line))
  const body = lines.join('\n')
  const items = lines.length || 1
  const scale = Math.sqrt(items)
  const saturate = (raw, knee) => 1 - Math.exp(-raw / knee)
  return {
    items,
    volume: clamp(Math.log(items) / Math.log(160), 0, 1),
    hands: saturate(countStems(body, THEME_WORDS.hands) / scale, 1.6),
    precision: saturate(countStems(body, THEME_WORDS.precision) / scale, 1.4),
    wayfinding: saturate(countStems(body, THEME_WORDS.wayfinding) / scale, 1.4),
    signals: saturate(countStems(body, THEME_WORDS.signals) / scale, 1.4),
  }
}

// ---------------------------------------------------------------- the plan

// The plan is everything the version and the notes decide; the drawing below only follows it.
export function planPiece(version, themes, seed) {
  const { major, minor, tag } = parseVersion(version)
  const thematic = thematicFor(major)
  const variation = variationFor(thematic, minor)
  const random = mulberry32(seed)
  const pick = (low, high) => lerp(low, high, random())
  const sign = () => (random() < 0.5 ? -1 : 1)
  const { hands, precision, wayfinding, signals, volume } = themes
  const upright = thematic.axis === 'upright'

  // A release is read for what it is mostly about: a theme speaks when it is strong and close to
  // the strongest one, and no more than two speak, so a sprawling release does not get every
  // gesture at once.
  const ranked = Object.entries({ hands, precision, wayfinding, signals }).sort((x, y) => y[1] - x[1])
  const speaks = new Set(
    ranked
      .filter(([, value], index) => index < 2 && value >= 0.5 && value >= ranked[0][1] - 0.15)
      .map(([key]) => key),
  )

  // Many hands, in a large release, bring a third ink; otherwise two.
  const screens = speaks.has('hands') && volume > 0.6 ? 3 : 2

  // How far the screens are turned from each other sets the fringe width: the chapter sets the
  // gap and precision closes it further.
  const baseAngle = pick(8, 34)
  // Never wider than 7°, so a fringe always spans at least eight dots and still reads at a third.
  const gap = clamp(lerp(variation.gap, Math.min(variation.gap, 1.3), precision) + pick(-0.3, 0.3), 1.1, 7)
  // Warp: how far a lattice is pushed off true, in pixels, up to what the chapter allows. Many
  // hands and a large release push it toward that; precision keeps it straight.
  const warp = round(variation.warp * (0.45 + 0.55 * (hands * 0.6 + volume * 0.4)) * (1 - precision * 0.7), 2)
  const warpScale = lerp(560, 320, volume)

  // Inks: the accent always prints, on one of the first two screens, with one of the style's
  // inks; a third screen takes the other.
  const seeded = random() < 0.5 ? [...STYLE_INKS] : [...STYLE_INKS].reverse()
  const style = thematic.pair ? [thematic.pair, ...STYLE_INKS.filter((ink) => ink !== thematic.pair)] : seeded
  const inks = random() < 0.5 ? [thematic.accent, ...style] : [style[0], thematic.accent, style[1]]

  const plates = []
  for (let s = 0; s < screens; s++) {
    plates.push({
      ink: inks[s],
      angle: round(baseAngle + gap * (s === 2 ? 2.4 : s), 2),
      pitch: round(PITCH * (1 + (s === 0 ? 0 : sign() * pick(0.004, 0.016) * (1 - precision * 0.6))), 3),
      origin: [round(pick(0, PITCH)), round(pick(0, PITCH))],
      warp: s === 0 ? 0 : round(warp * (s === 2 ? 0.7 : 1), 2),
      warpSeed: Math.floor(random() * 1e9),
    })
  }

  // The tone: each screen prints bands that run along the thematic's axis, their long sides a
  // halftone fade. The chapter sets how far they lean apart, how far they reach and how broad
  // they are; the notes push the lean: many hands open it, precision closes it.
  const axis = AXES[thematic.axis]
  const tilt = pick(axis.from, axis.to) * (axis.signed ? sign() : 1)
  const lean = variation.lean * (speaks.has('hands') ? 1.3 : 1) * (speaks.has('precision') ? 0.12 : 1)
  const narrow = speaks.has('wayfinding') ? 0.82 : 1
  const ragged = round(lerp(0.05, 0.18, hands * 0.5 + volume * 0.5) * (1 - precision * 0.6))
  const halfDiagonal = Math.hypot(WIDTH, HEIGHT) / 2
  const fields = []
  if (upright) {
    // Columns: the sheet is cut into one slot per beat, and in every slot the screens' columns
    // stand side by side, overlapping in the middle: one beat of fringes per slot.
    const slot = WIDTH / variation.beats
    const drift = pick(-0.08, 0.08) * slot
    const half = (slot / 2) * variation.breadth * narrow
    for (let s = 0; s < screens; s++) {
      const third = s === 2
      const offset = third ? 0 : [-1, 1][s] * half * variation.spread * pick(0.84, 1.12)
      const bands = []
      for (let k = 0; k < variation.beats; k++) {
        bands.push({
          angle: round(tilt + pick(-0.6, 0.6), 2),
          x: round(slot * (k + 0.5) + drift + offset),
          y: round(HEIGHT * (0.5 + pick(-0.05, 0.05))),
          half: round(half * (third ? 0.55 : 1)),
          length: round(halfDiagonal * variation.reach),
        })
      }
      fields.push({
        bands,
        tone: round(pick(0.42, 0.52) * (third ? 0.72 : 1)),
        ragged,
        raggedSeed: Math.floor(random() * 1e9),
      })
    }
  } else {
    for (let s = 0; s < screens; s++) {
      const offset = screens === 2 ? [-1, 1][s] : [-1, 0.15, 1][s]
      const turn = screens === 2 ? offset * 0.5 : [-0.5, 0.5, -0.05][s]
      fields.push({
        bands: [
          {
            angle: round(tilt + lean * turn, 2),
            x: round(WIDTH * (0.5 + pick(-0.12, 0.12))),
            y: round(HEIGHT * (0.5 + offset * variation.spread * pick(0.85, 1.25))),
            half: round(HEIGHT * variation.breadth * pick(0.88, 1.12) * narrow),
            length: round(halfDiagonal * variation.reach * pick(0.9, 1.1)),
          },
        ],
        // A third ink prints lighter, so three inks over one another stay inks and not mud.
        tone: round(pick(0.4, 0.52) * (s === 2 ? 0.72 : 1)),
        ragged,
        raggedSeed: Math.floor(random() * 1e9),
      })
    }
  }

  // A held edge. Earned by precision in a loose thematic: one screen stops dead on a straight line
  // across the sheet. In a thematic that always holds, one column of the first screen is cut down
  // its middle, so one of its sides is a hard edge; precision cuts a second screen's column too.
  const edge =
    thematic.hold === 'earned' && speaks.has('precision')
      ? {
          screen: Math.floor(random() * screens),
          vertical: random() < 0.6,
          ...(random() < 0.5
            ? { at: round(pick(0.3, 0.45)), keep: 'after' }
            : { at: round(pick(0.55, 0.7)), keep: 'before' }),
        }
      : null
  const holds = []
  if (thematic.hold === 'always') {
    const count = speaks.has('precision') ? 2 : 1
    for (let h = 0; h < count; h++) {
      holds.push({
        screen: h,
        band: (Math.floor(random() * variation.beats) + h) % variation.beats,
        // The outer side of the column, away from the overlap, so the beat between the screens
        // stays whole and the column's outside edge is ruled.
        side: h === 0 ? 1 : -1,
      })
    }
  }

  // Wayfinding clears a lane of paper through the sheet and, across it, shifts the screens a
  // half dot out of phase, so the fringes break and pick up again somewhere else. A thematic in
  // register keeps the lane upright.
  const lane = speaks.has('wayfinding')
    ? {
        at: round(pick(0.36, 0.62)),
        slope: round(upright ? pick(-0.03, 0.03) : pick(-0.28, 0.28)),
        width: round(lerp(40, 90, wayfinding)),
        shift: round(PITCH * 0.5),
      }
    : null

  // Signals grade a screen: its tone climbs steadily across the sheet, along the bands' run in a
  // thematic that stands upright, across them otherwise.
  const ramp = speaks.has('signals')
    ? {
        screen: screens - 1,
        from: upright ? (random() < 0.5 ? 'top' : 'bottom') : random() < 0.5 ? 'left' : 'right',
        floor: round(lerp(0.25, 0.05, signals)),
      }
    : null

  // Ink mottle: the press lays some areas a little heavier, at a scale far above the dots.
  const mottle = { scale: round(pick(220, 340)), strength: round(lerp(0.06, 0.12, volume)) }

  return {
    version: tag,
    seed,
    thematic: {
      major,
      name: thematic.name,
      axis: thematic.axis,
      accent: thematic.accent,
      derived: thematic.derived,
    },
    variation,
    speaks: [...speaks].sort(),
    screens,
    plates,
    fields,
    edge,
    holds,
    lane,
    ramp,
    warpScale: round(warpScale),
    mottle,
  }
}

// ---------------------------------------------------------------- tone and lattice

function fieldTone(plan, s, x, y) {
  const field = plan.fields[s]
  const wobble =
    noise(field.raggedSeed, x, y, 170) * field.ragged +
    noise(field.raggedSeed + 7, x, y, 55) * field.ragged * 0.35
  let shape = 0
  field.bands.forEach((band, b) => {
    const angle = (band.angle * Math.PI) / 180
    const dx = x - band.x
    const dy = y - band.y
    const signedAcross = -dx * Math.sin(angle) + dy * Math.cos(angle)
    for (const hold of plan.holds) {
      if (hold.screen === s && hold.band === b && signedAcross * hold.side > 0) return
    }
    const across = Math.abs(signedAcross) / band.half
    const along = Math.abs(dx * Math.cos(angle) + dy * Math.sin(angle)) / band.length
    const value =
      (1 - smoothstep(0.45, 1.05, across + wobble)) * (1 - smoothstep(0.62, 1, along + wobble * 0.5))
    shape = Math.max(shape, value)
  })
  let tone = shape * field.tone

  if (plan.edge && plan.edge.screen === s) {
    const t = plan.edge.vertical ? x / WIDTH : y / HEIGHT
    const before = t < plan.edge.at
    if (before !== (plan.edge.keep === 'before')) tone = 0
  }
  if (plan.ramp && plan.ramp.screen === s) {
    const across = { left: x / WIDTH, right: 1 - x / WIDTH, top: y / HEIGHT, bottom: 1 - y / HEIGHT }
    tone *= lerp(plan.ramp.floor, 1, smoothstep(0.08, 0.92, across[plan.ramp.from]))
  }
  if (plan.lane) {
    const d = laneDistance(plan.lane, x, y)
    tone *= smoothstep(plan.lane.width * 0.5, plan.lane.width * 0.5 + 70, Math.abs(d))
  }
  const mottle = 1 + noise(plan.seed ^ 0x5bd1e995, x, y, plan.mottle.scale) * plan.mottle.strength
  return clamp(tone * mottle, 0, MAX_TONE)
}

// Signed distance (in pixels, roughly) from the lane's centre line, which runs top to bottom.
function laneDistance(lane, x, y) {
  const cx = WIDTH * lane.at + (y - HEIGHT / 2) * lane.slope
  return (x - cx) / Math.sqrt(1 + lane.slope * lane.slope)
}

function dotsFor(plan, s) {
  const plate = plan.plates[s]
  const angle = (plate.angle * Math.PI) / 180
  const ux = Math.cos(angle) * plate.pitch
  const uy = Math.sin(angle) * plate.pitch
  const vx = -uy
  const vy = ux
  const reach = Math.ceil(Math.hypot(WIDTH, HEIGHT) / plate.pitch) + 2
  const cx = WIDTH / 2 + plate.origin[0]
  const cy = HEIGHT / 2 + plate.origin[1]
  const dots = []
  for (let j = -reach; j <= reach; j++) {
    for (let i = -reach; i <= reach; i++) {
      let x = cx + i * ux + j * vx
      let y = cy + i * uy + j * vy
      if (x < -12 || x > WIDTH + 12 || y < -12 || y > HEIGHT + 12) continue
      if (plate.warp) {
        x += noise(plate.warpSeed, x, y, plan.warpScale) * plate.warp
        y += noise(plate.warpSeed + 1, x, y, plan.warpScale) * plate.warp
      }
      if (plan.lane && s > 0 && laneDistance(plan.lane, x, y) > 0) {
        x += plan.lane.shift * Math.cos(angle + 0.7)
        y += plan.lane.shift * Math.sin(angle + 0.7)
      }
      const tone = fieldTone(plan, s, x, y)
      if (tone <= 0.012) continue
      // Dot gain: each dot comes out a little heavier or lighter than its tone asks.
      const gain = 1 + (lattice(plate.warpSeed ^ 0x2545f491, i, j) - 0.5) * 0.16
      const radius = 0.5 * plate.pitch * Math.sqrt(tone) * 1.06 * gain
      if (radius < MIN_RADIUS) continue
      dots.push({ x, y, radius })
    }
  }
  return dots
}

// One path per dot size: each dot is a zero-length segment with a round cap, so the stroke width
// is the dot's diameter and a dot costs a relative move and "h0".
function platePaths(dots) {
  const buckets = new Map()
  for (const dot of dots) {
    const size = Math.max(1, Math.round(dot.radius / RADIUS_STEP))
    if (!buckets.has(size)) buckets.set(size, [])
    buckets.get(size).push(dot)
  }
  const sizes = [...buckets.keys()].sort((a, b) => a - b)
  return sizes.map((size) => {
    let px = 0
    let py = 0
    let d = ''
    for (const dot of buckets.get(size)) {
      const x = Math.round(dot.x * UNIT)
      const y = Math.round(dot.y * UNIT)
      d += d === '' ? `M${x} ${y}h0` : `m${x - px}${signed(y - py)}h0`
      px = x
      py = y
    }
    const width = Math.round(size * RADIUS_STEP * 2 * UNIT)
    return `<path stroke-width="${width}" d="${d}"/>`
  })
}

function signed(value) {
  return value < 0 ? `${value}` : ` ${value}`
}

// ---------------------------------------------------------------- the sheet

export function renderPiece(plan, variant) {
  const palette = PALETTE[variant]
  const plates = plan.plates.map((plate, s) => {
    const dots = dotsFor(plan, s)
    return { plate, dots, paths: platePaths(dots) }
  })
  const id = (name) => `${name}-${variant}`
  const layers = plates
    .map(
      ({ plate, paths }) =>
        `<g filter="url(#${id('gain')})" style="mix-blend-mode:${palette.blend}"><g transform="scale(${1 / UNIT})" fill="none" stroke="${palette.inks[plate.ink]}" stroke-linecap="round">${paths.join('')}</g></g>`,
    )
    .join('\n')
  const turn = (plan.seed % 997) / 997
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-labelledby="${id('title')} ${id('desc')}">`,
    `<title id="${id('title')}">Release artwork ${plan.version}, ${variant}</title>`,
    `<desc id="${id('desc')}">${plan.screens} halftone screens at slightly different angles, printed over one another; their moiré fringes are the image. ${plan.thematic.name}, ${plan.variation.chapter}.</desc>`,
    '<defs>',
    // Dot gain: the dot edges are pushed about by a fine noise, as ink spreads into paper.
    `<filter id="${id('gain')}" x="0" y="0" width="100%" height="100%" filterUnits="userSpaceOnUse"><feTurbulence type="fractalNoise" baseFrequency="0.42" numOctaves="2" seed="${(plan.seed % 89) + 1}"/><feDisplacementMap in="SourceGraphic" scale="2.4" xChannelSelector="R" yChannelSelector="G"/></filter>`,
    // Paper tooth: a fine speckle over the whole sheet, inks and paper alike.
    `<filter id="${id('tooth')}" x="0" y="0" width="100%" height="100%" filterUnits="userSpaceOnUse"><feTurbulence type="fractalNoise" baseFrequency="${round(0.78 + turn * 0.1)}" numOctaves="3" seed="${(plan.seed % 61) + 3}"/><feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -2.4 1.45" result="speck"/><feComposite operator="in" in="SourceGraphic" in2="speck"/></filter>`,
    '</defs>',
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${palette.ground}"/>`,
    layers,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${palette.grain}" opacity="${palette.grainOpacity}" filter="url(#${id('tooth')})"/>`,
    '</svg>',
    '',
  ].join('\n')
  return { svg, stats: { dots: plates.map((p) => p.dots.length) } }
}

// ---------------------------------------------------------------- command line

function parseArgs(argv) {
  const args = {}
  const take = (index, flag) => {
    const value = argv[index]
    if (value === undefined || value === '') throw new Error(`${flag} needs a value`)
    return value
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--out') args.out = take(++i, flag)
    else if (flag === '--version') args.version = take(++i, flag)
    else if (flag === '--notes') args.notes = take(++i, flag)
    else throw new Error(`Unknown argument: ${flag}`)
  }
  if (Boolean(args.version) !== Boolean(args.notes)) throw new Error('--version and --notes go together')
  return args
}

// Notes written for the artwork, for a version with no published release, say so in their
// first line; the manifest carries the mark.
export function isStandIn(notes) {
  return /^>\s*\*\*Stand-in notes\.\*\*/.test(notes)
}

function notesFiles() {
  return readdirSync(NOTES_DIR)
    .filter((file) => /^v\d+\.\d+\.\d+\.md$/.test(file))
    .sort((a, b) => {
      const pa = a.slice(1, -3).split('.').map(Number)
      const pb = b.slice(1, -3).split('.').map(Number)
      return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2]
    })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const outDir = args.out ? resolve(args.out) : ASSET_DIR
  const jobs = args.version
    ? [{ version: parseVersion(args.version).tag, file: resolve(args.notes) }]
    : notesFiles().map((file) => ({ version: file.replace(/\.md$/, ''), file: join(NOTES_DIR, file) }))

  mkdirSync(outDir, { recursive: true })
  const releases = []

  for (const job of jobs) {
    const notes = readFileSync(job.file, 'utf8')
    const version = job.version
    const seed = hashString(`${DIRECTION}/${version}`)
    const themes = readThemes(notes)
    const plan = planPiece(version, themes, seed)
    const files = {}
    for (const variant of ['dark', 'light']) {
      const { svg, stats } = renderPiece(plan, variant)
      const name = `${version}-${variant}.svg`
      writeFileSync(join(outDir, name), svg)
      files[variant] = name
      console.log(`${version} ${variant}: ${Buffer.byteLength(svg)} bytes, dots ${stats.dots.join(' + ')}`)
    }
    releases.push({
      version,
      seed,
      notes: job.file.startsWith(NOTES_DIR) ? `scripts/release-art/notes/${version}.md` : job.file,
      standIn: isStandIn(notes),
      thematic: plan.thematic.name,
      chapter: plan.variation.chapter,
      themes: Object.fromEntries(
        Object.entries(themes).map(([key, value]) => [key, key === 'items' ? value : round(value)]),
      ),
      speaks: plan.speaks,
      screens: plan.plates.map((plate) => ({
        ink: plate.ink,
        angle: plate.angle,
        pitch: plate.pitch,
        warp: plate.warp,
      })),
      edge: plan.edge,
      holds: plan.holds,
      lane: plan.lane,
      ramp: plan.ramp,
      files,
    })
  }

  if (args.version) {
    // One release at a time is for trying a piece out: the series manifest is left as it was.
    console.log(`Wrote ${releases.length * 2} pieces to ${outDir} (manifest.json left as it was)`)
    return
  }

  const manifest = {
    direction: DIRECTION,
    generator: `scripts/release-art/${DIRECTION}.mjs`,
    madeBy: 'Claude Opus 5.5 (medium effort)',
    canvas: { width: WIDTH, height: HEIGHT },
    palette: PALETTE,
    screen: { pitch: PITCH, maxTone: MAX_TONE, minRadius: MIN_RADIUS, thirdScalePitch: round(PITCH / 3) },
    styleInks: STYLE_INKS,
    thematics: [...new Set(releases.map((release) => parseVersion(release.version).major))].map((major) => {
      const thematic = thematicFor(major)
      const minors = releases
        .map((release) => parseVersion(release.version))
        .filter((parsed) => parsed.major === major)
        .map((parsed) => parsed.minor)
      return {
        major,
        name: thematic.name,
        meaning: thematic.meaning,
        derived: thematic.derived,
        axis: thematic.axis,
        accent: thematic.accent,
        arc: thematic.arc,
        beats: thematic.beats,
        hold: thematic.hold,
        variations: [...new Set(minors)].map((minor) => variationFor(thematic, minor)),
      }
    }),
    releases,
  }
  // Written the way the repo's formatter writes JSON, so the committed manifest passes its check.
  const { format } = await import('prettier')
  writeFileSync(join(outDir, 'manifest.json'), await format(JSON.stringify(manifest), { parser: 'json' }))
  console.log(`Wrote ${releases.length * 2} pieces and manifest.json to ${outDir}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`${DIRECTION}: ${error.message}`)
    process.exitCode = 1
  })
}
