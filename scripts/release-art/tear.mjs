#!/usr/bin/env node
// Release artwork: tear.
//
// A hand-torn paper collage. A few large sheets of dyed paper are torn by hand and laid over one
// another on a paper or ink ground: flat, opaque colour, no gradients, no drawn lines. The print
// artifact is the tear itself: a torn edge wanders, and along parts of it the dye layer has peeled
// back from the sheet's pale core, which shows as a feathered fringe. A cut edge (the side of the
// sheet as it came from the mill) stays straight, so every piece sets ruled edges against torn
// ones. Each sheet casts a thin shadow, loose fibres lie on top, and a coarse grain sits over all.
//
// The version says what the piece means, on three levels below the style (which never changes):
//   major -> the thematic: a grammar for laying the sheets and a pair of dyes
//              0.x  Loose:   sheets lie at any angle, from any side, the table shows between them
//              1.x  Coursed: every sheet follows one axis, in parallel courses, the ground covered
//   minor -> the variation: the pale dye is dyed one bath deeper, and the lay turns one step
//   patch -> the piece: the release's notes pick the lay and the seed sets the rest
// A later major takes the next grammar and the next pair of dyes from two lists (thematicFor).
//
// The release's notes are read for four themes and the strongest one picks how the sheets are laid:
//   many hands  -> gather: slabs come in from every side and pile up off-centre
//   precision   -> hold:   three sheets fitted along even seams, a small tab across the joint
//   wayfinding  -> clear:  one sheet torn in two and pulled apart, the ground left open between
//   pulse       -> run:    one strip torn into pieces that drift apart along a line
// The other themes and the version's seed set every remaining choice (how many sheets, how rough
// the tear, the tilt, where the one accent scrap lies), so the same version and notes write the
// same bytes every run. A release nobody has seen needs only its notes file.
//
// Usage:
//   node scripts/release-art/tear.mjs                      # regenerate the committed series
//   node scripts/release-art/tear.mjs --out /tmp/art       # write somewhere else
//   node scripts/release-art/tear.mjs --version v0.3.0 \
//     --notes scripts/release-art/notes/v0.3.0.md --out /tmp/art
//
// To make the next release's piece:
//   gh release view vX.Y.Z --json body --jq .body > scripts/release-art/notes/vX.Y.Z.md
//   node scripts/release-art/tear.mjs

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const NOTES_DIR = join(ROOT, 'scripts/release-art/notes')
const ASSET_DIR = join(ROOT, 'src/assets/release-art/tear')

const clamp = (value, low, high) => Math.min(high, Math.max(low, value))

const WIDTH = 1600
const HEIGHT = 900
const STEP = 6 // distance between two points of a torn edge
const FAR = 520 // how far past the canvas a sheet runs before it ends
const MARGIN = 36 // points further out than this are dropped from the path

// The palette is fixed by the direction: a bone paper, a plum-black ink, two dyes (plum and
// celadon), one accent (saffron) and the undyed core that a tear exposes. The dark piece lays the
// same dyes on ink: the plum is lit so that it stands off the ground, the celadon is deepened.
export const PALETTE = {
  bone: '#E9E2D4',
  ink: '#1D1924',
  plum: '#3F3152',
  plumLit: '#63517F',
  celadon: '#9CB7A6',
  celadonDeep: '#638A79',
  saffron: '#E0A132',
  core: '#FCF9F1',
  madder: '#7B2D34',
  madderLit: '#A5494E',
  slate: '#9FB2C8',
  slateDeep: '#5F7A9A',
  indigo: '#2B3A67',
  indigoLit: '#5468A6',
  shell: '#D8AFA3',
  shellDeep: '#A87868',
}

// ---------------------------------------------------------------- the version's meaning

// The grammars, in order: how a thematic lays its sheets. `ground` is how much of the table it
// leaves bare, `axis` whether the sheets share one direction, `step` how far one minor turns it.
export const GRAMMARS = [
  { key: 'loose', axis: 'free', ground: 'open', bearing: 0, step: 7 },
  { key: 'coursed', axis: 'one', ground: 'covered', bearing: 26, step: 7 },
]

// The dye shelf, in order: a deep dye that anchors the thematic and a pale one that the minor
// re-dyes. Each is given for the light piece and for the dark piece.
export const DYES = [
  {
    key: 'plum and celadon',
    deep: { light: PALETTE.plum, dark: PALETTE.plumLit },
    pale: { light: PALETTE.celadon, dark: PALETTE.celadonDeep },
  },
  {
    key: 'madder and slate',
    deep: { light: PALETTE.madder, dark: PALETTE.madderLit },
    pale: { light: PALETTE.slate, dark: PALETTE.slateDeep },
  },
  {
    key: 'indigo and shell',
    deep: { light: PALETTE.indigo, dark: PALETTE.indigoLit },
    pale: { light: PALETTE.shell, dark: PALETTE.shellDeep },
  },
]

// What a major means, in words. A major with no entry still gets its form from the two lists.
const MEANINGS = {
  0: {
    name: 'Loose',
    meaning:
      'Before 1.0 the product is still finding its shape. Nothing is fixed: the sheets lie loose on the table, at any angle, and the table shows between them.',
  },
  1: {
    name: 'Coursed',
    meaning:
      'The first version people rely on. The sheets have found their places: all follow one axis and lie in courses, edge over edge, and the ground is covered.',
  },
}

// The bath ladder: how far the pale dye's lightness moves from its reference shade, in points of
// HSL lightness, for the light piece and the dark piece. Rung 2 is the reference.
const BATHS = { light: [17, 10, 0, -12, -22, -30], dark: [14, 8, 0, -8, -14, -19] }
const BATH_CYCLE = [0, 1, 2, 3, 4, 5, 4, 3, 2, 1]
const TURN_CYCLE = [-2, -1, 0, 1, 2]

export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(text).trim())
  if (!match) throw new Error(`Not a version: ${text} (expected vMAJOR.MINOR.PATCH)`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ?? '',
  }
}

function shade(hex, points) {
  if (points === 0) return hex
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const span = max - min
  let l = (max + min) / 2
  const sat = span === 0 ? 0 : span / (1 - Math.abs(2 * l - 1))
  let hue = 0
  if (span !== 0) {
    if (max === r) hue = ((g - b) / span + 6) % 6
    else if (max === g) hue = (b - r) / span + 2
    else hue = (r - g) / span + 4
  }
  l = clamp(l + points / 100, 0.08, 0.92)
  const chroma = (1 - Math.abs(2 * l - 1)) * sat
  const x = chroma * (1 - Math.abs((hue % 2) - 1))
  const [r1, g1, b1] = [
    [chroma, x, 0],
    [x, chroma, 0],
    [0, chroma, x],
    [0, x, chroma],
    [x, 0, chroma],
    [chroma, 0, x],
  ][Math.floor(hue) % 6]
  const m = l - chroma / 2
  return `#${[r1, g1, b1]
    .map((v) =>
      Math.round((v + m) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase()}`
}

