#!/usr/bin/env node
// Release artwork, direction "torn paper": a collage of flat, matte papers torn by hand
// and laid on a paper ground. Each release is one sheet, made from its own notes and
// seeded by its version, so the same release always gives the same bytes.
//
// What the notes decide is how the paper is handled, never what it shows:
//   many hands     -> many scraps, torn on every side, overlapping, each at its own angle
//   things holding -> long strips with cut (straight) long edges, butted on a hairline,
//                     sharing one left margin, square to the sheet
//   less clutter   -> an open field; pieces lifted away leave a pale ghost, one is moved
//   mending        -> translucent tissue laid over the seams
//   carried over   -> older pale sheets showing underneath (earlier releases merged in)
//
//   node scripts/release-art/torn-paper.mjs                 # every release under notes/
//   node scripts/release-art/torn-paper.mjs --out <dir>     # the same, somewhere else
//   node scripts/release-art/torn-paper.mjs --version v0.2.6 --notes notes.md [--out <dir>]

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const NOTES_DIR = join(ROOT, 'scripts/release-art/notes')
const ASSET_DIR = join(ROOT, 'src/assets/release-art/torn-paper')

const WIDTH = 1600
const HEIGHT = 900
// Geometry carries the tear's shape; the fray filter carries its fibres, so the paths stay small.
const TEAR_STEP = 11
const FRAY = { core: 4.2, face: 1.4, frequency: 0.6 }
export const GRAIN = { fine: 1.15, mottle: 0.0032 }
export const RIM = { min: 0, max: 6.5 }

export const PALETTE = {
  paper: '#ECE6DA',
  paperUnder: '#E2DBCD',
  card: '#1A1B1D',
  cardUnder: '#202124',
  ink: '#243243',
  inkNight: '#3D546B',
  fog: '#A7B8BF',
  fogNight: '#8EA2AA',
  persimmon: '#D2603D',
  core: '#F8F4EC',
  coreNight: '#D9D2C4',
  umber: '#2A221A',
  black: '#000000',
}
export const PALETTE_HEXES = Object.values(PALETTE)

const VARIANTS = {
  light: {
    ground: PALETTE.paper,
    under: PALETTE.paperUnder,
    hues: { ink: PALETTE.ink, fog: PALETTE.fog, persimmon: PALETTE.persimmon },
    core: PALETTE.core,
    shadow: PALETTE.umber,
    shadowOpacity: 0.2,
    ghostOpacity: 0.75,
    underRim: 0.7,
    tissueOpacity: 0.5,
    speckDark: 0.05,
    speckLight: 0.08,
    mottle: 0.025,
  },
  dark: {
    ground: PALETTE.card,
    under: PALETTE.cardUnder,
    hues: { ink: PALETTE.inkNight, fog: PALETTE.fogNight, persimmon: PALETTE.persimmon },
    core: PALETTE.coreNight,
    shadow: PALETTE.black,
    shadowOpacity: 0.55,
    ghostOpacity: 0.07,
    underRim: 0.14,
    tissueOpacity: 0.22,
    speckDark: 0.1,
    speckLight: 0.045,
    mottle: 0.06,
  },
}

// A stem counts once per line of the notes; the shares of lines that touch each theme
// are the dials. Stems are matched at the start of a word.
const THEME_WORDS = {
  agency: [
    'agent',
    'project',
    'team',
    'share',
    'queue',
    'review',
    'delegat',
    'orchestrat',
    'lane',
    'verdict',
    'decision',
    'connect',
    'worker',
    'skill',
    'session',
    'brief',
    'token',
    'role',
    'human',
    'author',
    'hand',
  ],
  precision: [
    'focus',
    'cache',
    'clock',
    'safe',
    'proxy',
    'cap',
    'sticky',
    'exact',
    'align',
    'inside',
    'forward',
    'remember',
    'websocket',
    'keep',
    'paint',
    'copy',
    'once',
    'height',
    'width',
    'one line',
  ],
  wayfinding: [
    'move',
    'split',
    'remove',
    'menu',
    'palette',
    'fold',
    'leave',
    'lives',
    'rename',
    'drop',
    'find',
    'search',
    'sidebar',
    'window',
    'step',
    'only',
    'own module',
    'into',
  ],
  mending: [
    'retry',
    'fix',
    'restart',
    'settle',
    'reliab',
    'stall',
    'lock',
    'flaky',
    'dies',
    'recover',
    'stop',
    'headroom',
    'idle',
    'lost',
    'progress',
    'tracked',
    'notice',
    'blocked',
  ],
}
export const THEMES = Object.keys(THEME_WORDS)

