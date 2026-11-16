#!/usr/bin/env node
// Release artwork, direction "strike": repeated block impressions.
//
// A piece is printed from a few plain wooden blocks: bars, slabs, wedges and rules, with nothing
// carved on them. A block is inked once and struck again and again along a line. Every impression
// overlaps the one before and comes out paler and saltier, until the ink gives out or the block is
// inked again. The form is the run: how long it is, how true its step is, where it stops.
//
// The release's notes decide the runs (readThemes, planPiece) and the version seeds every choice
// the notes leave open, so the same version always gives the same bytes.
//
//   node scripts/release-art/strike.mjs                 every release in notes/, into the assets
//   node scripts/release-art/strike.mjs --out <dir>     the same, into another directory
//   node scripts/release-art/strike.mjs --version v0.2.6 [--notes <file>] [--out <dir>]
//
// The next release: save its notes as scripts/release-art/notes/<version>.md and run the script.
//
// Made by Claude Fable 5.2.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const NOTES_DIR = join(ROOT, 'scripts/release-art/notes')
const ASSET_DIR = join(ROOT, 'src/assets/release-art/strike')

const WIDTH = 1600
const HEIGHT = 900

// How many steps of ink load a strike can have: each is one filter in the file.
const LOADS = 8
// Bare sheet kept between the primary run and the sheet's edge.
const MARGIN = 70

// Two grounds and three inks. A light piece prints dark inks that multiply where they overlap;
// a dark piece prints the same three hues, lifted, as opaque inks on a black sheet.
export const PALETTE = {
  paper: '#ECE5D5',
  night: '#17191C',
  petrol: '#1E4B5A',
  ochre: '#D29A2C',
  madder: '#C4472F',
  petrolLift: '#78ABB4',
  ochreLift: '#E0AC45',
  madderLift: '#E0603F',
}
export const PALETTE_HEXES = Object.values(PALETTE)

const VARIANTS = {
  light: {
    ground: PALETTE.paper,
    inks: [PALETTE.petrol, PALETTE.ochre, PALETTE.madder],
    blend: 'multiply',
    // The ink film of a full strike and of a spent one.
    film: [0.3, 0.92],
    rim: 0.2,
    grain: PALETTE.petrol,
    grainOpacity: 0.075,
    blindEdge: PALETTE.petrol,
    blindOpacity: [0.42, 0.045],
  },
  dark: {
    ground: PALETTE.night,
    inks: [PALETTE.petrolLift, PALETTE.ochreLift, PALETTE.madderLift],
    blend: 'normal',
    film: [0.2, 0.86],
    rim: 0.14,
    grain: PALETTE.petrolLift,
    grainOpacity: 0.07,
    blindEdge: PALETTE.petrolLift,
    blindOpacity: [0.4, 0.05],
  },
}

// Stems counted in a release's notes, lowercased. A stem matches at the start of a word.
const THEME_WORDS = {
  // Many hands: the release is about agents and people working on the same thing.
  hands: [
    'agent',
    'shar',
    'tool',
    'lane',
    'delegat',
    'collaborat',
    'post',
    'repl',
    'review',
    'decision',
    'hand-off',
    'human',
    'author',
    'assign',
    'skill',
  ],
  // Precision: small things made exact and made to hold.
  precision: [
    'focus',
    'ring',
    'cache',
    'safe',
    'sticky',
    'proxy',
    'clock',
    'cap',
    'keep',
    'exact',
    'count',
    'hold',
    'inside',
    'remember',
    'paint',
    'align',
  ],
  // Wayfinding: things moved, split, removed or made findable.
  wayfinding: [
    'move',
    'split',
    'remove',
    'menu',
    'palette',
    'rename',
    'fold',
    'leave',
    'lives',
    'into',
    'own module',
    'settings',
    'find',
    'default',
    'across',
  ],
  // Momentum: long work kept going, tracked, retried, sped up.
  momentum: [
    'progress',
    'job',
    'speed',
    'run',
    'track',
    'retry',
    'retries',
    'long',
    'release',
    'stall',
    'idle',
    'remote',
    'notification',
    'pipeline',
    'update',
  ],
}