// The thematic of a major: its grammar, its dyes and what it means.
export function thematicFor(major) {
  const grammar = GRAMMARS[major % GRAMMARS.length]
  const dyes = DYES[major % DYES.length]
  const words = MEANINGS[major] ?? {
    name: `${grammar.key[0].toUpperCase()}${grammar.key.slice(1)}, ${dyes.key}`,
    meaning: '',
  }
  return {
    major,
    name: words.name,
    meaning: words.meaning,
    grammar: grammar.key,
    axis: grammar.axis,
    ground: grammar.ground,
    dyes: dyes.key,
    deep: dyes.deep,
    pale: dyes.pale,
    accent: PALETTE.saffron,
  }
}

// The variation of a minor inside its major: which bath the pale dye is in and where the lay
// points. Ten minors pass before one pair of the two comes back.
export function variationFor(major, minor) {
  const grammar = GRAMMARS[major % GRAMMARS.length]
  const dyes = DYES[major % DYES.length]
  const bath = BATH_CYCLE[minor % BATH_CYCLE.length]
  const turn = TURN_CYCLE[minor % TURN_CYCLE.length]
  return {
    minor,
    bath,
    turn,
    bearing: grammar.bearing + turn * grammar.step,
    pale: {
      light: shade(dyes.pale.light, BATHS.light[bath]),
      dark: shade(dyes.pale.dark, BATHS.dark[bath]),
    },
  }
}

// Every colour a piece may hold: the palette and each rung of each pale dye's ladder.
export const PALETTE_HEXES = [
  ...new Set([
    ...Object.values(PALETTE),
    ...DYES.flatMap((dyes) =>
      BATHS.light.flatMap((_, bath) => [
        shade(dyes.pale.light, BATHS.light[bath]),
        shade(dyes.pale.dark, BATHS.dark[bath]),
      ]),
    ),
  ]),
]

const VARIANTS = {
  light: {
    ground: PALETTE.bone,
    core: PALETTE.core,
    shadowOpacity: 0.3,
    grainBlend: 'multiply',
    grainOpacity: 0.2,
    mottleOpacity: 0.1,
    fibreLight: 0.34,
    fibreDark: 0.2,
  },
  dark: {
    ground: PALETTE.ink,
    core: PALETTE.core,
    shadowOpacity: 0.6,
    grainBlend: 'multiply',
    grainOpacity: 0.24,
    mottleOpacity: 0.12,
    fibreLight: 0.2,
    fibreDark: 0.3,
  },
}

// Word stems, matched at the start of a word in each line of the notes.
const THEME_WORDS = {
  hands: [
    'agent',
    'shar',
    'tool',
    'lane',
    'delegat',
    'collaborat',
    'repl',
    'review',
    'forum',
    'mention',
    'thread',
    'human',
    'verdict',
    'persona',
    'together',
  ],
  precision: [
    'focus',
    'ring',
    'cache',
    'safe',
    'sticky',
    'proxy',
    'clock',
    'cap',
    'exact',
    'warm',
    'hold',
    'fallback',
    'fit',
    'guard',
    'websocket',
    'pin',
  ],
  wayfinding: [
    'move',
    'split',
    'remove',
    'menu',
    'palette',
    'rename',
    'fold',
    'clutter',
    'reorganiz',
    'resume',
    'instructions',
    'window',
    'search',
  ],
  pulse: [
    'progress',
    'job',
    'notif',
    'state',
    'track',
    'live',
    'alive',
    'stall',
    'speed',
    'retry',
    'wait',
    'idle',
    'run',
    'timing',
    'long',
    'start',
    'stop',
    'restart',
    'check',
  ],
}
const THEMES = Object.keys(THEME_WORDS)
const STAND_IN = /^<!--\s*stand-in\b/i
const LAYS = { hands: 'gather', precision: 'hold', wayfinding: 'clear', pulse: 'run' }

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

export function seedFor(version) {
  return hashString(`tear:${version}`)
}

