#!/usr/bin/env node
// Release artwork, direction "pochoir": pigment sprayed past the cut edge of a stencil card.
//
// Every mark is one pass of an airbrush along a cut edge. The side that lay against the card is
// razor-sharp; the far side falls away into a speckle of loose droplets. There are no closed
// shapes and no outlines: only cut edges (long straight cuts and wide, shallow arcs) and the spray
// drifting off them, in two inks on a paper ground (light) or an ink ground (dark).
//
// A release's notes set the passes: how many edges, how far their angles wander, how hard and how
// long each spray falls off, whether the card was stepped along a path, and whether it was
// sprayed again a little further on (an echo). The version seeds everything else, so the same
// version always gives the same bytes.
//
//   node scripts/release-art/pochoir.mjs                 every release in notes/ -> src/assets/release-art/pochoir/
//   node scripts/release-art/pochoir.mjs --out <dir>     the same series into another directory
//   node scripts/release-art/pochoir.mjs --version v0.2.6 --notes <file> [--out <dir>]
//                                                        one new release, without touching the manifest

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const NOTES_DIR = join(ROOT, 'scripts/release-art/notes')
const ASSET_DIR = join(ROOT, 'src/assets/release-art/pochoir')

const WIDTH = 1600
const HEIGHT = 900

// The spray: droplet noise frequency (cycles per unit) and the knife's wobble along a cut.
export const SPRAY = { frequency: 0.62, octaves: 2, spread: 3.4, edgeWobble: 2.2, edgeFrequency: 0.018 }

export const PALETTE = {
  paper: '#EEE8DC',
  paperFleck: '#C9BFAE',
  verdigris: '#1E4F4A',
  minium: '#C8532D',
  soot: '#16191A',
  sootFleck: '#2A2F30',
  celadon: '#8CC2B2',
  coral: '#E8845C',
}
export const PALETTE_HEXES = Object.values(PALETTE)

const VARIANTS = {
  light: {
    ground: PALETTE.paper,
    fleck: PALETTE.paperFleck,
    inkA: PALETTE.verdigris,
    inkB: PALETTE.minium,
    blend: 'multiply',
  },
  dark: {
    ground: PALETTE.soot,
    fleck: PALETTE.sootFleck,
    inkA: PALETTE.celadon,
    inkB: PALETTE.coral,
    blend: 'screen',
  },
}

// Stems a release's lines are read by. A line counts once per theme it touches.
const THEME_WORDS = {
  agency: [
    'agent',
    'review',
    'pr ',
    'pr queue',
    'lane',
    'project',
    'shared',
    'token',
    'delegat',
    'session',
    'skill',
    'orchestrat',
    'decision',
    'human',
    'brief',
    'worker',
    'connect',
    'assign',
  ],
  precision: [
    'cache',
    'retry',
    'keep',
    'clock',
    'focus',
    'safe area',
    'proxy',
    'cap ',
    'lock',
    'fix',
    'timing',
    'exact',
    'sticky',
    'hold',
    'remember',
    'inside',
    'server',
    'settle',
    'without',
  ],
  wayfinding: [
    'move',
    'split',
    'menu',
    'palette',
    'remove',
    'leave',
    'fold',
    'lives',
    'row',
    'sidebar',
    'header',
    'rename',
    'drop',
    'only',
    'own',
    'beside',
    'into',
    'find',
    'window',
    'page',
  ],
  signal: [
    'show',
    'notice',
    'notification',
    'progress',
    'state',
    'tracked',
    'live',
    'icon',
    'tooltip',
    'warn',
    'job',
    'needs you',
    'status',
    'name what',
    'badge',
    'one-read',
    'watch',
  ],
}
export const THEMES = Object.keys(THEME_WORDS)