// --- deterministic randomness ---------------------------------------------------------

function hashString(text) {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

export function seedFor(version) {
  return hashString(`torn-paper:${version}`)
}

function between(rng, low, high) {
  return low + (high - low) * rng()
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

function lerp(a, b, t) {
  return a + (b - a) * t
}

// 1-D value noise with a smooth step, for the long wander of a tear.
function noise1(rng, count) {
  const knots = Array.from({ length: count + 2 }, () => rng() * 2 - 1)
  return (t) => {
    const at = clamp(t, 0, 1) * count
    const index = Math.floor(at)
    const f = at - index
    const s = f * f * (3 - 2 * f)
    return lerp(knots[index], knots[index + 1], s)
  }
}

// --- reading the notes -------------------------------------------------------------------

export function noteItems(notes) {
  return notes
    .split(/\r?\n/)
    .filter((line) => /^\s*[*-]\s+/.test(line))
    .map((line) =>
      line
        .replace(/^\s*[*-]\s+/, '')
        .replace(/\s+by @\S+ in https?:\/\/\S+\s*$/, '')
        .trim(),
    )
    .filter((line) => line.length > 0 && !/made their first contribution/.test(line))
}

function touches(line, stems) {
  const text = ` ${line.toLowerCase()}`
  return stems.some((stem) => new RegExp(`[^a-z]${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text))
}

export function readThemes(notes, version = '') {
  const items = noteItems(notes)
  const own = version.replace(/^v/, '')
  const counts = Object.fromEntries(THEMES.map((theme) => [theme, 0]))
  let carried = 0
  for (const item of items) {
    // A release merged in from an earlier line of work, not this release's own release commit.
    if (/^(release|version)\b/i.test(item) && !(own && item.toLowerCase().endsWith(own))) carried += 1
    for (const theme of THEMES) if (touches(item, THEME_WORDS[theme])) counts[theme] += 1
  }
  const total = Math.max(1, items.length)
  const raw = Object.fromEntries(THEMES.map((theme) => [theme, counts[theme] / total]))
  const sum = THEMES.reduce((acc, theme) => acc + raw[theme], 0) || 1
  const share = Object.fromEntries(THEMES.map((theme) => [theme, round(raw[theme] / sum, 3)]))
  return { items: items.length, carried, counts, share }
}

// --- the plan: where every piece of paper goes ------------------------------------------

function round(value, digits = 1) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function leadTheme(share, among = THEMES) {
  return [...among].sort((a, b) => share[b] - share[a] || a.localeCompare(b))[0]
}

function hueOrder(share) {
  // The lead paper: ink when hands and holding are most of the release, fog otherwise.
  const lead = share.agency + share.precision > 0.55 ? 'ink' : 'fog'
  return [lead, lead === 'ink' ? 'fog' : 'ink', 'persimmon']
}

function shuffle(list, rng) {
  for (let index = list.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1))
    ;[list[index], list[swap]] = [list[swap], list[index]]
  }
  return list
}

// Every piece is a torn quadrilateral: its corners wander off the rectangle, and a torn
// end runs on a slant, so no piece reads as a block, a brick or a bar.
function shard(rng, w, h, amount, edges) {
  const j = () => (rng() - 0.5) * 2 * amount * Math.min(h, 120) * 0.16
  const slantL = edges.left === 'torn' ? (rng() - 0.5) * amount * Math.min(h, 160) * 0.55 : 0
  const slantR = edges.right === 'torn' ? (rng() - 0.5) * amount * Math.min(h, 160) * 0.55 : 0
  const keep = (edge) => (edges[edge] === 'cut' ? 0 : 1)
  return [
    [slantL + j() * keep('left'), j() * keep('top')],
    [slantR + j() * keep('right'), j() * keep('top')],
    [-slantR + j() * keep('right'), j() * keep('bottom')],
    [-slantL + j() * keep('left'), j() * keep('bottom')],
  ].map(([x, y]) => [round(x), round(y)])
}

export function planPiece(version, themes, seed = seedFor(version)) {
  const rng = mulberry32(seed)
  const { share, items, carried } = themes
  const volume = clamp((Math.log2(Math.max(2, items)) - 3) / 4.3, 0, 1)
  const scatter = share.agency
  const hold = share.precision
  const clear = share.wayfinding
  const mend = share.mending
  const firm = hold > 0.3
  const open = !firm && clear > 0.3
  const hues = hueOrder(share)

  // How the hand lays the paper.
  const handling = {
    courses: firm ? 5 : clamp(Math.round(2.6 + 1.4 * volume + 1.6 * scatter - 1.2 * clear), 3, 5),
    splits: round(firm ? 1.2 : 1 + 5 * scatter * volume + 1.2 * clear, 2),
    rotation: round((0.5 + 10 * scatter + 3 * clear) * (1 - 0.92 * hold), 2),
    shard: round(clamp((1 - 1.3 * hold) * (0.4 + scatter + 0.4 * clear), 0.05, 0.75), 2),
    cut: round(clamp(2.4 * hold - 0.4 * scatter, 0, 0.95), 2),
    coverage: round(clamp(0.46 + 0.22 * scatter + 0.06 * hold - 0.25 * clear, 0.32, 0.6), 2),
    accent: round(clamp(0.04 + 0.1 * scatter, 0, 0.25), 2),
    lift: clamp(Math.round(clear * 6), 0, 3),
    mends: clamp(Math.round((mend - 0.22) * 36), 0, 5),
    under: clamp(carried, 0, 3),
    sheetAngle: round((rng() - 0.5) * 6 * (1 - 0.95 * hold) * (0.4 + scatter + clear), 2),
  }

  const side = rng() < 0.5 ? -1 : 1 // where the open field is, and where a moved piece goes
  const areaTop = 80
  const areaBottom = HEIGHT - 100
  const usable = areaBottom - areaTop
  const bandTotal = usable * handling.coverage

  // Course heights: one broad course leads, the others vary; a firm sheet adds one thin rule.
  const weights = Array.from({ length: handling.courses }, (_, index) =>
    firm ? between(rng, 0.6, 1.3) : index === 0 ? between(rng, 1.5, 2) : between(rng, 0.45, 1.2),
  )
  shuffle(weights, rng)
  if (firm) weights[1 + Math.floor(rng() * (handling.courses - 2))] = 0.2
  const nudged = firm ? Math.floor(rng() * handling.courses) : -1
  const gaps = weights
    .slice(1)
    .map(() => (firm ? 7 : lerp(10, 60, clear) - 26 * scatter + between(rng, -8, 24)))
  const gapSum = gaps.reduce((a, b) => a + b, 0)
  const weightSum = weights.reduce((a, b) => a + b, 0)
  const heights = weights.map((w) => Math.max(20, ((bandTotal - gapSum) * w) / weightSum))
  const blockHeight = heights.reduce((a, b) => a + b, 0) + gapSum
  let y = areaTop + (usable - blockHeight) * clamp(0.45 + (rng() - 0.5) * (1 - hold) * 0.8, 0.08, 0.9)

  // A firm sheet is one block cut into strips: shared margins on both sides, cut long edges.
  const blockLeft = Math.round(between(rng, 150, 300))
  const blockRight = Math.round(WIDTH - between(rng, 330, 520))
  const pieces = []
  const seams = []

  // A firm release is one trimmed sheet torn across and laid back: each tear's two sides
  // still match, a hairline apart. Only a thin strip of the accent shows under it.
  let matched = null
  if (firm) {
    const w = between(rng, 820, 1000)
    const h = between(rng, 300, 380)
    const x = Math.round(between(rng, 170, WIDTH - w - 260))
    const top = Math.round(areaTop + (usable - h) * between(rng, 0.3, 0.5))
    const tearCount = clamp(1 + Math.round(volume * 2 + hold), 1, 3)
    const tears = Array.from({ length: tearCount }, (_, n) => ({
      at: round(((n + 1) / (tearCount + 1) + between(rng, -0.07, 0.07)) * w + x),
      slant: round(between(rng, 30, 110) * (rng() < 0.5 ? -1 : 1)),
      rim: rng() < 0.5 ? 'left' : 'right',
    }))
    matched = { x, y: top, w: round(w), h: round(h), gap: 7, hue: hues[0], tears }
    // The accent lies under one tear: it shows only through the hairline and just below the edge.
    const under = tears[Math.floor(rng() * tears.length)]
    const accentW = between(rng, 80, 130)
    const accentH = h * between(rng, 0.35, 0.5)
    const accentEdges = { top: 'torn', bottom: 'torn', left: 'torn', right: 'torn' }
    pieces.push({
      cx: under.at + matched.gap * (tears.indexOf(under) + 0.5),
      cy: top + h + between(rng, 10, 18) - accentH / 2,
      w: accentW,
      h: accentH,
      rot: between(rng, -5, 5),
      hue: 'persimmon',
      edges: accentEdges,
      k: shard(rng, accentW, accentH, 0.5, accentEdges),
      state: 'laid',
    })
  }

  if (!firm)
    heights.forEach((height, courseIndex) => {
      const thin = firm && height < 40
      let x0
      let x1
      if (firm) {
        x0 =
          blockLeft +
          (thin ? between(rng, 30, 90) : courseIndex === nudged ? -between(rng, 16, 26) : between(rng, -3, 3))
        x1 = blockRight + (thin ? between(rng, -160, -40) : between(rng, -24, 24))
      } else if (open) {
        const reach = between(rng, 0.38, 0.62) * WIDTH
        const inset = between(rng, -60, 140)
        x0 = side < 0 ? inset : WIDTH - inset - reach
        x1 = x0 + reach
      } else {
        x0 = between(rng, -80, 60 + 340 * (1 - scatter))
        x1 = WIDTH - between(rng, -80, 60 + 340 * (1 - scatter))
      }
      const count = thin ? 1 : Math.max(open ? 2 : 1, Math.round(handling.splits * between(rng, 0.55, 1.45)))
      const spans = Array.from({ length: count }, () => between(rng, 0.35, 1.65))
      const spanSum = spans.reduce((a, b) => a + b, 0)
      let cursor = x0
      spans.forEach((span, index) => {
        const width = ((x1 - x0) * span) / spanSum
        let start = cursor
        const end = cursor + width
        if (index > 0) {
          start += firm ? 6 : between(rng, -90, 0) * scatter + between(rng, 0, 26) * (1 - scatter)
          seams.push({ x: cursor, y: y + height / 2, h: height })
        }
        cursor = end
        const hue = thin
          ? 'persimmon'
          : rng() < handling.accent && !firm && !open
            ? 'persimmon'
            : scatter > 0.33
              ? hues[rng() < 0.55 ? 0 : 1]
              : hues[(courseIndex + index) % 2]
        const edges = {
          top: rng() < handling.cut ? 'cut' : 'torn',
          bottom: rng() < handling.cut ? 'cut' : 'torn',
          left: firm ? 'cut' : 'torn',
          right: firm && index < count - 1 ? 'cut' : 'torn',
        }
        const h = height * between(rng, 1 - 0.22 * scatter, 1 + 0.16 * scatter)
        const w = end - start
        pieces.push({
          cx: (start + end) / 2,
          cy: y + height / 2 + between(rng, -1, 1) * 40 * scatter,
          w,
          h,
          rot: between(rng, -1, 1) * handling.rotation,
          hue,
          edges,
          k: shard(rng, w, h, handling.shard, edges),
          state: 'laid',
        })
      })
      if (courseIndex < heights.length - 1) {
        seams.push({ x: between(rng, x0 + 100, x1 - 100), y: y + height + gaps[courseIndex] / 2, h: 0 })
        y += height + gaps[courseIndex]
      }
    })

  // Lifting: big pieces go first, alternately lifted off and moved into the open field.
  const ghosts = []
  const liftable = pieces
    .map((piece, index) => ({ piece, index, size: piece.w * piece.h }))
    .sort((a, b) => b.size - a.size || a.index - b.index)
    .slice(1, 1 + handling.lift * 2)
  for (let n = 0; n < handling.lift && n < liftable.length; n += 1) {
    const pick = liftable[(n * 2 + Math.floor(rng() * 2)) % liftable.length].piece
    if (pick.state !== 'laid') continue
    ghosts.push({ ...pick, state: 'ghost' })
    if (n % 2 === 0) {
      pick.state = 'removed'
    } else {
      pick.state = 'moved'
      pick.hue = 'persimmon'
      pick.cx += -side * between(rng, 0.42, 0.55) * WIDTH
      pick.cy += between(rng, -60, 60)
      pick.w *= 0.8
      pick.h *= 0.8
      pick.k = pick.k.map(([x, yy]) => [round(x * 0.8), round(yy * 0.8)])
      pick.rot += between(rng, -4, 4)
    }
  }

  // Every sheet carries the accent at least once: if chance gave none, the smallest scrap takes it.
  if (!pieces.some((piece) => piece.hue === 'persimmon')) {
    const smallest = [...pieces.filter((piece) => piece.state === 'laid')].sort(
      (a, b) => a.w * a.h - b.w * b.h,
    )[0]
    if (smallest) smallest.hue = 'persimmon'
  }

  // Mending: a laid piece torn in two and laid back, its halves overlapping on a ragged
  // seam that shows the pale core, the second half a few pixels out of true.
  const mends = []
  const mendable = pieces.filter(
    (piece) => piece.state === 'laid' && piece.w > 160 && piece.hue !== 'persimmon',
  )
  for (let n = 0; n < handling.mends && mendable.length > 0; n += 1) {
    const piece = mendable.splice(Math.floor(rng() * mendable.length), 1)[0]
    const at = between(rng, 0.32, 0.68)
    const left = piece.cx - piece.w / 2
    const cutX = left + piece.w * at
    const overlap = 5
    const right = {
      ...piece,
      cx: (cutX - overlap + piece.cx + piece.w / 2) / 2,
      w: piece.cx + piece.w / 2 - (cutX - overlap),
      cy: piece.cy + between(rng, 2, 6) * (rng() < 0.5 ? -1 : 1),
      rot: piece.rot + between(rng, -1.2, 1.2),
      edges: { ...piece.edges, left: 'torn' },
      k: [
        [between(rng, -1, 1) * 14, piece.k[0][1]],
        piece.k[1],
        piece.k[2],
        [between(rng, -1, 1) * 14, piece.k[3][1]],
      ].map(([x, yy]) => [round(x), round(yy)]),
      state: 'laid',
    }
    piece.cx = (left + cutX) / 2
    piece.w = cutX - left
    piece.edges = { ...piece.edges, right: 'torn' }
    piece.k = [
      piece.k[0],
      [round(right.k[0][0]), piece.k[1][1]],
      [round(right.k[3][0]), piece.k[2][1]],
      piece.k[3],
    ]
    pieces.splice(pieces.indexOf(piece) + 1, 0, right)
    mends.push({ x: round(cutX), y: round(piece.cy) })
  }

  // Older sheets underneath, carried in from releases merged into this one.
  const under = Array.from({ length: handling.under }, (_, n) => {
    const edges = { top: 'torn', bottom: 'torn', left: 'torn', right: 'torn' }
    const w = between(rng, 420, 760)
    const h = between(rng, 200, 380)
    return {
      cx: between(rng, 260, 1340),
      cy: between(rng, 230, 600),
      w,
      h,
      rot: between(rng, -6, 6) + n,
      edges,
      k: shard(rng, w, h, 0.9, edges),
    }
  })

  return { version, seed, hues, side, handling, pieces, matched, ghosts, mends, under }
}

// --- tearing -------------------------------------------------------------------------

function corners(piece) {
  const { cx, cy, w, h } = piece
  const k = piece.k ?? [
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
  ]
  return [
    [cx - w / 2 + k[0][0], cy - h / 2 + k[0][1]],
    [cx + w / 2 + k[1][0], cy - h / 2 + k[1][1]],
    [cx + w / 2 + k[2][0], cy + h / 2 + k[2][1]],
    [cx - w / 2 + k[3][0], cy + h / 2 + k[3][1]],
  ]
}

// One edge from a to b. Returns the core's points (the torn fibre line) and the face's
// (the coloured layer, which gives way a little short of it and shows the pale core).
function edgePoints(a, b, mode, rng) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const length = Math.hypot(dx, dy)
  if (mode === 'cut') return { core: [a], face: [a] }
  // Outward normal for a clockwise polygon on screen.
  const nx = dy / length
  const ny = -dx / length
  const steps = Math.max(2, Math.ceil(length / TEAR_STEP))
  const wander = noise1(rng, Math.max(2, Math.round(length / 140)))
  const rimNoise = noise1(rng, Math.max(3, Math.round(length / 60)))
  const amplitude = Math.min(16, 4 + length * 0.018)
  const tilt = between(rng, -0.012, 0.012) * length
  const core = []
  const face = []
  for (let i = 0; i < steps; i += 1) {
    const t = i / steps
    const envelope = Math.min(1, Math.sin(Math.PI * t) * 3)
    const offset = envelope * (wander(t) * amplitude + (rng() - 0.5) * 3.2 + tilt * (t - 0.5))
    const px = a[0] + dx * t
    const py = a[1] + dy * t
    core.push([px + nx * offset, py + ny * offset])
    const rim =
      envelope *
      clamp(RIM.min + (rimNoise(t) * 0.5 + 0.5) * (RIM.max + 2) - 2 + rng() * 1.2, RIM.min, RIM.max)
    face.push([px + nx * (offset - rim), py + ny * (offset - rim)])
  }
  return { core, face }
}

export function tear(piece, rng) {
  const c = corners(piece)
  const order = ['top', 'right', 'bottom', 'left']
  const core = []
  const face = []
  order.forEach((edge, index) => {
    const points = edgePoints(c[index], c[(index + 1) % 4], piece.edges[edge], rng)
    core.push(...points.core)
    face.push(...points.face)
  })
  return { core, face }
}

function num(value) {
  const text = round(value, 1).toFixed(1)
  return text.endsWith('.0') ? text.slice(0, -2) : text
}

function pathData(points) {
  let d = `M${num(points[0][0])} ${num(points[0][1])}`
  let [px, py] = [round(points[0][0]), round(points[0][1])]
  let segment = 'l'
  for (const [x, y] of points.slice(1)) {
    const rx = round(x)
    const ry = round(y)
    const dx = num(rx - px)
    const dy = num(ry - py)
    const pair = `${dx}${dy.startsWith('-') ? '' : ' '}${dy}`
    d += segment ? `${segment}${pair}` : `${pair.startsWith('-') ? '' : ' '}${pair}`
    segment = ''
    px = rx
    py = ry
  }
  return `${d}z`
}

function rotation(piece) {
  const angle = round(piece.rot, 2)
  return angle === 0 ? '' : ` transform="rotate(${angle} ${num(piece.cx)} ${num(piece.cy)})"`
}

// --- the sheet ------------------------------------------------------------------------

function defs(seed, variant) {
  const s = (n) => (seed + n) % 100000
  return [
    '<defs>',
    // Fibres along every torn edge: the geometry tears, the filter frays.
    `<filter id="fray" filterUnits="userSpaceOnUse" x="-60" y="-60" width="${WIDTH + 120}" height="${HEIGHT + 120}">`,
    `<feTurbulence type="fractalNoise" baseFrequency="${FRAY.frequency}" numOctaves="2" seed="${s(1)}" result="n"/>`,
    `<feDisplacementMap in="SourceGraphic" in2="n" scale="${FRAY.core}" xChannelSelector="R" yChannelSelector="G"/>`,
    '</filter>',
    `<filter id="soft" filterUnits="userSpaceOnUse" x="-60" y="-60" width="${WIDTH + 120}" height="${HEIGHT + 120}">`,
    `<feTurbulence type="fractalNoise" baseFrequency="${FRAY.frequency}" numOctaves="2" seed="${s(2)}" result="n"/>`,
    `<feDisplacementMap in="SourceGraphic" in2="n" scale="${FRAY.face}" xChannelSelector="R" yChannelSelector="G"/>`,
    '</filter>',
    // The paper sits on the ground: a short, soft shadow.
    `<filter id="lift" filterUnits="userSpaceOnUse" x="-60" y="-60" width="${WIDTH + 120}" height="${HEIGHT + 120}">`,
    `<feDropShadow dx="1.2" dy="2.2" stdDeviation="2.4" flood-color="${variant.shadow}" flood-opacity="${variant.shadowOpacity}"/>`,
    '</filter>',
    // Grain over everything: fine speck in two tones, and a slow mottle of the paper's density.
    `<filter id="speck" filterUnits="userSpaceOnUse" x="0" y="0" width="${WIDTH}" height="${HEIGHT}">`,
    `<feTurbulence type="fractalNoise" baseFrequency="${GRAIN.fine}" numOctaves="2" seed="${s(3)}"/>`,
    `<feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -${round(variant.speckDark * 9, 2)} ${round(variant.speckDark * 4.6, 3)}"/>`,
    '</filter>',
    `<filter id="fleck" filterUnits="userSpaceOnUse" x="0" y="0" width="${WIDTH}" height="${HEIGHT}">`,
    `<feTurbulence type="fractalNoise" baseFrequency="${GRAIN.fine}" numOctaves="2" seed="${s(4)}"/>`,
    `<feColorMatrix values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 ${round(variant.speckLight * 9, 2)} -${round(variant.speckLight * 4.4, 3)}"/>`,
    '</filter>',
    `<filter id="mottle" filterUnits="userSpaceOnUse" x="0" y="0" width="${WIDTH}" height="${HEIGHT}">`,
    `<feTurbulence type="fractalNoise" baseFrequency="${GRAIN.mottle} ${GRAIN.mottle * 1.6}" numOctaves="3" seed="${s(5)}"/>`,
    `<feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -${round(variant.mottle * 4, 3)} ${round(variant.mottle * 2.2, 3)}"/>`,
    '</filter>',
    '</defs>',
  ].join('')
}

// A tear across a trimmed sheet, top to bottom, shared by the pieces on both its sides.
function tearLine(tear, top, bottom, rng) {
  const height = bottom - top
  const steps = Math.max(2, Math.ceil(height / TEAR_STEP))
  const wander = noise1(rng, 3)
  const rimNoise = noise1(rng, 6)
  const points = []
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    const jitter = i === 0 || i === steps ? 0 : (rng() - 0.5) * 3.4
    points.push({
      x: tear.at + tear.slant * (t - 0.5) + wander(t) * 16 + jitter,
      y: top + height * t,
      rim: clamp((rimNoise(t) * 0.5 + 0.5) * (RIM.max + 2) - 1.5 + rng(), RIM.min, RIM.max),
    })
  }
  return points
}

export function matchedPieces(matched, rng) {
  const top = matched.y
  const bottom = matched.y + matched.h
  const straight = (x) => [
    { x, y: top, rim: 0 },
    { x, y: bottom, rim: 0 },
  ]
  const lines = matched.tears.map((tear) => ({ tear, points: tearLine(tear, top, bottom, rng) }))
  const bounds = [{ points: straight(matched.x) }, ...lines, { points: straight(matched.x + matched.w) }]
  const result = []
  for (let j = 0; j < bounds.length - 1; j += 1) {
    const left = bounds[j]
    const right = bounds[j + 1]
    const shift = j * matched.gap
    // The pale core shows on one side of each tear only, as it does when paper is torn.
    const leftRim = left.tear?.rim === 'right' ? 1 : 0
    const rightRim = right.tear?.rim === 'left' ? 1 : 0
    const core = [
      ...right.points.map((p) => [p.x + shift, p.y]),
      ...[...left.points].reverse().map((p) => [p.x + shift, p.y]),
    ]
    const face = [
      ...right.points.map((p) => [p.x + shift - p.rim * rightRim, p.y]),
      ...[...left.points].reverse().map((p) => [p.x + shift + p.rim * leftRim, p.y]),
    ]
    result.push({ core, face })
  }
  return result
}

function paper(piece, rng, fill, coreFill, extra = '') {
  const torn = tear(piece, rng)
  const t = rotation(piece)
  return {
    core: `<path${t} fill="${coreFill}"${extra} d="${pathData(torn.core)}"/>`,
    face: `<path${t} fill="${fill}"${extra} d="${pathData(torn.face)}"/>`,
  }
}

export function renderPiece(plan, variantName) {
  const variant = VARIANTS[variantName]
  // One stream per variant, from the same seed: light and dark tear the same way.
  const rng = mulberry32(plan.seed ^ 0x9e3779b9)
  const out = []
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="t d">`,
  )
  out.push(`<title id="t">${plan.version}</title>`)
  out.push(`<desc id="d">Abstract torn-paper collage for release ${plan.version}, ${variantName}.</desc>`)
  out.push(defs(plan.seed, variant))
  out.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="${variant.ground}"/>`)
  out.push(`<rect width="${WIDTH}" height="${HEIGHT}" filter="url(#mottle)"/>`)

  const sheet = plan.handling.sheetAngle
  out.push(`<g transform="rotate(${sheet} ${WIDTH / 2} ${HEIGHT / 2})">`)

  if (plan.under.length > 0) {
    const cores = []
    const faces = []
    for (const sheetPiece of plan.under) {
      const p = paper(sheetPiece, rng, variant.under, variant.core)
      cores.push(p.core)
      faces.push(p.face)
    }
    // No shadow: they lie flat under everything, flush with the ground.
    out.push(
      `<g filter="url(#fray)" opacity="${variant.underRim}">${cores.join('')}</g><g filter="url(#soft)">${faces.join('')}</g>`,
    )
  }

  if (plan.ghosts.length > 0) {
    const patches = []
    for (const ghost of plan.ghosts) patches.push(paper(ghost, rng, variant.core, variant.core).core)
    // Where a piece was lifted: the ground kept paler under it, with its torn outline.
    out.push(`<g filter="url(#fray)" opacity="${variant.ghostOpacity}">${patches.join('')}</g>`)
  }

  // The laid pieces, each its core then its face, so a later piece covers an earlier one whole.
  const laid = plan.pieces.filter((piece) => piece.state === 'laid' || piece.state === 'moved')
  const body = []
  for (const piece of laid) {
    const p = paper(piece, rng, variant.hues[piece.hue], variant.core)
    body.push(`<g filter="url(#fray)">${p.core}</g><g filter="url(#soft)">${p.face}</g>`)
  }
  if (plan.matched) {
    for (const part of matchedPieces(plan.matched, rng)) {
      body.push(
        `<g filter="url(#fray)"><path fill="${variant.core}" d="${pathData(part.core)}"/></g>` +
          `<g filter="url(#soft)"><path fill="${variant.hues[plan.matched.hue]}" d="${pathData(part.face)}"/></g>`,
      )
    }
  }
  out.push(`<g filter="url(#lift)">${body.join('')}</g>`)

  out.push('</g>')

  out.push(`<rect width="${WIDTH}" height="${HEIGHT}" filter="url(#speck)"/>`)
  out.push(`<rect width="${WIDTH}" height="${HEIGHT}" filter="url(#fleck)"/>`)
  out.push('</svg>\n')
  return out.join('')
}

// --- command line -------------------------------------------------------------------

function parseArgs(argv) {
  const args = { out: null, version: null, notes: null }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!['--out', '--version', '--notes'].includes(flag)) throw new Error(`Unknown argument: ${flag}`)
    const value = argv[index + 1]
    if (value === undefined || value === '' || value.startsWith('--'))
      throw new Error(`${flag} needs a value`)
    args[flag.slice(2)] = value
    index += 1
  }
  if ((args.version === null) !== (args.notes === null)) throw new Error('--version and --notes go together')
  return args
}