// Value noise on a line, in [-1, 1]: the same key and position always give the same value.
function lattice(key, index) {
  let h = Math.imul(key ^ Math.imul(index, 0x9e3779b1), 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 2147483648 - 1
}

function noise(key, x) {
  const i = Math.floor(x)
  const f = x - i
  const u = f * f * (3 - 2 * f)
  return lattice(key, i) * (1 - u) + lattice(key, i + 1) * u
}

const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
const round = (value, digits = 3) => Number(value.toFixed(digits))
const radians = (degrees) => (degrees * Math.PI) / 180

// ---------------------------------------------------------------- reading the notes

export function readThemes(notes) {
  const lines = notes
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^([*-]|#{1,6})\s+\S/.test(line))
    .map((line) =>
      line
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/\bby @\S+/g, ' ')
        .toLowerCase(),
    )
    .filter((line) => !/^#+\s+(what's changed|new contributors)/.test(line))
  // An empty or prose-only body (a failed `gh release view` leaves one) has nothing to read a
  // release by: refuse it rather than draw a piece as if it were a many-hands release.
  if (lines.length === 0) throw new Error('No theme lines in the notes: expected bullets or headings')
  const total = lines.length
  const share = {}
  for (const theme of THEMES) {
    const pattern = new RegExp(`\\b(${THEME_WORDS[theme].join('|')})`)
    share[theme] = lines.filter((line) => pattern.test(line)).length / total
  }
  // A theme's strength is its share of the lines against the strongest theme's share: what the
  // release is mostly about reads 1, a theme it barely touches reads near 0.
  const top = Math.max(...THEMES.map((theme) => share[theme]), 1e-9)
  const themes = { lines: lines.length, density: clamp(lines.length / 36, 0, 1) }
  for (const theme of THEMES) themes[theme] = share[theme] / top
  themes.lead = THEMES.reduce((best, theme) => (share[theme] > share[best] ? theme : best), THEMES[0])
  return themes
}

// ---------------------------------------------------------------- the plan: which sheets, where

// A sheet is a list of edges, bottom-most sheet first. An edge is a polyline (two points for a
// straight side) that is either cut (left as it is) or torn (displaced by the tear's noise). Two
// sheets torn from one another share an edge's key, so their edges still fit.
function edge(points, kind, key, options = {}) {
  return { points, kind, key, amp: 1, core: 1, sway: 0, reverse: false, ...options }
}

function rotateAbout(point, centre, angle) {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dx = point[0] - centre[0]
  const dy = point[1] - centre[1]
  return [centre[0] + dx * cos - dy * sin, centre[1] + dx * sin + dy * cos]
}

// A four-sided sheet from its corners, in order; `kinds` says which sides are torn.
function quad(role, corners, kinds, key, options = {}) {
  return {
    role,
    edges: corners.map((corner, i) =>
      edge([corner, corners[(i + 1) % corners.length]], kinds[i], key + i * 101, options),
    ),
  }
}

// A slab that comes in from outside the canvas along `angle` and ends at `tip`.
function slab(role, tip, angle, width, key, rng, options = {}) {
  const along = [Math.cos(angle), Math.sin(angle)]
  const across = [-along[1], along[0]]
  const skew = (rng() - 0.5) * width * 0.5
  const length = WIDTH + FAR * 2
  const corner = (a, b, s = 0) => [
    tip[0] + along[0] * (a + s) + across[0] * b,
    tip[1] + along[1] * (a + s) + across[1] * b,
  ]
  const half = width / 2
  const cutSide = rng() < 0.5
  return quad(
    role,
    [corner(0, -half, skew), corner(0, half, -skew), corner(-length, half), corner(-length, -half)],
    ['torn', cutSide ? 'cut' : 'torn', 'cut', cutSide ? 'torn' : 'cut'],
    key,
    options,
  )
}

// A small scrap: the accent. One side is cut, the rest are torn.
function scrap(role, centre, angle, width, height, key, options = {}) {
  const corners = [
    [-width / 2, -height / 2],
    [width / 2, -height / 2 + height * 0.08],
    [width / 2 - width * 0.06, height / 2],
    [-width / 2 + width * 0.04, height / 2 - height * 0.05],
  ].map(([x, y]) => rotateAbout([centre[0] + x, centre[1] + y], centre, angle))
  return quad(role, corners, ['cut', 'torn', 'torn', 'torn'], key, { amp: 0.45, core: 0.7, ...options })
}

function layGather(plan, rng) {
  const { themes } = plan
  const count = clamp(Math.round(4 + themes.density * 2.4 + themes.pulse * 1.2 - themes.precision), 5, 7)
  const focus = [WIDTH * (0.56 + (rng() - 0.5) * 0.16), HEIGHT * (0.5 + (rng() - 0.5) * 0.12)]
  // The slabs come in from the four sides in turn. None is aimed at the focus itself: each passes
  // it to one side, so the pile reads as laid, not as spokes.
  const turn = Math.floor(rng() * 4)
  const sheets = []
  for (let i = 0; i < count; i++) {
    const side = (turn + i * (i % 2 === 0 ? 1 : 3) + (i >> 1)) % 4
    const angle = radians(side * 90 + (rng() - 0.5) * 56)
    const along = [Math.cos(angle), Math.sin(angle)]
    const across = [-along[1], along[0]]
    const width = 270 + rng() * 250
    const offset = (i % 2 === 0 ? 1 : -1) * (width * 0.3 + rng() * 170)
    const reach = -210 + rng() * 380
    const tip = [
      focus[0] + across[0] * offset + along[0] * reach,
      focus[1] + across[1] * offset + along[1] * reach,
    ]
    sheets.push(slab(i % 2 === 0 ? 'b' : 'a', tip, angle, width, plan.seed + i * 7919, rng))
  }
  const accentAngle = radians((rng() - 0.5) * 50)
  const accentAt = [focus[0] + (rng() - 0.5) * 120, focus[1] + (rng() - 0.5) * 90]
  sheets.push(scrap('accent', accentAt, accentAngle, 150, 84, plan.seed + 31))
  plan.lay = { name: 'gather', sheets: count, focus: focus.map((v) => round(v, 1)) }
  plan.accent = accentAt.map((v) => round(v, 1))
  return sheets
}

function layHold(plan, rng) {
  const tilt = radians((rng() < 0.5 ? -1 : 1) * (2 + rng() * 2.6))
  const centre = [WIDTH / 2, HEIGHT / 2]
  const turn = (point) => rotateAbout(point, centre, tilt)
  const seam = 15 + rng() * 5
  const band = 58 + rng() * 34
  const joint = WIDTH * (0.5 + rng() * 0.13)
  const shelf = HEIGHT * (0.34 + rng() * 0.1)
  const calm = { amp: 0.42, core: 0.8 }
  const key = plan.seed
  const sheets = [
    quad(
      'a',
      [
        [-FAR, -FAR],
        [joint, -FAR],
        [joint, HEIGHT + FAR],
        [-FAR, HEIGHT + FAR],
      ].map(turn),
      ['cut', 'torn', 'cut', 'cut'],
      key,
      calm,
    ),
    quad(
      'b',
      [
        [joint + seam, shelf],
        [WIDTH + FAR, shelf],
        [WIDTH + FAR, HEIGHT + FAR],
        [joint + seam, HEIGHT + FAR],
      ].map(turn),
      ['torn', 'cut', 'cut', 'torn'],
      key + 977,
      calm,
    ),
    quad(
      'a',
      [
        [joint + seam + WIDTH * 0.11, -FAR],
        [WIDTH + FAR, -FAR],
        [WIDTH + FAR, shelf - band],
        [joint + seam + WIDTH * 0.11, shelf - band],
      ].map(turn),
      ['cut', 'cut', 'cut', 'torn'],
      key + 1931,
      calm,
    ),
  ]
  const accentAt = turn([joint + seam / 2 + 6, shelf + HEIGHT * (0.2 + rng() * 0.16)])
  sheets.push(scrap('accent', accentAt, tilt + radians((rng() - 0.5) * 3), 128, 56, key + 31, { amp: 0.3 }))
  plan.lay = {
    name: 'hold',
    sheets: 3,
    tilt: round((tilt * 180) / Math.PI, 2),
    joint: round(joint, 1),
    shelf: round(shelf, 1),
    seam: round(seam, 1),
  }
  plan.accent = accentAt.map((v) => round(v, 1))
  return sheets
}

function bezier(p0, p1, p2, p3, count) {
  const points = []
  for (let i = 0; i <= count; i++) {
    const t = i / count
    const u = 1 - t
    points.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ])
  }
  return points
}