function hashString(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const lerp = (a, b, t) => a + (b - a) * t
const round = (v, d = 1) => {
  const r = Number(v.toFixed(d))
  return Object.is(r, -0) ? 0 : r
}

/** The notes as numbers: how many items, and the share of each theme among them. */
export function readThemes(notes) {
  const lines = notes
    .split('\n')
    .filter((line) => /^\s*[*-] /.test(line))
    .map((line) => ` ${line.replace(/ by @\S+ in https?:\/\/\S+/, '').toLowerCase()} `)
  const counts = Object.fromEntries(THEMES.map((t) => [t, 0]))
  for (const line of lines) {
    for (const theme of THEMES) if (THEME_WORDS[theme].some((stem) => line.includes(stem))) counts[theme]++
  }
  const total = THEMES.reduce((sum, t) => sum + counts[t], 0) || 1
  const shares = Object.fromEntries(THEMES.map((t) => [t, counts[t] / total]))
  return { items: lines.length, counts, shares }
}

/**
 * Whether two cuts meet near an end of either: a V (or an L, or a T) reads as an arrow, a corner,
 * a thing. Two cuts may cross in their middles (an X) or not meet at all. Parallel cuts never meet.
 */
export function meetsAtEnd(p, q) {
  const seg = (s) => {
    const a = (s.angle * Math.PI) / 180
    const h = s.length / 2
    return [s.x - Math.cos(a) * h, s.y - Math.sin(a) * h, Math.cos(a) * s.length, Math.sin(a) * s.length]
  }
  const [px, py, rx, ry] = seg(p)
  const [qx, qy, sx, sy] = seg(q)
  const denom = rx * sy - ry * sx
  if (Math.abs(denom) < 1e-6 * p.length * q.length) return false
  const t = ((qx - px) * sy - (qy - py) * sx) / denom
  const u = ((qx - px) * ry - (qy - py) * rx) / denom
  const near = (v) => v > -0.12 && v < 1.12 && (v < 0.24 || v > 0.76)
  const inside = (v) => v >= -0.12 && v <= 1.12
  return inside(t) && inside(u) && (near(t) || near(u))
}

/**
 * The composition, before any drawing: a list of passes. Each pass is one cut edge and the spray
 * off it. Everything here is plain numbers, so the manifest can record it.
 */
export function planPiece(version, themes, seed = hashString(version)) {
  const rand = mulberry32(seed)
  const pick = (lo, hi) => lerp(lo, hi, rand())
  const { agency, precision, wayfinding, signal } = themes.shares
  // How far the release reaches: a long release has more hands in it.
  const reach = clamp(Math.log2(Math.max(2, themes.items)) / 7, 0, 1)

  // The piece's grain: the one direction every cut leans toward, never level (a level edge reads as a horizon).
  const lean = (rand() < 0.5 ? -1 : 1) * pick(14, 30)
  // The counter-lean crosses it at a wide, fixed-ish angle, kept within 40 degrees of level.
  const counter = clamp(lean - Math.sign(lean) * pick(42, 54), -40, 40)
  // Which way the spray drifts off the cuts, mostly: away from the calm side of the card.
  const drift = rand() < 0.5 ? 1 : -1

  const order = Math.max(precision, wayfinding)
  const count = clamp(Math.round(2 + reach * 4 + agency * 6 - precision * 3), 3, 9)
  const stepped = wayfinding >= 0.28 && wayfinding >= agency
  const wander = lerp(2, 12, clamp(agency * 1.6 + reach * 0.4 - precision * 0.9, 0, 1)) * (stepped ? 0.5 : 1)
  const falloff = lerp(250, 105, clamp(precision * 1.7, 0, 1))
  const echoes = clamp(Math.round((signal - 0.18) * 20), 0, 3)
  const bare = clamp(0.18 + wayfinding * 0.5 + precision * 0.3 - agency * 0.3, 0.18, 0.42)
  const arcs = clamp(Math.round(wayfinding * 2.5 - precision), 0, 2)
  // How often a pass crosses another: many hands cross, a precise or a stepped release never does.
  const crossing = stepped ? 0 : clamp((agency - precision * 0.5) * 1.6, 0, 0.6)

  // The calm side: the third of the card that stays bare ground. It never takes an anchor.
  const calm = rand() < 0.5 ? 'left' : 'right'
  const usable = { x0: calm === 'left' ? WIDTH * bare : 0, x1: calm === 'left' ? WIDTH : WIDTH * (1 - bare) }

  // Each pass gets its own column and its own row of the usable card, shuffled, so the hands
  // spread over it instead of piling into one band.
  const shuffled = () => {
    const list = Array.from({ length: count }, (_, i) => i)
    for (let i = count - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[list[i], list[j]] = [list[j], list[i]]
    }
    return list
  }
  const slots = shuffled()
  const rows = shuffled()
  // Which passes cross: a set number, from the notes, never left to a coin toss. They are the
  // last ones laid, so there are hosts to cross.
  const crossings = Math.round(crossing * count)
  const passes = []
  for (let i = 0; i < count; i++) {
    const isArc = i >= 1 && i <= arcs
    // A pass is drawn again (up to two dozen times) while it would meet another near an end.
    let pass
    for (let attempt = 0; attempt < 24; attempt++) {
      pass = drawPass(i, isArc)
      if (!passes.some((other) => meetsAtEnd(pass, other))) break
    }
    passes.push(pass)
  }

  function drawPass(i, isArc) {
    const t = count === 1 ? 0.5 : i / (count - 1)
    let cx
    let cy
    if (stepped) {
      // The card was moved along a path: anchors step evenly across the usable width, each one
      // a stair lower (or higher) than the last.
      cx = lerp(usable.x0 + 120, usable.x1 - 120, t) + pick(-30, 30)
      cy = lerp(HEIGHT * 0.22, HEIGHT * 0.78, drift > 0 ? t : 1 - t) + pick(-25, 25)
    } else {
      // Spread across the usable width in even slots, so no corner takes every hand.
      const slot = (usable.x1 - usable.x0 - 200) / count
      cx = usable.x0 + 100 + slot * (slots[i] + rand())
      cy = HEIGHT * 0.16 + ((HEIGHT * 0.68) / count) * (rows[i] + rand())
    }
    // Many hands cross: some passes take the counter-lean instead, never the free angle in
    // between (a near-vertical cut over a level one starts to read as a thing standing on ground).
    // A crossing pass is anchored part-way along an earlier one, so the two make an X.
    const crossed = i > arcs && i >= count - crossings
    if (crossed) {
      const along = passes.filter((p) => p.kind === 'cut' && !p.crossed)
      const host = along[Math.floor(rand() * along.length)]
      const a = (host.angle * Math.PI) / 180
      const t = pick(-0.22, 0.22) * host.length
      cx = clamp(host.x + Math.cos(a) * t, 80, WIDTH - 80)
      cy = clamp(host.y + Math.sin(a) * t, 80, HEIGHT - 80)
    }
    const angle = (crossed ? counter : lean) + (rand() - 0.5) * 2 * wander
    // Most sprays drift the same way; a release with many hands has some drifting back.
    const side = rand() < 0.15 + agency * 0.5 ? -drift : drift
    const length = pick(0.55, 1.05) * (stepped ? 700 : lerp(1100, 650, agency)) * (isArc ? 1.2 : 1)
    const hard = pick(0.78, 1.0)
    return {
      kind: isArc ? 'arc' : 'cut',
      crossed,
      ink: i === 0 ? 'A' : rand() < 0.22 + agency * 0.45 ? 'B' : 'A',
      x: round(cx),
      y: round(cy),
      angle: round(angle, 2),
      side,
      length: round(length),
      falloff: round(falloff * pick(0.8, 1.3) * (precision > 0.3 ? 0.8 : 1)),
      hard: round(hard, 2),
      bend: isArc ? round((rand() < 0.5 ? -1 : 1) * pick(2800, 4400)) : 0,
      echoes: i % 2 === 0 || echoes > 2 ? echoes : Math.max(0, echoes - 1),
    }
  }
  // At least one pass in the second ink, never the first one: the accent is held, not leading.
  if (!passes.some((p) => p.ink === 'B')) passes[passes.length - 1].ink = 'B'

  return {
    version,
    seed,
    lean: round(lean, 2),
    counter: round(counter, 2),
    drift,
    calm,
    bare: round(bare, 2),
    wander: round(wander, 1),
    stepped,
    echoes,
    order: round(order, 2),
    passes,
    noiseSeed: seed % 997,
  }
}

// --- drawing ---------------------------------------------------------------------------------

function pt(x, y) {
  return `${round(x)} ${round(y)}`
}

/** The ground the spray covers past one cut: a polygon from the cut out to its full falloff. */
function cutGeometry(pass, offset) {
  const a = (pass.angle * Math.PI) / 180
  const u = [Math.cos(a), Math.sin(a)]
  const n = [-u[1] * pass.side, u[0] * pass.side]
  const ox = pass.x + n[0] * offset
  const oy = pass.y + n[1] * offset
  const h = pass.length / 2
  const d = pass.falloff
  const p0 = [ox - u[0] * h, oy - u[1] * h]
  const p1 = [ox + u[0] * h, oy + u[1] * h]
  const path = `M${pt(...p0)}L${pt(...p1)}L${pt(p1[0] + n[0] * d, p1[1] + n[1] * d)}L${pt(p0[0] + n[0] * d, p0[1] + n[1] * d)}Z`
  return {
    path,
    across: { x1: ox, y1: oy, x2: ox + n[0] * d, y2: oy + n[1] * d },
    along: { x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1] },
  }
}