// ---------------------------------------------------------------- deterministic randomness

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
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

export function seedFor(version) {
  return hashString(`strike:${version}`)
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
  // Only the bullets count: the links and the "by @author" tails say nothing about the release.
  const lines = notes
    .toLowerCase()
    .split('\n')
    .filter((line) => /^\s*[*+-]\s/.test(line))
    .map((line) => line.replace(/\sby @\S+ in \S+\s*$/, ''))
  const bullets = lines.length || 1
  const body = lines.join('\n')
  const raw = {}
  let sum = 0
  for (const theme of Object.keys(THEME_WORDS)) {
    raw[theme] = countStems(body, THEME_WORDS[theme]) / bullets
    sum += raw[theme]
  }
  // A theme's weight is its share of what the notes talk about, so a long release and a short one
  // read on the same scale.
  const share = (theme) => (sum > 0 ? raw[theme] / sum : 0.25)
  return {
    bullets,
    density: Math.min(1, Math.log10(1 + bullets) / Math.log10(201)),
    hands: share('hands'),
    precision: share('precision'),
    wayfinding: share('wayfinding'),
    momentum: share('momentum'),
  }
}

export function leadingTheme(themes) {
  let lead = 'hands'
  for (const theme of ['precision', 'wayfinding', 'momentum']) {
    if (themes[theme] > themes[lead]) lead = theme
  }
  return lead
}

// ---------------------------------------------------------------- the plan

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

function lerp(from, to, amount) {
  return from + (to - from) * amount
}

// A block is a plain piece of wood: its outline in its own coordinates, centred, with the corners
// knocked off and a nick or two in its edges. The nicks come back in every impression of a run,
// which is how one sees that the same block made them all.
function makeBlock(kind, random) {
  const sizes = {
    slab: [lerp(230, 290, random()), lerp(300, 360, random())],
    bar: [lerp(84, 112, random()), lerp(360, 430, random())],
    plank: [lerp(130, 160, random()), lerp(300, 350, random())],
    ledger: [lerp(300, 340, random()), lerp(210, 240, random())],
    beam: [lerp(380, 470, random()), lerp(96, 122, random())],
    rule: [lerp(520, 600, random()), lerp(15, 20, random())],
    quad: [lerp(150, 180, random()), lerp(150, 180, random())],
  }
  const [width, height] = sizes[kind]
  const w = width / 2
  const h = height / 2
  const corners = [
    [-w, -h],
    [w, -h],
    [w, h],
    [-w, h],
  ]
  const chamfer = kind === 'rule' ? 1.5 : lerp(3, 6, random())
  const nicks = kind === 'rule' ? 0 : 2 + Math.floor(random() * 2)
  const nickAt = []
  for (let index = 0; index < nicks; index += 1) {
    nickAt.push({
      edge: Math.floor(random() * 4),
      along: lerp(0.18, 0.82, random()),
      depth: lerp(5, 11, random()),
      width: lerp(9, 20, random()),
    })
  }
  const points = []
  for (let edge = 0; edge < 4; edge += 1) {
    const [ax, ay] = corners[edge]
    const [bx, by] = corners[(edge + 1) % 4]
    const length = Math.hypot(bx - ax, by - ay)
    const ux = (bx - ax) / length
    const uy = (by - ay) / length
    // The inward normal of a clockwise outline in screen coordinates.
    const nx = -uy
    const ny = ux
    points.push([ax + ux * chamfer, ay + uy * chamfer])
    const onEdge = nickAt.filter((nick) => nick.edge === edge).sort((a, b) => a.along - b.along)
    for (const nick of onEdge) {
      const at = nick.along * length
      points.push([ax + ux * (at - nick.width / 2), ay + uy * (at - nick.width / 2)])
      points.push([ax + ux * at + nx * nick.depth, ay + uy * at + ny * nick.depth])
      points.push([ax + ux * (at + nick.width / 2), ay + uy * (at + nick.width / 2)])
    }
    points.push([bx - ux * chamfer, by - uy * chamfer])
  }
  return { kind, width, height, points }
}