function layClear(plan, rng) {
  const rising = rng() < 0.5
  const y0 = HEIGHT * (rising ? 0.8 + rng() * 0.1 : 0.1 + rng() * 0.1)
  const y1 = HEIGHT * (rising ? 0.12 + rng() * 0.12 : 0.8 + rng() * 0.1)
  const bend = (rng() - 0.5) * 220
  const start = [-FAR, y0 + (y0 - y1) * (FAR / WIDTH)]
  const end = [WIDTH + FAR, y1 - (y0 - y1) * (FAR / WIDTH)]
  const line = bezier(
    start,
    [WIDTH * 0.3, y0 + (y1 - y0) * 0.3 + bend],
    [WIDTH * 0.7, y0 + (y1 - y0) * 0.7 - bend * 0.6],
    end,
    48,
  )
  const chord = Math.atan2(end[1] - start[1], end[0] - start[0])
  const normal = [Math.sin(chord), -Math.cos(chord)] // points to the upper side of the tear
  // The sheet was torn from one end and opened like a hinge: the gap is narrow where the two
  // halves still nearly touch and wide where they were pulled furthest.
  const narrow = 70 + rng() * 40
  const opening = radians(9 + rng() * 3 + plan.themes.wayfinding * 2)
  const hingeLeft = rng() < 0.5
  const hinge = hingeLeft
    ? [-140, start[1] + (end[1] - start[1]) * 0.17]
    : [WIDTH + 140, end[1] - (end[1] - start[1]) * 0.17]
  const shift = (points, distance) =>
    points.map(([x, y]) => [x + normal[0] * distance, y + normal[1] * distance])
  const key = plan.seed
  const upper = shift(line, narrow).map((point) => rotateAbout(point, hinge, hingeLeft ? -opening : opening))
  const lower = line
  // The sheet under the lower half shows past its torn edge, by a width that changes along it.
  const underTurn = radians((hingeLeft ? -1 : 1) * (2.2 + rng() * 1.4))
  const under = shift(line, 26 + rng() * 14).map((point) => rotateAbout(point, hinge, underTurn))
  const farUp = rising ? [-FAR, -FAR * 2] : [WIDTH + FAR, -FAR * 2]
  const farDown = rising ? [WIDTH + FAR, HEIGHT + FAR * 2] : [-FAR, HEIGHT + FAR * 2]
  const closeUp = [edge([upper.at(-1), farUp], 'cut', key + 1), edge([farUp, upper[0]], 'cut', key + 2)]
  const closeDown = (points) => [
    edge([points.at(-1), farDown], 'cut', key + 3),
    edge([farDown, points[0]], 'cut', key + 4),
  ]
  const sheets = [
    { role: 'a', edges: [edge(under, 'torn', key + 555, { sway: 1.6, core: 0.7 }), ...closeDown(under)] },
    { role: 'b', edges: [edge(lower, 'torn', key + 777, { sway: 2.6, core: 1.25 }), ...closeDown(lower)] },
    { role: 'b', edges: [edge(upper, 'torn', key + 777, { sway: 2.6, core: 0.25 }), ...closeUp] },
  ]
  // The accent lies alone in the opened ground, toward its wide end.
  const t = hingeLeft ? 0.6 + rng() * 0.1 : 0.4 - rng() * 0.1
  const index = Math.round((FAR + WIDTH * t) / ((WIDTH + FAR * 2) / 48))
  const between = [(upper[index][0] + lower[index][0]) / 2, (upper[index][1] + lower[index][1]) / 2]
  const accentAt = [between[0] + normal[0] * 18, between[1] + normal[1] * 18]
  sheets.push(scrap('accent', accentAt, chord + radians((rng() - 0.5) * 22), 132, 62, key + 31))
  plan.lay = {
    name: 'clear',
    sheets: 3,
    rising,
    hinge: hingeLeft ? 'left' : 'right',
    opening: round((opening * 180) / Math.PI, 2),
    bend: round(bend, 1),
  }
  plan.accent = accentAt.map((v) => round(v, 1))
  return sheets
}

function layRun(plan, rng) {
  const { themes } = plan
  const key = plan.seed
  const rising = rng() < 0.5 ? -1 : 1
  const slope = radians(rising * (4 + rng() * 4))
  const sheets = []

  // The sheets the run lies on: one large slab from below, and for a crowded release a second
  // from the opposite corner.
  const baseAngle = slope + radians(-rising * (12 + rng() * 10))
  const along = [Math.cos(baseAngle), Math.sin(baseAngle)]
  const across = [-along[1], along[0]]
  const baseTip = [WIDTH * (0.5 + rng() * 0.12), HEIGHT * (0.72 + rng() * 0.08)]
  sheets.push(
    quad(
      'b',
      [
        [baseTip[0] - across[0] * 330, baseTip[1] - across[1] * 330],
        [baseTip[0] + across[0] * 900, baseTip[1] + across[1] * 900],
        [baseTip[0] + across[0] * 900 - along[0] * 2600, baseTip[1] + across[1] * 900 - along[1] * 2600],
        [baseTip[0] - across[0] * 330 - along[0] * 2600, baseTip[1] - across[1] * 330 - along[1] * 2600],
      ],
      ['torn', 'cut', 'cut', 'torn'],
      key + 4001,
    ),
  )
  const crowded = themes.density > 0.6
  if (crowded) {
    const angle = radians(rising > 0 ? 200 + rng() * 14 : 160 - rng() * 14)
    sheets.push(
      slab('a', [WIDTH * (0.7 + rng() * 0.08), HEIGHT * (0.1 + rng() * 0.07)], angle, 300, key + 4507, rng),
    )
  }

  // The strip, torn across into pieces: each is shorter than the last and lies further on.
  const pieces = clamp(Math.round(4 + themes.density * 1.4 + themes.pulse * 0.8), 5, 6)
  const height = 128 + rng() * 22
  const origin = [WIDTH * 0.06, HEIGHT * (0.5 - rising * 0.1 + rng() * 0.04)]
  const lengths = []
  const gaps = [0]
  for (let i = 0; i < pieces; i++) lengths.push((300 + rng() * 40) * 0.84 ** i)
  for (let i = 1; i < pieces; i++) gaps.push(10 + i * i * 5 + rng() * 8)
  // The whole run is fitted to the canvas, so the last piece always lands on it.
  const fit = (WIDTH * 0.86) / (lengths.reduce((sum, v) => sum + v, 0) + gaps.reduce((sum, v) => sum + v, 0))
  const cuts = [0]
  for (const length of lengths) cuts.push(cuts.at(-1) + length * fit)
  const lean = cuts.map((_, i) => (rng() - 0.5) * 64 * 0.8 ** i)
  const tearAt = (i) => [
    [cuts[i] + lean[i], -height / 2],
    [cuts[i] - lean[i], height / 2],
  ]
  let travelled = 0
  let accentAt = origin
  for (let i = 0; i < pieces; i++) {
    const left = tearAt(i)
    const right = tearAt(i + 1)
    travelled += gaps[i] * fit
    const drift = travelled
    const lift = -i * i * 2.4 * (0.6 + rng() * 0.8)
    const spin = radians((rng() - 0.5) * 1.6 - rising * i * 1.5)
    const middle = [(cuts[i] + cuts[i + 1]) / 2, 0]
    const place = (point) => {
      const turned = rotateAbout(point, middle, spin)
      return rotateAbout([origin[0] + turned[0] + drift, origin[1] + turned[1] + lift], origin, slope)
    }
    const last = i === pieces - 1
    sheets.push({
      role: last ? 'accent' : 'a',
      place,
      edges: [
        edge([left[0], right[0]], 'cut', key + 9000 + i),
        edge(right, 'torn', key + 6000 + (i + 1) * 211, { amp: 0.8, core: 1.1 }),
        edge([right[1], left[1]], 'cut', key + 9100 + i),
        edge(left, 'torn', key + 6000 + i * 211, { amp: 0.8, core: 0.2, reverse: true }),
      ],
    })
    if (last) accentAt = place(middle)
  }
  plan.lay = {
    name: 'run',
    sheets: sheets.length - pieces,
    pieces,
    slope: round((slope * 180) / Math.PI, 2),
    crowded,
  }
  plan.accent = accentAt.map((v) => round(v, 1))
  return sheets
}