/** An arc: a cut on a circle of radius |bend| whose centre lies on the far side of the card. */
function arcGeometry(pass, offset) {
  const a = (pass.angle * Math.PI) / 180
  const u = [Math.cos(a), Math.sin(a)]
  const n = [-u[1] * pass.side, u[0] * pass.side]
  const r = Math.abs(pass.bend)
  // Bending away from the spray (convex toward it) or into it.
  const toward = pass.bend > 0 ? 1 : -1
  const cx = pass.x - n[0] * r * toward + n[0] * offset
  const cy = pass.y - n[1] * r * toward + n[1] * offset
  const half = pass.length / 2 / r
  const mid = Math.atan2(pass.y + n[1] * offset - cy, pass.x + n[0] * offset - cx)
  const inner = toward > 0 ? r : r - pass.falloff
  const outer = toward > 0 ? r + pass.falloff : r
  const at = (rad, ang) => [cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad]
  const s0 = at(outer, mid - half)
  const s1 = at(outer, mid + half)
  const e1 = at(inner, mid + half)
  const e0 = at(inner, mid - half)
  const path =
    `M${pt(...s0)}A${round(outer)} ${round(outer)} 0 0 1 ${pt(...s1)}` +
    `L${pt(...e1)}A${round(inner)} ${round(inner)} 0 0 0 ${pt(...e0)}Z`
  const ends = [at(r, mid - half), at(r, mid + half)]
  return {
    path,
    radial: { cx, cy, r: outer, from: inner / outer, outward: toward > 0 },
    along: { x1: ends[0][0], y1: ends[0][1], x2: ends[1][0], y2: ends[1][1] },
  }
}