// A run: one block, struck `count` times from `start`, `step` apart along `heading`.
// `load` is how much ink the block carries (1 fresh, 0 spent); it falls by `keep` at every strike
// and comes back to 1 where the block is inked again.
function makeRun(random, options) {
  const {
    block,
    ink,
    start,
    heading,
    tilt,
    step,
    count,
    keep,
    trueness,
    reinkAt = [],
    firstLoad = 1,
    role,
  } = options
  const strikes = []
  let load = firstLoad
  let x = start[0]
  let y = start[1]
  const looseness = 1 - trueness
  for (let index = 0; index < count; index += 1) {
    if (reinkAt.includes(index)) load = 1
    const sideways = (random() - 0.5) * 2 * looseness * 13
    const forward = (random() - 0.5) * 2 * looseness * step * 0.16
    const turn = ((random() - 0.5) * 2 * looseness * 2.4 * Math.PI) / 180
    const hx = Math.cos(heading)
    const hy = Math.sin(heading)
    strikes.push({
      x: x + hx * forward - hy * sideways,
      y: y + hy * forward + hx * sideways,
      angle: tilt + turn,
      load,
      // A slurred strike: the block skidded as it came down and left a second, fainter edge.
      slur: random() < looseness * 0.3 ? [(random() - 0.5) * 12, lerp(3, 8, random())] : null,
    })
    x += hx * step
    y += hy * step
    load *= keep
  }
  return { role, ink, block, heading, step, strikes }
}