// ---------------------------------------------------------------- the coursed grammar

// Every sheet follows one axis, which leans from the vertical by the variation's bearing. A point
// is given as (c, s): c across the axis from the canvas's centre, s along it.
function coursedFrame(plan, rng) {
  const lean = radians(plan.variation.bearing + (rng() - 0.5) * 3)
  const along = [Math.sin(lean), -Math.cos(lean)]
  const across = [Math.cos(lean), Math.sin(lean)]
  const half = (WIDTH / 2) * Math.cos(lean) + (HEIGHT / 2) * Math.abs(Math.sin(lean))
  const reach = (HEIGHT / 2) * Math.cos(lean) + (WIDTH / 2) * Math.abs(Math.sin(lean))
  const at = (c, s) => [WIDTH / 2 + across[0] * c + along[0] * s, HEIGHT / 2 + across[1] * c + along[1] * s]
  const far = half + FAR
  const end = reach + FAR
  // A course from c0 to c1, running the whole length unless s0 or s1 says where it ends.
  const band = (role, c0, c1, key, sides = {}) => {
    const {
      left = 'cut',
      right = 'cut',
      top = 'cut',
      bottom = 'cut',
      s0 = -end,
      s1 = end,
      skew = 0,
      ...options
    } = sides
    const sheet = quad(
      role,
      [
        at(c0, s1 + (top === 'torn' ? skew : 0)),
        at(c1, s1 - (top === 'torn' ? skew : 0)),
        at(c1, s0 + (bottom === 'torn' ? skew : 0)),
        at(c0, s0 - (bottom === 'torn' ? skew : 0)),
      ],
      [top, right, bottom, left],
      key,
      options,
    )
    sheet.crossing = true
    return sheet
  }
  // The stretch of the line at c that lies on the canvas, as [from, to] along the axis.
  const span = (c) => {
    let low = 0
    let high = 0
    for (let s = -end; s <= end; s += 4) {
      const [x, y] = at(c, s)
      if (x < 0 || x > WIDTH || y < 0 || y > HEIGHT) continue
      low = Math.min(low, s)
      high = Math.max(high, s)
    }
    return [low, high]
  }
  const within = (c, t) => {
    const [low, high] = span(c)
    return at(c, low + (high - low) * t)
  }
  return { lean, half, reach, far, end, at, band, span, within }
}

const leanOf = (frame) => round((frame.lean * 180) / Math.PI, 2)

function coursedGather(plan, rng) {
  const { themes } = plan
  const frame = coursedFrame(plan, rng)
  const { half, reach, far, band } = frame
  const key = plan.seed
  const count = clamp(Math.round(4 + themes.density * 2.4 + themes.pulse * 1.2 - themes.precision), 5, 7)
  const flip = rng() < 0.5 ? -1 : 1
  const x1 = half * (-0.36 + rng() * 0.16)
  const x2 = half * (0.3 + rng() * 0.16)
  const seam = 46 + rng() * 40
  // Three courses under everything; the ground shows in the one seam between two of them.
  const sheets = [
    band('b', flip * -far, flip * x1, key, {}),
    band('a', flip * (x1 - 70), flip * x2, key + 977, { left: 'torn', right: 'cut' }),
    band('b', flip * (x2 + seam), flip * far, key + 1931, { left: 'torn' }),
  ]
  // The others come in over them from the two ends in turn and stop where they were torn off.
  const over = count - 3
  const slots = [-0.62, 0.52, -0.08, 0.86].slice(0, over).sort((a, b) => a - b)
  slots.forEach((slot, i) => {
    const width = 150 + rng() * 110
    const centre = half * (slot + (rng() - 0.5) * 0.12)
    const fromTop = (i + (flip > 0 ? 0 : 1)) % 2 === 0
    const tip = reach * (0.08 + rng() * 0.5) * (fromTop ? -1 : 1)
    const cutLeft = rng() < 0.5
    const sides = {
      left: cutLeft ? 'cut' : 'torn',
      right: cutLeft ? 'torn' : 'cut',
      skew: (rng() < 0.5 ? -1 : 1) * width * (0.12 + rng() * 0.2),
    }
    if (fromTop) Object.assign(sides, { s0: tip, bottom: 'torn' })
    else Object.assign(sides, { s1: tip, top: 'torn' })
    // Each takes the dye that the course under its middle does not have.
    const under = flip * centre < x1 - 70 || flip * centre > x2 ? 'b' : 'a'
    sheets.push(
      band(under === 'a' ? 'b' : 'a', centre - width / 2, centre + width / 2, key + 7919 * (i + 1), sides),
    )
  })
  const accentAt = frame.within(flip * half * (0.04 + rng() * 0.14), 0.3 + rng() * 0.4)
  sheets.push(scrap('accent', accentAt, frame.lean + radians((rng() - 0.5) * 5), 150, 84, key + 31))
  plan.lay = { name: 'gather', grammar: 'coursed', sheets: count, lean: leanOf(frame), seam: round(seam, 1) }
  plan.accent = accentAt.map((v) => round(v, 1))
  return sheets
}

function coursedHold(plan, rng) {
  const frame = coursedFrame(plan, rng)
  const { half, reach, far, band } = frame
  const key = plan.seed
  const flip = rng() < 0.5 ? -1 : 1
  const seam = 15 + rng() * 5
  const j1 = half * (-0.36 + rng() * 0.14)
  const j2 = half * (0.34 + rng() * 0.16)
  const shelf = reach * (0.3 + rng() * 0.22)
  const calm = { amp: 0.42, core: 0.8 }
  // Three courses fitted along two even seams; the narrow one stops at a cut end, and a fourth
  // lies under that end, so the ground shows only in the seams.
  const sheets = [
    band('a', flip * -far, flip * j1, key, { right: 'torn', ...calm }),
    band('b', flip * (j1 + seam), flip * j2, key + 977, { left: 'cut', right: 'torn', ...calm }),
    band('a', flip * (j2 + seam), flip * far, key + 1931, { left: 'torn', s1: shelf, top: 'cut', ...calm }),
    band('b', flip * (j2 + seam), flip * far, key + 2903, {
      left: 'cut',
      s0: shelf + seam,
      bottom: 'torn',
      ...calm,
    }),
  ]
  const accentAt = frame.within(flip * (j1 + seam / 2), 0.28 + rng() * 0.44)
  sheets.push(
    scrap('accent', accentAt, frame.lean + radians((rng() - 0.5) * 3), 128, 56, key + 31, { amp: 0.3 }),
  )
  plan.lay = { name: 'hold', grammar: 'coursed', sheets: 4, lean: leanOf(frame), seam: round(seam, 1) }
  plan.accent = accentAt.map((v) => round(v, 1))
  return sheets
}