// How an airbrush lays pigment past a cut: full at the edge, falling off quickly, a long thin tail.
const FALLOFF = [
  [0, 1],
  [0.1, 0.96],
  [0.24, 0.62],
  [0.48, 0.26],
  [0.74, 0.08],
  [1, 0],
]

function stops(scale, reverse = false, from = 0) {
  const list = FALLOFF.map(([o, v]) => [from + (reverse ? 1 - o : o) * (1 - from), v * scale])
  if (reverse) list.reverse()
  return list.map(([o, v]) => `<stop offset="${round(o, 3)}" stop-opacity="${round(v, 3)}"/>`).join('')
}

// Along the edge the sweep starts and ends softly, where the brush came on and went off.
const SWEEP =
  '<stop offset="0" stop-color="#FFFFFF" stop-opacity="0"/><stop offset="0.18" stop-color="#FFFFFF"/><stop offset="0.8" stop-color="#FFFFFF"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>'

function passMarkup(pass, index, ink) {
  const defs = []
  const body = []
  // The pass itself, then its echoes: the card slid on and sprayed again, each time lighter.
  for (let e = 0; e <= pass.echoes; e++) {
    const id = `p${index}e${e}`
    const offset = e * pass.falloff * 0.42
    const strength = pass.hard * Math.pow(0.62, e)
    const g = pass.kind === 'arc' ? arcGeometry(pass, offset) : cutGeometry(pass, offset)
    if (pass.kind === 'arc') {
      const { cx, cy, r, from, outward } = g.radial
      defs.push(
        `<radialGradient id="${id}f" gradientUnits="userSpaceOnUse" cx="${round(cx)}" cy="${round(cy)}" r="${round(r)}">` +
          `${stops(strength, !outward, outward ? from : from).replace(/stop-opacity/g, `stop-color="${ink}" stop-opacity`)}</radialGradient>`,
      )
    } else {
      const { x1, y1, x2, y2 } = g.across
      defs.push(
        `<linearGradient id="${id}f" gradientUnits="userSpaceOnUse" x1="${round(x1)}" y1="${round(y1)}" x2="${round(x2)}" y2="${round(y2)}">` +
          `${stops(strength).replace(/stop-opacity/g, `stop-color="${ink}" stop-opacity`)}</linearGradient>`,
      )
    }
    const { x1, y1, x2, y2 } = g.along
    defs.push(
      `<linearGradient id="${id}s" gradientUnits="userSpaceOnUse" x1="${round(x1)}" y1="${round(y1)}" x2="${round(x2)}" y2="${round(y2)}">${SWEEP}</linearGradient>`,
      `<mask id="${id}m" maskUnits="userSpaceOnUse" x="0" y="0" width="${WIDTH}" height="${HEIGHT}"><path d="${g.path}" fill="url(#${id}s)"/></mask>`,
    )
    body.push(`<path d="${g.path}" fill="url(#${id}f)" mask="url(#${id}m)"/>`)
  }
  return { defs, body }
}