export function planPiece(version, themes, seed) {
  const random = mulberry32(seed)
  const lead = leadingTheme(themes)
  const { hands, precision, momentum, density } = themes

  // How true the press is: a release about precision registers every strike; a release about many
  // hands or about long work lets the block wander.
  const trueness = clamp(0.3 + precision * 1.75 - hands * 0.35, 0.12, 0.97)
  // The sheet is set a little off square, less so when the release is exact.
  const axis = ((random() < 0.5 ? -1 : 1) * lerp(1.2, 3.6, random()) * (1 - trueness * 0.8) * Math.PI) / 180
  const cos = Math.cos(axis)
  const sin = Math.sin(axis)
  // Sheet coordinates: u along the axis, v across it, from the meeting point.
  const focus = [WIDTH * lerp(0.47, 0.53, random()), HEIGHT * lerp(0.47, 0.53, random())]
  const at = (u, v) => [focus[0] + u * cos - v * sin, focus[1] + u * sin + v * cos]
  const along = axis
  const across = axis + Math.PI / 2

  const runs = []
  const blinds = []
  const primaryKind = { hands: 'slab', precision: 'bar', wayfinding: 'ledger', momentum: 'plank' }[lead]
  const primary = makeBlock(primaryKind, random)

  // The primary run crosses the sheet from the left and fades as it goes.
  const overlap = { slab: 0.54, bar: 0.66, ledger: 0.5, plank: 0.62 }[primaryKind]
  const step = primary.width * overlap
  const room = WIDTH - 2 * MARGIN - primary.width
  const reach = Math.min(room, WIDTH * clamp(0.42 + momentum * 0.5 + hands * 0.3 + density * 0.1, 0.46, 0.8))
  const count = clamp(Math.round(reach / step) + 1, 4, 16)
  const span = (count - 1) * step
  const left = clamp(
    -span / 2,
    MARGIN + primary.width / 2 - focus[0],
    WIDTH - MARGIN - primary.width / 2 - span - focus[0],
  )

  if (lead === 'wayfinding') {
    // Reorganization: the run is broken off and set again on a new line, past a clear gutter.
    // Where the next strike would have fallen the block came down without ink and left its dent.
    const side = random() < 0.5 ? -1 : 1
    const shift = primary.height * lerp(0.42, 0.5, random()) * side
    const gutter = primary.width * 0.5 + lerp(46, 64, random())
    // Both lines, their two end blocks and the gutter have to fit between the margins.
    const fits = Math.floor((WIDTH - 2 * MARGIN - 2 * primary.width - gutter) / step) + 2
    const strikes = clamp(count, 5, fits)
    const before = Math.max(2, Math.round(strikes * lerp(0.4, 0.46, random())))
    const after = Math.max(3, strikes - before)
    const total = (before - 1) * step + 2 * primary.width + gutter + (after - 1) * step
    const start = WIDTH / 2 - focus[0] - total / 2 + primary.width / 2
    runs.push(
      makeRun(random, {
        role: 'primary',
        block: primary,
        ink: 0,
        start: at(start, shift * 0.5),
        heading: along,
        tilt: axis,
        step,
        count: before,
        keep: Math.exp(-0.9 / before),
        firstLoad: 0.8,
        trueness,
      }),
    )
    const dent = at(start + before * step, shift * 0.5)
    blinds.push({ block: primary, x: dent[0], y: dent[1], angle: axis })
    const reset = start + (before - 1) * step + primary.width + gutter
    runs.push(
      makeRun(random, {
        role: 'reset',
        block: primary,
        ink: 0,
        start: at(reset, -shift * 0.5),
        heading: along,
        tilt: axis,
        step,
        count: after,
        keep: Math.exp(-1.9 / after),
        trueness,
      }),
    )
    // The way across: one rule through the band the two lines share, over the gutter.
    const rule = makeBlock('rule', random)
    runs.push(
      makeRun(random, {
        role: 'lane',
        block: rule,
        ink: 2,
        start: at(
          reset - primary.width / 2 - gutter / 2 - rule.width * 0.36,
          shift * lerp(-0.12, 0.12, random()),
        ),
        heading: along,
        tilt: axis,
        step: rule.width * 0.82,
        count: 2,
        keep: 0.55,
        trueness: Math.max(trueness, 0.85),
      }),
    )
    // What was moved out of the way: one small block, set down apart from the two lines.
    const quad = makeBlock('quad', random)
    runs.push(
      makeRun(random, {
        role: 'hand',
        block: quad,
        ink: 1,
        start: at(reset + step * 0.4, -shift * 0.5 - side * (primary.height / 2 + quad.height * 0.34)),
        heading: along,
        tilt: axis,
        step: quad.width * 0.6,
        count: 3 + Math.round(hands * 4),
        keep: 0.58,
        trueness,
      }),
    )
  } else if (lead === 'momentum') {
    // Long work kept going: the run climbs as it crosses, and the block is inked again part way.
    const climb = -lerp(0.2, 0.26, random())
    const rise = Math.sin(climb) * span
    const reinkAt = [Math.round(count * lerp(0.48, 0.58, random()))]
    runs.push(
      makeRun(random, {
        role: 'primary',
        block: primary,
        ink: 0,
        start: at(left, -rise / 2 + 10),
        heading: along + climb,
        tilt: axis,
        step,
        count,
        keep: Math.exp(-1.9 / (count * 0.55)),
        trueness,
        reinkAt,
      }),
    )
    // A second job on its own line, started later and still running when the first is spent.
    const beam = makeBlock('beam', random)
    const jobs = clamp(Math.round((span * 0.62) / (beam.width * 0.5)), 3, 6)
    const from = left + span * 0.3
    runs.push(
      makeRun(random, {
        role: 'job',
        block: beam,
        ink: 1,
        start: at(from, -rise / 2 + Math.sin(climb) * span * 0.3 + primary.height * 0.5 + beam.height * 0.1),
        heading: along + climb,
        tilt: axis,
        step: beam.width * 0.5,
        count: jobs,
        keep: 0.7,
        trueness,
      }),
    )
    const quad = makeBlock('quad', random)
    const third = left + step * reinkAt[0]
    runs.push(
      makeRun(random, {
        role: 'job',
        block: quad,
        ink: 2,
        start: at(
          third - step * 2.2,
          -rise / 2 + Math.sin(climb) * (third - left) - primary.height * 0.5 - quad.height * 0.08,
        ),
        heading: along + climb + Math.PI,
        tilt: axis,
        step: quad.width * 0.58,
        count: 3 + Math.round(hands * 5),
        keep: 0.6,
        trueness,
      }),
    )
  } else {
    runs.push(
      makeRun(random, {
        role: 'primary',
        block: primary,
        ink: 0,
        start: at(left, lead === 'precision' ? -14 : 0),
        heading: along,
        tilt: axis,
        step,
        count,
        keep: Math.exp(-1.75 / count),
        trueness,
      }),
    )
  }

  // Many hands: other blocks, other inks, struck outward from where they met the first.
  if (lead === 'hands' || hands > 0.42) {
    const others = clamp(Math.round(hands * 7.4 + density * 1.2 - 1.6), 1, 5)
    const entries = [
      {
        kind: 'beam',
        ink: 1,
        u: lerp(-0.1, -0.02, random()),
        v: -0.03,
        heading: across + Math.PI,
        step: 0.6,
        count: 4,
      },
      { kind: 'quad', ink: 2, u: lerp(0.08, 0.14, random()), v: 0.15, heading: along, step: 0.62, count: 5 },
      {
        kind: 'plank',
        ink: 1,
        u: lerp(-0.2, -0.15, random()),
        v: 0.17,
        heading: along + Math.PI,
        step: 0.56,
        count: 3,
      },
      { kind: 'bar', ink: 2, u: lerp(0.2, 0.25, random()), v: -0.2, heading: along, step: 0.7, count: 3 },
      { kind: 'beam', ink: 1, u: lerp(0.24, 0.3, random()), v: 0.05, heading: across, step: 0.55, count: 3 },
    ]
    for (let index = 0; index < others; index += 1) {
      const entry = entries[index]
      const block = makeBlock(entry.kind, random)
      const vertical = Math.abs(Math.sin(entry.heading - axis)) > 0.5
      runs.push(
        makeRun(random, {
          role: 'hand',
          block,
          ink: entry.ink,
          start: at(entry.u * WIDTH, entry.v * HEIGHT),
          heading: entry.heading + (random() - 0.5) * (1 - trueness) * 0.12,
          tilt: axis + (random() - 0.5) * (1 - trueness) * 0.1,
          step: (vertical ? block.height : block.width) * entry.step,
          count: entry.count + (random() < density ? 1 : 0),
          keep: lerp(0.5, 0.62, random()),
          trueness,
        }),
      )
    }
  }

  // Precision: a rule struck flush under the run, holding its foot, and a second colour laid on
  // the very same step, one strike in three.
  if (lead === 'precision') {
    const rule = makeBlock('rule', random)
    const foot = primary.height / 2 + rule.height / 2 + 2
    runs.push(
      makeRun(random, {
        role: 'keyline',
        block: rule,
        ink: 2,
        start: at(left - primary.width / 2 + rule.width / 2, foot),
        heading: along,
        tilt: axis,
        step: rule.width * 0.9,
        count: Math.max(2, Math.round((span + primary.width) / (rule.width * 0.9))),
        keep: 0.7,
        trueness: 0.99,
      }),
    )
    const second = makeBlock('quad', random)
    runs.push(
      makeRun(random, {
        role: 'register',
        block: second,
        ink: 1,
        start: at(
          left + step * 2 + (second.width - primary.width) / 2,
          -14 - primary.height / 2 + second.height / 2,
        ),
        heading: along,
        tilt: axis,
        step: step * 3,
        count: Math.max(2, Math.floor((count - 2) / 3)),
        keep: 0.6,
        trueness: 0.99,
      }),
    )
  }

  return {
    version,
    lead,
    trueness,
    axis,
    focus,
    runs,
    blinds,
    grainSeed: 1 + (seed % 97),
    toothSeed: 1 + ((seed >>> 8) % 89),
  }
}