function coursedClear(plan, rng) {
  const frame = coursedFrame(plan, rng)
  const { half, far, end, at, band } = frame
  const key = plan.seed
  const flip = rng() < 0.5 ? -1 : 1
  // One course has been lifted out: its bay is the only bare ground, and the accent lies in it.
  const bay = half * (0.3 + rng() * 0.08 + plan.themes.wayfinding * 0.04)
  const g0 = half * (0.02 + rng() * 0.2) - bay / 2
  const g1 = g0 + bay
  const bend = (rng() - 0.5) * 60
  const line = (c) => {
    const points = []
    for (let i = 0; i <= 32; i++) {
      const s = -end + (2 * end * i) / 32
      points.push(at(flip * (c + bend * Math.sin((Math.PI * s) / end)), s))
    }
    return points
  }
  const closed = (points, c, torn) => ({
    edges: [
      torn,
      edge([points.at(-1), at(flip * c, end)], 'cut', key + 1),
      edge([at(flip * c, end), at(flip * c, -end)], 'cut', key + 2),
      edge([at(flip * c, -end), points[0]], 'cut', key + 3),
    ],
  })
  const near = line(g0)
  const beyond = line(g1)
  const under = line(g1 - (26 + rng() * 16))
  const outer = half * (-0.5 + rng() * 0.14)
  const sheets = [
    { role: 'a', ...closed(under, far, edge(under, 'torn', key + 555, { sway: 1.6, core: 0.7 })) },
    band('a', flip * -far, flip * (outer + 60), key + 4001, {}),
    { role: 'b', ...closed(near, outer, edge(near, 'torn', key + 777, { sway: 2.2, core: 1.25 })) },
    { role: 'b', ...closed(beyond, far, edge(beyond, 'torn', key + 777, { sway: 2.2, core: 0.25 })) },
  ]
  // The near half's outer side is torn too, and lies over the course beside it.
  sheets[2].edges[2] = edge([at(flip * outer, end), at(flip * outer, -end)], 'torn', key + 888, { amp: 0.8 })
  const accentAt = frame.within(flip * (g0 + bay * (0.36 + rng() * 0.12)), 0.25 + rng() * 0.5)
  sheets.push(scrap('accent', accentAt, frame.lean + radians(90 + (rng() - 0.5) * 16), 132, 62, key + 31))
  plan.lay = { name: 'clear', grammar: 'coursed', sheets: 4, lean: leanOf(frame), bay: round(bay, 1) }
  plan.accent = accentAt.map((v) => round(v, 1))
  return sheets
}

function coursedRun(plan, rng) {
  const { themes } = plan
  const frame = coursedFrame(plan, rng)
  const { half, far, at, band } = frame
  const key = plan.seed
  const flip = rng() < 0.5 ? -1 : 1
  const x0 = half * (-0.58 + rng() * 0.12)
  const x1 = half * (0.2 + rng() * 0.16)
  const sheets = [
    band('a', flip * -far, flip * (x0 + 60), key + 4001, {}),
    band('b', flip * x0, flip * x1, key + 4507, { left: 'torn', right: 'torn' }),
  ]
  // The ground shows in the one bay beside the wide course: narrower when the release is crowded.
  const crowded = themes.density > 0.6
  const bay = (crowded ? 130 : 190) + rng() * 50
  sheets.push(band('a', flip * (x1 + bay), flip * far, key + 5003, { left: 'torn' }))

  // One narrow course torn across into pieces: each is shorter than the last and lies further on.
  const pieces = clamp(Math.round(4 + themes.density * 1.4 + themes.pulse * 0.8), 5, 6)
  const width = 124 + rng() * 20
  const centre = flip * (x1 - width * (0.2 + rng() * 0.5))
  // The run is fitted to the stretch of its own line that lies on the canvas.
  const [low, high] = frame.span(centre)
  const start = low + 34
  const lengths = []
  const gaps = [0]
  for (let i = 0; i < pieces; i++) lengths.push((300 + rng() * 40) * 0.84 ** i)
  for (let i = 1; i < pieces; i++) gaps.push(10 + i * i * 5 + rng() * 8)
  const fit =
    (high - low - 34 - 78) / (lengths.reduce((sum, v) => sum + v, 0) + gaps.reduce((sum, v) => sum + v, 0))
  const cuts = [0]
  for (const length of lengths) cuts.push(cuts.at(-1) + length * fit)
  const lean = cuts.map((_, i) => (rng() - 0.5) * 56 * 0.8 ** i)
  const tearAt = (i) => [
    [cuts[i] + lean[i], -width / 2],
    [cuts[i] - lean[i], width / 2],
  ]
  let travelled = 0
  let accentAt = at(centre, start)
  for (let i = 0; i < pieces; i++) {
    const left = tearAt(i)
    const right = tearAt(i + 1)
    travelled += gaps[i] * fit
    const drift = travelled
    const lift = flip * i * i * 1.6 * (0.6 + rng() * 0.8)
    const spin = radians((rng() - 0.5) * 1.4)
    const middle = [(cuts[i] + cuts[i + 1]) / 2, 0]
    const place = (point) => {
      const turned = rotateAbout(point, middle, spin)
      return at(centre + turned[1] + lift, start + turned[0] + drift)
    }
    const last = i === pieces - 1
    sheets.push({
      role: last ? 'accent' : 'a',
      place,
      edges: [
        edge([left[0], right[0]], 'cut', key + 9000 + i),
        edge(right, 'torn', key + 6000 + (i + 1) * 211, { amp: 0.8, core: 1.1 }),
        edge([right[1], left[1]], 'cut', key + 9100 + i),
        edge(left, 'torn', key + 6000 + i * 211, { amp: 0.8, core: 0.2, reverse: true }),
      ],
    })
    if (last) accentAt = place(middle)
  }
  plan.lay = {
    name: 'run',
    grammar: 'coursed',
    sheets: sheets.length - pieces,
    pieces,
    lean: leanOf(frame),
    crowded,
  }
  plan.accent = accentAt.map((v) => round(v, 1))
  return sheets
}

const LAY = {
  loose: { gather: layGather, hold: layHold, clear: layClear, run: layRun },
  coursed: { gather: coursedGather, hold: coursedHold, clear: coursedClear, run: coursedRun },
}

export function planPiece(version, themes, seed) {
  const { major, minor } = parseVersion(version)
  const thematic = thematicFor(major)
  const variation = variationFor(major, minor)
  const rng = mulberry32(seed)
  const plan = {
    version,
    seed,
    themes,
    thematic,
    variation,
    inks: Object.fromEntries(
      ['light', 'dark'].map((name) => [
        name,
        { a: thematic.deep[name], b: variation.pale[name], accent: thematic.accent },
      ]),
    ),
    // A precise release tears cleanly; a release of many hands tears rough.
    tear: {
      amp: round(8 + themes.hands * 5 - themes.precision * 3.5, 2),
      core: round(14 + themes.hands * 3 - themes.precision * 3, 2),
    },
    fibres: Math.round(150 + themes.density * 90 + rng() * 20),
    grainSeed: seed % 997,
  }
  plan.sheets = LAY[thematic.grammar][LAYS[themes.lead]](plan, rng)
  if (thematic.grammar === 'loose') {
    plan.lay.grammar = 'loose'
    // The loose lay turns as a whole about the canvas's centre, by the variation's bearing.
    if (variation.bearing !== 0) {
      const centre = [WIDTH / 2, HEIGHT / 2]
      const turn = radians(variation.bearing)
      for (const sheet of plan.sheets) {
        const inner = sheet.place ?? ((point) => point)
        sheet.place = (point) => rotateAbout(inner(point), centre, turn)
      }
      plan.accent = rotateAbout(plan.accent, centre, turn).map((v) => round(v, 1))
    }
  }
  return plan
}