function filters(plan, variant) {
  const s = plan.noiseSeed
  const { frequency, octaves, spread, edgeWobble, edgeFrequency } = SPRAY
  // Spray: pigment alpha against droplet noise. A droplet lands where the pigment is denser than
  // the noise there, so density, not opacity, carries the falloff: the ink is always solid.
  const spray = (id, colour, seed) =>
    `<filter id="${id}" filterUnits="userSpaceOnUse" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" color-interpolation-filters="sRGB">` +
    `<feTurbulence type="fractalNoise" baseFrequency="${edgeFrequency}" numOctaves="2" seed="${seed + 7}" result="w"/>` +
    `<feDisplacementMap in="SourceAlpha" in2="w" scale="${edgeWobble * 2}" xChannelSelector="R" yChannelSelector="G" result="cut"/>` +
    `<feTurbulence type="fractalNoise" baseFrequency="${frequency}" numOctaves="${octaves}" seed="${seed}" result="n"/>` +
    `<feColorMatrix in="n" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${spread} 0 0 0 ${round(0.5 - spread / 2, 3)}" result="d"/>` +
    `<feComposite in="cut" in2="d" operator="arithmetic" k2="1" k3="-1" k4="0.5" result="m"/>` +
    `<feComponentTransfer in="m"><feFuncA type="linear" slope="24" intercept="-11.5"/></feComponentTransfer>` +
    `<feComposite in2="cut" operator="in" result="dots"/>` +
    `<feFlood flood-color="${colour}"/><feComposite in2="dots" operator="in"/></filter>`
  // The ground's own grain: sparse round flecks (never streaks: fibres alias into scanlines when
  // the card scales the piece down) over a faint, slow mottle.
  const grain =
    `<filter id="grain" filterUnits="userSpaceOnUse" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" color-interpolation-filters="sRGB">` +
    `<feTurbulence type="fractalNoise" baseFrequency="0.55" numOctaves="1" seed="${s + 31}" result="n"/>` +
    `<feColorMatrix in="n" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 9 0 0 0 -5.9"/>` +
    `<feComponentTransfer result="fa"><feFuncA type="discrete" tableValues="0 0 0 0.55"/></feComponentTransfer>` +
    `<feTurbulence type="fractalNoise" baseFrequency="0.004 0.006" numOctaves="3" seed="${s + 3}"/>` +
    `<feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.5 0 0 0 -0.19"/>` +
    `<feComposite in2="fa" operator="over" result="all"/>` +
    `<feFlood flood-color="${variant.fleck}"/><feComposite in2="all" operator="in"/></filter>`
  return [spray('sprayA', variant.inkA, s), spray('sprayB', variant.inkB, s + 101), grain]
}