// ---------------------------------------------------------------- drawing

function fixed(value) {
  const rounded = Math.round(value * 10) / 10
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

function outline(block, x, y, angle) {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const parts = block.points.map(([px, py], index) => {
    const command = index === 0 ? 'M' : 'L'
    return `${command}${fixed(x + px * cos - py * sin)} ${fixed(y + px * sin + py * cos)}`
  })
  return `${parts.join('')}Z`
}

function loadStep(load) {
  return clamp(Math.round(load * (LOADS - 1)), 0, LOADS - 1)
}

// The sheet's tooth: fine grain, with slow streaks across it where the roller ran thin. One field
// for the whole sheet, so a pit that a spent strike could not fill is still there, smaller, under
// a fresh one. A strike prints where the tooth is lower than its load reaches.
function toothFilters(plan) {
  const filters = []
  for (let step = 0; step < LOADS; step += 1) {
    const load = step / (LOADS - 1)
    const reach = lerp(0.43, 0.69, Math.pow(load, 0.8))
    const slope = 9
    filters.push(
      `<filter id="t${step}" x="-4%" y="-4%" width="108%" height="108%" color-interpolation-filters="sRGB">` +
        `<feTurbulence type="fractalNoise" baseFrequency="0.62" numOctaves="2" seed="${plan.toothSeed}" result="f"/>` +
        `<feTurbulence type="fractalNoise" baseFrequency="0.005 0.036" numOctaves="2" seed="${plan.toothSeed + 5}" result="s"/>` +
        `<feComposite in="f" in2="s" operator="arithmetic" k2="0.6" k3="0.4"/>` +
        `<feComponentTransfer><feFuncA type="linear" slope="${-slope}" intercept="${fixed(slope * reach * 100) / 100}"/></feComponentTransfer>` +
        `<feComposite in="SourceGraphic" operator="in"/>` +
        `</filter>`,
    )
  }
  return filters.join('\n')
}

export function renderPiece(plan, variantName) {
  const variant = VARIANTS[variantName]
  const lines = []
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-labelledby="t d">`,
  )
  lines.push(`<title id="t">Release artwork for ${plan.version}</title>`)
  lines.push(
    `<desc id="d">Abstract print: plain blocks struck in overlapping runs that fade as the ink gives out.</desc>`,
  )
  lines.push('<defs>')
  lines.push(toothFilters(plan))
  lines.push(
    `<filter id="g" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">` +
      `<feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" seed="${plan.grainSeed}"/>` +
      `<feComponentTransfer><feFuncA type="linear" slope="5" intercept="-2.35"/></feComponentTransfer>` +
      `<feComposite in="SourceGraphic" operator="in"/>` +
      `</filter>`,
  )
  lines.push('</defs>')
  lines.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="${variant.ground}"/>`)

  // Blind impressions first: they are in the sheet, under every ink.
  for (const blind of plan.blinds) {
    const d = outline(blind.block, blind.x, blind.y, blind.angle)
    lines.push(
      `<path d="${d}" stroke-width="2.2" stroke-linejoin="round" stroke="${variant.blindEdge}" stroke-opacity="${variant.blindOpacity[0]}" fill="${variant.blindEdge}" fill-opacity="${variant.blindOpacity[1]}"/>`,
    )
  }

  // The runs print in the order they were struck. The first strike of a run is the most inked.
  const order = [...plan.runs].sort((a, b) => rolePlace(a.role) - rolePlace(b.role))
  for (const run of order) {
    const ink = variant.inks[run.ink]
    const group = []
    for (const strike of run.strikes) {
      const film = lerp(variant.film[0], variant.film[1], Math.pow(strike.load, 0.85))
      const d = outline(run.block, strike.x, strike.y, strike.angle)
      const rim = Math.min(1, film + variant.rim)
      group.push(
        `<path d="${d}" fill-opacity="${fixed(film * 100) / 100}" stroke-opacity="${fixed(rim * 100) / 100}" filter="url(#t${loadStep(strike.load)})"/>`,
      )
      if (strike.slur) {
        const slurred = outline(run.block, strike.x + strike.slur[0], strike.y + strike.slur[1], strike.angle)
        group.push(
          `<path d="${slurred}" fill-opacity="${fixed(film * 28) / 100}" stroke-opacity="0" filter="url(#t${Math.max(0, loadStep(strike.load) - 2)})"/>`,
        )
      }
    }
    lines.push(
      `<g fill="${ink}" stroke="${ink}" stroke-width="1.8" stroke-linejoin="round" style="mix-blend-mode:${variant.blend}">`,
    )
    lines.push(group.join('\n'))
    lines.push('</g>')
  }

  // The sheet's own grain, over everything.
  lines.push(
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${variant.grain}" opacity="${variant.grainOpacity}" filter="url(#g)"/>`,
  )
  lines.push('</svg>')
  return `${lines.join('\n')}\n`
}