function versionKey(version) {
  return version
    .replace(/^v/, '')
    .split('.')
    .map((part) => part.padStart(6, '0'))
    .join('.')
}

function summarize(plan, themes) {
  const count = (state) => plan.pieces.filter((piece) => piece.state === state).length
  return {
    version: plan.version,
    seed: plan.seed,
    notes: { items: themes.items, carried: themes.carried, share: themes.share },
    lead: leadTheme(themes.share),
    hues: plan.hues,
    handling: plan.handling,
    paper: {
      pieces: plan.pieces.length + (plan.matched ? plan.matched.tears.length + 1 : 0),
      matchedTears: plan.matched ? plan.matched.tears.length : 0,
      laid: count('laid'),
      moved: count('moved'),
      lifted: count('removed'),
      ghosts: plan.ghosts.length,
      mends: plan.mends.length,
      under: plan.under.length,
      cutEdges: plan.pieces.reduce(
        (acc, piece) => acc + Object.values(piece.edges).filter((edge) => edge === 'cut').length,
        0,
      ),
    },
  }
}

export function build(version, notes) {
  const themes = readThemes(notes, version)
  const plan = planPiece(version, themes)
  return {
    plan,
    themes,
    files: { light: renderPiece(plan, 'light'), dark: renderPiece(plan, 'dark') },
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const out = resolve(args.out ?? ASSET_DIR)
  mkdirSync(out, { recursive: true })
  const releases = args.version
    ? [{ version: args.version, notes: readFileSync(resolve(args.notes), 'utf8') }]
    : readdirSync(NOTES_DIR)
        .filter((file) => /^v\d+\.\d+\.\d+\.md$/.test(file))
        .map((file) => ({ version: file.slice(0, -3), notes: readFileSync(join(NOTES_DIR, file), 'utf8') }))
        .sort((a, b) => versionKey(a.version).localeCompare(versionKey(b.version)))

  const summaries = []
  for (const release of releases) {
    const made = build(release.version, release.notes)
    const record = summarize(made.plan, made.themes)
    record.files = {}
    for (const [name, svg] of Object.entries(made.files)) {
      const file = `${release.version}-${name}.svg`
      writeFileSync(join(out, file), svg)
      record.files[name] = { file, bytes: Buffer.byteLength(svg) }
    }
    summaries.push(record)
    console.log(
      `${release.version}: ${record.lead}, ${record.paper.laid + record.paper.moved} pieces, ${record.files.light.bytes}/${record.files.dark.bytes} bytes`,
    )
  }

  // The manifest describes the series; a single new release is written without one.
  if (!args.version) {
    const manifest = {
      direction: 'torn-paper',
      madeBy: 'Claude Opus 5.5 (medium effort)',
      generator: 'scripts/release-art/torn-paper.mjs',
      canvas: { width: WIDTH, height: HEIGHT },
      palette: {
        hexes: PALETTE_HEXES,
        light: { ...VARIANTS.light, hues: { ...VARIANTS.light.hues } },
        dark: { ...VARIANTS.dark, hues: { ...VARIANTS.dark.hues } },
      },
      print: { tearStep: TEAR_STEP, fray: FRAY, grain: GRAIN, rim: RIM },
      releases: summaries,
    }
    writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