// ---------------------------------------------------------------- tearing

function resample(points, step) {
  const out = [points[0]]
  let carried = 0
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1]
    const [bx, by] = points[i]
    const length = Math.hypot(bx - ax, by - ay)
    let at = step - carried
    while (at < length) {
      out.push([ax + ((bx - ax) * at) / length, ay + ((by - ay) * at) / length])
      at += step
    }
    carried = length - (at - step)
  }
  const last = points.at(-1)
  const tail = out.at(-1)
  if (Math.hypot(last[0] - tail[0], last[1] - tail[1]) < step * 0.4 && out.length > 1) out.pop()
  out.push(last)
  return out
}

// One edge as two point lists: the dyed surface's edge, and the edge of the pale core under it.
// `outward` is +1 when the outside of the sheet is to the left of the edge's direction.
function tearEdge(spec, tear, outward) {
  if (spec.kind === 'cut') return { top: spec.points, core: spec.points }
  const points = resample(spec.points, STEP)
  const amp = tear.amp * spec.amp
  const coreWidth = tear.core * spec.core
  const total = (points.length - 1) * STEP
  const top = []
  const core = []
  for (let i = 0; i < points.length; i++) {
    const before = points[Math.max(0, i - 1)]
    const after = points[Math.min(points.length - 1, i + 1)]
    const length = Math.hypot(after[0] - before[0], after[1] - before[1]) || 1
    const normal = [(after[1] - before[1]) / length, -(after[0] - before[0]) / length]
    const s = i * STEP
    const ends = smoothstep(0, 42, Math.min(s, total - s))
    const wander =
      0.58 * noise(spec.key, s / 170) +
      0.27 * noise(spec.key + 1, s / 41) +
      0.11 * noise(spec.key + 2, s / 11) +
      0.04 * noise(spec.key + 5, s / 4)
    const d = amp * (wander + spec.sway * noise(spec.key + 7, s / 460)) * ends
    // The core shows in stretches, not all along: where the dye layer peeled back with the tear.
    const shown = smoothstep(-0.42, 0.18, noise(spec.key + 3, s / 190 + 7.3))
    const feather = 0.5 + 0.3 * noise(spec.key + 4, s / 23) + 0.2 * noise(spec.key + 6, s / 5)
    const c = coreWidth * shown * feather * ends
    top.push([points[i][0] + normal[0] * d, points[i][1] + normal[1] * d])
    core.push([points[i][0] + normal[0] * (d + outward * c), points[i][1] + normal[1] * (d + outward * c)])
  }
  return spec.reverse ? { top: top.reverse(), core: core.reverse() } : { top, core }
}

function signedArea(points) {
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i]
    const [bx, by] = points[(i + 1) % points.length]
    area += ax * by - bx * ay
  }
  return area / 2
}

function outline(sheet, tear) {
  // The corners in drawing order tell which way round the sheet goes, so which side is outside.
  const corners = sheet.edges.map((spec) => (spec.reverse ? spec.points.at(-1) : spec.points[0]))
  const clockwise = signedArea(corners) > 0
  const top = []
  const core = []
  const place = sheet.place ?? ((point) => point)
  for (const spec of sheet.edges) {
    const side = (clockwise ? 1 : -1) * (spec.reverse ? -1 : 1)
    const torn = tearEdge(spec, tear, side)
    top.push(...trim(torn.top.map(place)).slice(0, -1))
    core.push(...trim(torn.core.map(place)).slice(0, -1))
  }
  return { top, core }
}

// ---------------------------------------------------------------- writing the SVG

const inside = ([x, y]) => x > -MARGIN && x < WIDTH + MARGIN && y > -MARGIN && y < HEIGHT + MARGIN

// Along a torn edge, points far outside the canvas say nothing: of each run of them only the
// first and last stay, and the edge's own two ends always do.
function trim(points) {
  const last = points.length - 1
  return points.filter(
    (point, i) => i === 0 || i === last || inside(point) || inside(points[i - 1]) || inside(points[i + 1]),
  )
}

// A sheet none of whose points lies on the canvas is dropped, unless it is a course: a course's
// corners are all outside while it still crosses the canvas.
function pathData(points, crossing = false) {
  const kept = points
  if (kept.length < 3 || !(crossing || kept.some(inside))) return ''
  let x = Math.round(kept[0][0] * 10)
  let y = Math.round(kept[0][1] * 10)
  let data = `M${x / 10} ${y / 10}`
  for (let i = 1; i < kept.length; i++) {
    const nx = Math.round(kept[i][0] * 10)
    const ny = Math.round(kept[i][1] * 10)
    if (nx === x && ny === y) continue
    const dx = (nx - x) / 10
    const dy = (ny - y) / 10
    data += `l${dx}${dy < 0 ? '' : ' '}${dy}`
    x = nx
    y = ny
  }
  return `${data}z`
}

function fibres(plan, rng) {
  const light = []
  const dark = []
  for (let i = 0; i < plan.fibres; i++) {
    const x = rng() * WIDTH
    const y = rng() * HEIGHT
    const angle = rng() * Math.PI * 2
    const length = 7 + rng() * 22
    const curl = (rng() - 0.5) * length * 0.9
    const dx = Math.cos(angle) * length
    const dy = Math.sin(angle) * length
    const cx = dx / 2 - Math.sin(angle) * curl
    const cy = dy / 2 + Math.cos(angle) * curl
    const d = `M${x.toFixed(1)} ${y.toFixed(1)}q${cx.toFixed(1)} ${cy.toFixed(1)} ${dx.toFixed(1)} ${dy.toFixed(1)}`
    if (rng() < 0.6) light.push(d)
    else dark.push(d)
  }
  return { light: light.join(''), dark: dark.join('') }
}