function rolePlace(role) {
  return { hand: 0, job: 1, primary: 2, reset: 2, register: 3, keyline: 4, lane: 4 }[role] ?? 5
}

// ---------------------------------------------------------------- command line

function parseArgs(argv) {
  const args = { out: ASSET_DIR, version: null, notes: null }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--out' || flag === '--version' || flag === '--notes') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`)
      args[flag.slice(2)] = value
      index += 1
    } else {
      throw new Error(`unknown argument ${flag}`)
    }
  }
  if (args.notes && !args.version) throw new Error('--notes needs --version')
  if (args.version && !/^v\d+\.\d+\.\d+$/.test(args.version)) {
    throw new Error(`--version must look like v0.2.6, got ${args.version}`)
  }
  return args
}

function notesVersions() {
  return readdirSync(NOTES_DIR)
    .filter((file) => /^v\d+\.\d+\.\d+\.md$/.test(file))
    .map((file) => file.slice(0, -3))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
}

function inkNames(variant) {
  return { petrol: variant.inks[0], ochre: variant.inks[1], madder: variant.inks[2] }
}

function round(value) {
  return Math.round(value * 1000) / 1000
}

export function buildRelease(version, notes) {
  const themes = readThemes(notes)
  const plan = planPiece(version, themes, seedFor(version))
  return { themes, plan, light: renderPiece(plan, 'light'), dark: renderPiece(plan, 'dark') }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const outDir = resolve(args.out)
  mkdirSync(outDir, { recursive: true })

  const versions = args.version ? [args.version] : notesVersions()
  if (versions.length === 0) throw new Error(`no release notes in ${NOTES_DIR}`)

  const releases = []
  for (const version of versions) {
    const notesPath = args.notes ? resolve(args.notes) : join(NOTES_DIR, `${version}.md`)
    let notes
    try {
      notes = readFileSync(notesPath, 'utf8')
    } catch {
      throw new Error(`no notes for ${version}: expected ${notesPath}`)
    }
    const { themes, plan, light, dark } = buildRelease(version, notes)
    const files = {}
    for (const [name, svg] of [
      ['light', light],
      ['dark', dark],
    ]) {
      const file = `${version}-${name}.svg`
      writeFileSync(join(outDir, file), svg)
      files[name] = { file, bytes: Buffer.byteLength(svg) }
    }
    releases.push({
      version,
      seed: seedFor(version),
      themes: {
        bullets: themes.bullets,
        density: round(themes.density),
        hands: round(themes.hands),
        precision: round(themes.precision),
        wayfinding: round(themes.wayfinding),
        momentum: round(themes.momentum),
      },
      lead: plan.lead,
      press: {
        trueness: round(plan.trueness),
        axisDegrees: round((plan.axis * 180) / Math.PI),
        blinds: plan.blinds.length,
        strikes: plan.runs.reduce((total, run) => total + run.strikes.length, 0),
      },
      runs: plan.runs.map((run) => ({
        role: run.role,
        block: run.block.kind,
        ink: ['petrol', 'ochre', 'madder'][run.ink],
        strikes: run.strikes.length,
        step: round(run.step),
      })),
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
    direction: 'strike',
    madeBy: 'Claude Fable 5.2',
    generator: 'scripts/release-art/strike.mjs',
    canvas: { width: WIDTH, height: HEIGHT },
    palette: {
      light: {
        ground: VARIANTS.light.ground,
        inks: inkNames(VARIANTS.light),
        overprint: VARIANTS.light.blend,
      },
      dark: { ground: VARIANTS.dark.ground, inks: inkNames(VARIANTS.dark), overprint: VARIANTS.dark.blend },
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
    console.error(`strike: ${error.message}`)
    process.exitCode = 1
  }
}