function piece(plan, mode) {
  const variant = VARIANTS[mode]
  const defs = filters(plan, variant)
  const groups = { A: [], B: [] }
  plan.passes.forEach((pass, i) => {
    const { defs: d, body } = passMarkup(pass, i, '#000000')
    defs.push(...d)
    groups[pass.ink].push(...body)
  })
  const label = `Release artwork for ${plan.version}, ${mode}: ${plan.passes.length} sprayed stencil edges.`
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-labelledby="t d">`,
    `<title id="t">${plan.version}</title>`,
    `<desc id="d">${label}</desc>`,
    `<defs>${defs.join('')}</defs>`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${variant.ground}"/>`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="#000000" filter="url(#grain)"/>`,
    `<g style="mix-blend-mode:${variant.blend};isolation:auto" filter="url(#sprayA)">${groups.A.join('')}</g>`,
    `<g style="mix-blend-mode:${variant.blend}" filter="url(#sprayB)">${groups.B.join('')}</g>`,
    `</svg>`,
    '',
  ].join('\n')
}

export function renderRelease(version, notes) {
  const themes = readThemes(notes)
  const plan = planPiece(version, themes)
  return { themes, plan, light: piece(plan, 'light'), dark: piece(plan, 'dark') }
}

// --- command line ----------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {}
  const value = (i, flag) => {
    const v = argv[i + 1]
    if (v === undefined || v === '' || v.startsWith('--')) throw new Error(`${flag} needs a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--out' || flag === '--version' || flag === '--notes') {
      args[flag.slice(2)] = value(i, flag)
      i++
    } else throw new Error(`Unknown argument: ${flag}`)
  }
  if ((args.version === undefined) !== (args.notes === undefined))
    throw new Error('--version and --notes go together')
  return args
}

function versionKey(v) {
  return v
    .replace(/^v/, '')
    .split('.')
    .map((n) => Number(n))
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exit(2)
  }
  const outDir = resolve(args.out ?? ASSET_DIR)
  mkdirSync(outDir, { recursive: true })

  if (args.version) {
    const r = renderRelease(args.version, readFileSync(args.notes, 'utf8'))
    writeFileSync(join(outDir, `${args.version}-light.svg`), r.light)
    writeFileSync(join(outDir, `${args.version}-dark.svg`), r.dark)
    console.log(`Wrote ${args.version} (light, dark) to ${outDir}; manifest.json left as it was`)
    return
  }

  const versions = readdirSync(NOTES_DIR)
    .filter((f) => /^v\d+\.\d+\.\d+\.md$/.test(f))
    .map((f) => f.replace(/\.md$/, ''))
    .sort((a, b) => {
      const ka = versionKey(a)
      const kb = versionKey(b)
      return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2]
    })
  const releases = []
  for (const version of versions) {
    const r = renderRelease(version, readFileSync(join(NOTES_DIR, `${version}.md`), 'utf8'))
    writeFileSync(join(outDir, `${version}-light.svg`), r.light)
    writeFileSync(join(outDir, `${version}-dark.svg`), r.dark)
    releases.push({
      version,
      files: { light: `${version}-light.svg`, dark: `${version}-dark.svg` },
      items: r.themes.items,
      themes: Object.fromEntries(THEMES.map((t) => [t, round(r.themes.shares[t], 3)])),
      plan: r.plan,
    })
  }
  const manifest = {
    direction: 'pochoir',
    generator: 'scripts/release-art/pochoir.mjs',
    madeBy: 'Claude Opus 5.5 (medium effort)',
    canvas: { width: WIDTH, height: HEIGHT },
    palette: {
      hexes: PALETTE_HEXES,
      light: {
        ground: VARIANTS.light.ground,
        inkA: VARIANTS.light.inkA,
        inkB: VARIANTS.light.inkB,
        fleck: VARIANTS.light.fleck,
      },
      dark: {
        ground: VARIANTS.dark.ground,
        inkA: VARIANTS.dark.inkA,
        inkB: VARIANTS.dark.inkB,
        fleck: VARIANTS.dark.fleck,
      },
    },
    spray: SPRAY,
    releases,
  }
  // Written as the repo's prettier writes JSON, so the generated file passes the format check as is.
  const manifestPath = join(outDir, 'manifest.json')
  const prettier = await import('prettier')
  const options = {
    ...(await prettier.resolveConfig(join(ASSET_DIR, 'manifest.json'))),
    filepath: manifestPath,
  }
  writeFileSync(manifestPath, await prettier.format(JSON.stringify(manifest), options))
  console.log(`Wrote ${releases.length * 2} pieces and manifest.json to ${outDir}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