export function renderPiece(plan, variantName) {
  const variant = { ...VARIANTS[variantName], ...plan.inks[variantName] }
  const rng = mulberry32(plan.seed ^ 0x5bd1e995)
  const strands = fibres(plan, rng)
  const body = plan.sheets
    .map((sheet) => {
      const { top, core } = outline(sheet, plan.tear)
      const topData = pathData(top, sheet.crossing)
      if (!topData) return ''
      return `<g filter="url(#lift)"><path fill="${variant.core}" d="${pathData(core, sheet.crossing)}"/><path fill="${variant[sheet.role]}" d="${topData}"/></g>`
    })
    .filter(Boolean)
    .join('\n')
  const region = `filterUnits="userSpaceOnUse" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" color-interpolation-filters="sRGB"`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-labelledby="t d">
<title id="t">Release artwork for ${plan.version}</title>
<desc id="d">Abstract collage of torn paper sheets, ${variantName} variant.</desc>
<defs>
<filter id="lift" ${region}><feDropShadow dx="1.5" dy="3" stdDeviation="2.2" flood-color="${PALETTE.ink}" flood-opacity="${variant.shadowOpacity}"/></filter>
<filter id="grain" ${region}><feTurbulence type="fractalNoise" baseFrequency="0.74" numOctaves="3" seed="${plan.grainSeed}" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncR type="linear" slope="1.9" intercept="-0.45"/><feFuncG type="linear" slope="1.9" intercept="-0.45"/><feFuncB type="linear" slope="1.9" intercept="-0.45"/><feFuncA type="linear" slope="0" intercept="1"/></feComponentTransfer></filter>
<filter id="mottle" ${region}><feTurbulence type="fractalNoise" baseFrequency="0.011 0.019" numOctaves="3" seed="${(plan.grainSeed * 7 + 3) % 997}" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncR type="linear" slope="2.2" intercept="-0.6"/><feFuncG type="linear" slope="2.2" intercept="-0.6"/><feFuncB type="linear" slope="2.2" intercept="-0.6"/><feFuncA type="linear" slope="0" intercept="1"/></feComponentTransfer></filter>
<clipPath id="frame"><rect width="${WIDTH}" height="${HEIGHT}"/></clipPath>
</defs>
<g clip-path="url(#frame)">
<rect width="${WIDTH}" height="${HEIGHT}" fill="${variant.ground}"/>
${body}
<path fill="none" stroke="${PALETTE.core}" stroke-opacity="${variant.fibreLight}" stroke-width="0.9" stroke-linecap="round" d="${strands.light}"/>
<path fill="none" stroke="${PALETTE.ink}" stroke-opacity="${variant.fibreDark}" stroke-width="0.9" stroke-linecap="round" d="${strands.dark}"/>
<rect width="${WIDTH}" height="${HEIGHT}" filter="url(#mottle)" style="mix-blend-mode:soft-light" opacity="${variant.mottleOpacity}"/>
<rect width="${WIDTH}" height="${HEIGHT}" filter="url(#grain)" style="mix-blend-mode:${variant.grainBlend}" opacity="${variant.grainOpacity}"/>
</g>
</svg>
`
}

// ---------------------------------------------------------------- command line

function parseArgs(argv) {
  const args = {}
  const value = (flag, index) => {
    const next = argv[index]
    if (next === undefined || next === '' || next.startsWith('--')) throw new Error(`${flag} needs a value`)
    return next
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--out') args.out = value(flag, ++i)
    else if (flag === '--version') args.version = value(flag, ++i)
    else if (flag === '--notes') args.notes = value(flag, ++i)
    else throw new Error(`Unknown argument: ${flag}`)
  }
  if (Boolean(args.version) !== Boolean(args.notes)) throw new Error('--version and --notes go together')
  return args
}

// One spelling per version: the seed and the file name come from this form, so `0.3.0`,
// `v0.3.0 ` and `v0.3.0+build.5` all name the committed `v0.3.0` pieces.
export function canonicalVersion(text) {
  const { major, minor, patch, pre } = parseVersion(text)
  return `v${major}.${minor}.${patch}${pre ? `-${pre}` : ''}`
}

function committedReleases() {
  return readdirSync(NOTES_DIR)
    .filter((file) => file.endsWith('.md'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((file) => ({ version: canonicalVersion(file.replace(/\.md$/, '')), notes: join(NOTES_DIR, file) }))
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const single = Boolean(args.version)
  const releases = single
    ? [{ version: canonicalVersion(args.version), notes: resolve(args.notes) }]
    : committedReleases()
  const out = resolve(args.out ?? ASSET_DIR)
  mkdirSync(out, { recursive: true })

  const entries = []
  for (const { version, notes } of releases) {
    const text = readFileSync(notes, 'utf8')
    const themes = readThemes(text)
    const seed = seedFor(version)
    const plan = planPiece(version, themes, seed)
    const files = {}
    for (const variantName of Object.keys(VARIANTS)) {
      const svg = renderPiece(plan, variantName)
      const file = `${version}-${variantName}.svg`
      writeFileSync(join(out, file), svg)
      files[variantName] = { file, bytes: Buffer.byteLength(svg) }
      console.log(
        `${file}  ${(Buffer.byteLength(svg) / 1024).toFixed(1)} KB  ${plan.thematic.name} ${plan.variation.minor}  ${plan.lay.name}`,
      )
    }
    entries.push({
      version,
      seed,
      notes: `scripts/release-art/notes/${version}.md`,
      // A stand-in is not a release: its notes were written to show a version that has none yet.
      standIn: STAND_IN.test(text),
      thematic: plan.thematic.name,
      variation: {
        minor: plan.variation.minor,
        bath: plan.variation.bath,
        bearing: plan.variation.bearing,
        pale: plan.variation.pale,
      },
      themes: {
        lines: themes.lines,
        lead: themes.lead,
        density: round(themes.density),
        hands: round(themes.hands),
        precision: round(themes.precision),
        wayfinding: round(themes.wayfinding),
        pulse: round(themes.pulse),
      },
      lay: plan.lay,
      tear: plan.tear,
      accent: plan.accent,
      fibres: plan.fibres,
      files,
    })
  }

  // The manifest describes the committed series; a single piece made on request has none.
  if (!single) {
    const manifest = {
      direction: 'tear',
      madeBy: 'Claude Fable 5.2',
      generator: 'scripts/release-art/tear.mjs',
      canvas: { width: WIDTH, height: HEIGHT },
      palette: {
        hexes: PALETTE_HEXES,
        light: { ground: VARIANTS.light.ground, core: VARIANTS.light.core, accent: PALETTE.saffron },
        dark: { ground: VARIANTS.dark.ground, core: VARIANTS.dark.core, accent: PALETTE.saffron },
      },
      lays: LAYS,
      thematics: [...new Set(entries.map((entry) => parseVersion(entry.version).major))].map((major) => {
        const { deep, pale, ...thematic } = thematicFor(major)
        return { ...thematic, deep, pale }
      }),
      releases: entries,
    }
    // Short lists stay on one line, the way the repo's formatter writes them.
    const json = JSON.stringify(manifest, null, 2).replace(
      /^(.*)\[\n\s+([^[\]{}]*?)\n\s+\](,?)$/gm,
      (whole, before, items, comma) => {
        const line = `${before}[${items.split(/,\n\s+/).join(', ')}]${comma}`
        return line.length <= 110 ? line : whole
      },
    )
    writeFileSync(join(out, 'manifest.json'), `${json}\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
