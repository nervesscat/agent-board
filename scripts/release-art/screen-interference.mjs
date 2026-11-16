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

// Three inks and a ground. Light prints the inks over paper and multiplies them where they
// overlap; dark prints lighter pulls of the same three inks over a blue-black sheet and screens
// them, so the overlaps brighten instead of darkening. Nothing else is on the sheet.
export const PALETTE = {
  light: {
    ground: '#F0EBE1',
    inks: ['#2C467C', '#D9553B', '#C99A2E'],
    blend: 'multiply',
    grain: '#3A332A',
    grainOpacity: 0.16,
  },
  dark: {
    ground: '#14161C',
    inks: ['#6F93D8', '#E8694D', '#D8B24E'],
    blend: 'screen',
    grain: '#F0EBE1',
    grainOpacity: 0.09,
  },
}
export const PALETTE_HEXES = [
  ...new Set(Object.values(PALETTE).flatMap((v) => [v.ground, ...v.inks, v.grain])),
]

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

// The plan is everything the notes and the seed decide; the drawing below only follows it.
export function planPiece(version, themes, seed) {
  const random = mulberry32(seed)
  const pick = (low, high) => lerp(low, high, random())
  const sign = () => (random() < 0.5 ? -1 : 1)
  const { hands, precision, wayfinding, signals, volume } = themes

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

  // How far the screens are turned from each other sets the fringe width: a small gap is a long,
  // slow beat; a wider one packs the fringes tight. Precision closes the gap.
  const baseAngle = pick(8, 34)
  const gap = lerp(5.5, 1.4, precision) + pick(-0.4, 0.4)
  // Warp: how far a lattice is pushed off true, in pixels. Precision keeps it straight; many
  // hands and a large release push it about.
  const warp = clamp(lerp(1, 6, hands * 0.6 + volume * 0.4) * (1 - precision * 0.8), 0.5, 6)
  const warpScale = lerp(560, 320, volume)

  const inks = [0, 1, 2]
  const first = Math.floor(random() * 3)
  const order = [first, ...inks.filter((ink) => ink !== first)]

  const plates = []
  for (let s = 0; s < screens; s++) {
    plates.push({
      ink: order[s],
      angle: round(baseAngle + gap * (s === 2 ? 2.4 : s), 2),
      pitch: round(PITCH * (1 + (s === 0 ? 0 : sign() * pick(0.004, 0.016) * (1 - precision * 0.6))), 3),
      origin: [round(pick(0, PITCH)), round(pick(0, PITCH))],
      warp: s === 0 ? 0 : round(warp * (s === 2 ? 0.7 : 1), 2),
      warpSeed: Math.floor(random() * 1e9),
    })
  }

  // The tone: each screen prints one broad band that runs off the sheet at both ends, its long
  // sides a halftone fade. How the bands lie to one another is the composition: nearly parallel
  // and stacked when the release is about precision, crossing wide when many hands are in it.
  const tilt = pick(-16, 16)
  const spread = speaks.has('hands') ? pick(24, 36) : speaks.has('precision') ? pick(0, 3) : pick(9, 18)
  const narrow = speaks.has('wayfinding') ? 0.82 : 1
  const fields = []
  for (let s = 0; s < screens; s++) {
    const offset = screens === 2 ? [-1, 1][s] : [-1, 0.15, 1][s]
    const turn = screens === 2 ? offset * 0.5 : [-0.5, 0.5, -0.05][s]
    fields.push({
      angle: round(tilt + spread * turn, 2),
      x: round(WIDTH * (0.5 + pick(-0.12, 0.12))),
      y: round(HEIGHT * (0.5 + offset * pick(0.1, 0.17))),
      half: round(HEIGHT * pick(0.2, 0.27) * narrow),
      // A third ink prints lighter, so three inks over one another stay inks and not mud.
      tone: round(pick(0.4, 0.52) * (s === 2 ? 0.72 : 1)),
      ragged: round(lerp(0.05, 0.18, hands * 0.5 + volume * 0.5) * (1 - precision * 0.6)),
      raggedSeed: Math.floor(random() * 1e9),
    })
  }

  // Precision holds an edge: one screen stops dead on a straight line instead of fading.
  const edge = speaks.has('precision')
    ? {
        screen: Math.floor(random() * screens),
        vertical: random() < 0.6,
        at: round(pick(0.42, 0.62)),
        keep: random() < 0.5 ? 'before' : 'after',
      }
    : null

  // Wayfinding clears a lane of paper through the sheet and, across it, shifts the screens a
  // half dot out of phase, so the fringes break and pick up again somewhere else.
  const lane = speaks.has('wayfinding')
    ? {
        at: round(pick(0.36, 0.62)),
        slope: round(pick(-0.28, 0.28)),
        width: round(lerp(40, 90, wayfinding)),
        shift: round(PITCH * 0.5),
      }
    : null

  // Signals grade a screen: its tone climbs steadily from one side of the sheet to the other.
  const ramp = speaks.has('signals')
    ? {
        screen: screens - 1,
        from: random() < 0.5 ? 'left' : 'right',
        floor: round(lerp(0.25, 0.05, signals)),
      }
    : null

  // Ink mottle: the press lays some areas a little heavier, at a scale far above the dots.
  const mottle = { scale: round(pick(220, 340)), strength: round(lerp(0.06, 0.12, volume)) }

  return {
    version,
    seed,
    speaks: [...speaks].sort(),
    screens,
    plates,
    fields,
    edge,
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
  const angle = (field.angle * Math.PI) / 180
  const across = Math.abs(-(x - field.x) * Math.sin(angle) + (y - field.y) * Math.cos(angle)) / field.half
  const shape = 1 - smoothstep(0.45, 1.05, across + wobble)
  let tone = shape * field.tone

  if (plan.edge && plan.edge.screen === s) {
    const t = plan.edge.vertical ? x / WIDTH : y / HEIGHT
    const before = t < plan.edge.at
    if (before !== (plan.edge.keep === 'before')) tone = 0
  }
  if (plan.ramp && plan.ramp.screen === s) {
    const t = plan.ramp.from === 'left' ? x / WIDTH : 1 - x / WIDTH
    tone *= lerp(plan.ramp.floor, 1, smoothstep(0.08, 0.92, t))
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
    `<desc id="${id('desc')}">${plan.screens} halftone screens at slightly different angles, printed over one another; their moiré fringes are the image.</desc>`,
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
    ? [{ version: `v${args.version.replace(/^v/, '')}`, file: resolve(args.notes) }]
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
