#!/usr/bin/env node
// Release artwork: palimpsest.
//
// A piece is a sheet drawn with the flat side of a conté stick: a few broad, blunt-ended swaths
// whose pigment catches only on the paper's tooth, heavier where the hand pressed, streaked along
// the way the stick was dragged. Under them is the previous release's piece, rubbed out: its
// swaths survive as a pale, smudged ghost, cut through by the clean streaks the eraser left. The
// series remembers itself: each release is what was drawn over the one before.
//
// The release's notes are read for four themes (many hands, precision, wayfinding and how much of
// the past it carries over), and the version seeds every remaining choice, so the same version and
// notes write the same bytes on every run. A release nobody has seen needs only its notes file.
//
// Usage:
//   node scripts/release-art/palimpsest.mjs                      # regenerate the committed series
//   node scripts/release-art/palimpsest.mjs --out /tmp/art       # write somewhere else
//
// To draw the next release:
//   gh release view vX.Y.Z --json body --jq .body > scripts/release-art/notes/vX.Y.Z.md
//   node scripts/release-art/palimpsest.mjs
// Its ghost is the release before it in that folder, drawn from that release's own notes.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const NOTES_DIR = join(ROOT, 'scripts/release-art/notes')
const ASSET_DIR = join(ROOT, 'src/assets/release-art/palimpsest')

export const WIDTH = 1600
export const HEIGHT = 900

// Ground, the ground where the eraser cleaned it, and two conté colours. Nothing else is drawn.
// The dark sheet is a black paper with pale sticks; the roles stay the same.
export const PALETTE = {
  light: { ground: '#ECE5D8', cleaned: '#F4EFE5', ink: '#28304F', spot: '#B4532F' },
  dark: { ground: '#17181D', cleaned: '#101115', ink: '#C9CFE6', spot: '#E2875C' },
}
export const PALETTE_HEXES = [...Object.values(PALETTE.light), ...Object.values(PALETTE.dark)]

const VARIANTS = {
  light: {
    blend: 'multiply',
    inkOpacity: 0.86,
    spotOpacity: 0.9,
    ghostOpacity: 0.42,
    paperGrain: 0.07,
    cleanedOpacity: 0.85,
  },
  dark: {
    blend: 'screen',
    inkOpacity: 0.7,
    spotOpacity: 0.8,
    ghostOpacity: 0.36,
    paperGrain: 0.08,
    cleanedOpacity: 0.8,
  },
}

// ---------------------------------------------------------------------------------------------
// Seeds

function hash(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function seedFor(version) {
  return hash(`palimpsest:${version}`)
}

function rng(seed) {
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
const f = (n) => {
  const s = (Math.round(n * 10) / 10).toFixed(1)
  return s.endsWith('.0') ? s.slice(0, -2) : s
}
const f2 = (n) => (Math.round(n * 100) / 100).toString()

// ---------------------------------------------------------------------------------------------
// Reading a release

const WORDS = {
  hands: [
    'agent',
    'agents',
    'lane',
    'lanes',
    'shared',
    'share',
    'review',
    'reviews',
    'reviewer',
    'delegat',
    'orchestrat',
    'session',
    'decision',
    'connected',
    'connect',
    'queue',
    'assigned',
    'worker',
    'token',
    'tokens',
    'human',
    'replies',
    'posts',
    'cloud',
    'skills',
    'skill',
    'brief',
  ],
  precision: [
    'focus',
    'ring',
    'rings',
    'cache',
    'retry',
    'retries',
    'clock',
    'safe',
    'proxy',
    'sticky',
    'cap',
    'keep',
    'keeps',
    'fix',
    'lock',
    'timing',
    'settle',
    'exact',
    'stall',
    'inside',
    'cleanly',
    'check',
    'idle',
    'headroom',
    'forward',
    'forwarding',
    'websocket',
  ],
  wayfinding: [
    'move',
    'moved',
    'split',
    'remove',
    'removed',
    'menu',
    'palette',
    'into',
    'fold',
    'leave',
    'lives',
    'rename',
    'renamed',
    'section',
    'order',
    'header',
    'filter',
    'beside',
    'put',
    'drop',
    'only',
    'window',
    'selector',
    'step',
    'one-read',
  ],
}

function itemsOf(notes) {
  return notes
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('* ') || line.startsWith('- '))
    .map((line) =>
      line
        .slice(2)
        .replace(/\s+by @\S+.*$/, '')
        .replace(/https?:\/\/\S+/g, '')
        .toLowerCase(),
    )
}

function score(item, words) {
  const tokens = item.split(/[^a-z0-9-]+/).filter(Boolean)
  let n = 0
  for (const token of tokens) if (words.some((w) => token === w || (w.length > 5 && token.startsWith(w)))) n++
  return n
}

// Themes are shares (hands + precision + wayfinding = 1), plus volume (how much the release
// says, 0-1) and carry (the share of its items that are earlier releases folded back in).
export function readThemes(notes) {
  const items = itemsOf(notes)
  const own = items.filter((item) => !/^release\b/.test(item))
  const carried = items.length - own.length
  let hands = 0.4
  let precision = 0.4
  let wayfinding = 0.4
  for (const item of own) {
    hands += score(item, WORDS.hands)
    precision += score(item, WORDS.precision)
    wayfinding += score(item, WORDS.wayfinding)
  }
  const total = hands + precision + wayfinding
  // Clearing: items whose verb takes something away or puts it elsewhere.
  const clearing = own.length
    ? own.filter((item) => /^(move|split|remove|leave|fold|drop|put|cap|pushed|delete|archive)\b/.test(item))
        .length / own.length
    : 0
  return {
    items: items.length,
    clearing,
    hands: hands / total,
    precision: precision / total,
    wayfinding: wayfinding / total,
    volume: clamp(Math.log2(1 + own.length) / Math.log2(1 + 40), 0, 1),
    carry: items.length ? carried / items.length : 0,
  }
}

export const NEUTRAL = {
  items: 0,
  clearing: 0,
  hands: 1 / 3,
  precision: 1 / 3,
  wayfinding: 1 / 3,
  volume: 0.5,
  carry: 0,
}

// ---------------------------------------------------------------------------------------------
// Composition

// The plan is everything a piece is, before it is drawn: the swaths of this release, and the
// strokes of the eraser that went over the previous one.
export function planPiece(version, themes, seed = seedFor(version), under = []) {
  const r = rng(seed)
  const { hands: h, precision: p, wayfinding: w, volume: v, carry, clearing = 0 } = themes
  const dominant = h >= p && h >= w ? 'hands' : p >= w ? 'precision' : 'wayfinding'

  // One main direction for the hand; never level, never steep.
  const sign = r() < 0.5 ? -1 : 1
  const theta0 = sign * lerp(14, 30, r())
  // How mixed the release is: 0 when one theme leads it, 1 when all three weigh the same. A mixed
  // release is drawn by two hands at once, across each other's grain.
  const mix = clamp(1 - (Math.max(h, p, w) - 1 / 3) / 0.3, 0, 1)
  const crossAngle = theta0 - sign * lerp(34, 46, r())
  const crossShare = mix > 0.55 ? lerp(0.3, 0.45, mix) : 0

  const count = clamp(Math.round(2 + 9 * h * (0.55 + v) + 1.5 * p - 2.5 * w - 5 * clearing), 3, 10)
  const spread = lerp(3, 78, clamp((h - 0.25) * 2.2, 0, 1)) * (1 - 0.7 * p)
  const regular = clamp((p - 0.2) * 2.4, 0, 1)
  const stagger = clamp((w - 0.25) * 2.5, 0, 1)

  const rad = (theta0 * Math.PI) / 180
  const dir = [Math.cos(rad), Math.sin(rad)]
  const nrm = [-dir[1], dir[0]]

  // The swaths sit in a band across the sheet, perpendicular to the hand. A wayfinding release
  // pushes them to one side and leaves the rest bare.
  const cx = WIDTH / 2 + (r() - 0.5) * 260 + stagger * (r() < 0.5 ? -1 : 1) * 220
  const cy = HEIGHT / 2 + (r() - 0.5) * 120
  const bandSpan = lerp(560, 980, clamp(h * 1.6, 0, 1)) * (1 - 0.35 * stagger)
  const meanWidth = lerp(118, 172, p) * (1 - 0.2 * h) * (count > 6 ? 0.85 : 1)
  const meanLength = lerp(700, 1150, p) * (1 - 0.3 * h) * (1 - 0.2 * stagger)

  const spotCount = clamp(Math.round(count * (0.12 + 0.4 * h)), 1, Math.ceil(count / 2))
  const spotSet = new Set()
  while (spotSet.size < spotCount) spotSet.add(Math.floor(r() * count))

  const swaths = []
  for (let i = 0; i < count; i++) {
    const slot = count === 1 ? 0 : i / (count - 1) - 0.5
    const u = lerp((r() - 0.5) * bandSpan, slot * bandSpan, regular)
    const along =
      lerp((r() - 0.5) * 520, 0, regular) + stagger * (slot * 640) + (r() - 0.5) * 60 * (1 - regular)
    const crossing = crossShare > 0 && i % Math.round(1 / crossShare) === 1
    const angle = (crossing ? crossAngle : theta0) + (r() - 0.5) * spread
    const length = clamp(meanLength * lerp(1 + (r() - 0.5) * 0.9, 1 + (r() - 0.5) * 0.12, regular), 260, 1500)
    const width = clamp(meanWidth * lerp(1 + (r() - 0.5) * 0.8, 1 + (r() - 0.5) * 0.1, regular), 40, 210)
    // A swath is always a stroke, never a block: at least three and a bit of its widths long.
    const strokeLength = Math.max(length, width * 3.2)
    const x = cx + nrm[0] * u + dir[0] * along
    const y = cy + nrm[1] * u + dir[1] * along

    // Pressure along the stroke: the stick lands hard, wavers as the hand moves, and lifts.
    const waver = lerp(0.32, 0.08, p)
    const land = lerp(0.74, 0.95, r())
    const stops = [
      [0, land * 0.68],
      [0.05, land],
      [0.22, clamp(land - waver * r(), 0.45, 1)],
      [0.5, clamp(0.9 - waver * (r() * 1.4), 0.4, 1)],
      [0.78, clamp(0.86 - waver * r(), 0.4, 1)],
      [0.93, lerp(0.42, 0.62, r())],
      [1, lerp(0.12, 0.3, r())],
    ]
    swaths.push({
      ink: spotSet.has(i) ? 'spot' : 'ink',
      x,
      y,
      angle,
      length: strokeLength,
      width,
      bow: (r() - 0.5) * lerp(70, 14, p),
      reverse: r() < 0.5,
      edge: r() < 0.5 ? 1 : -1,
      skew: [(r() - 0.5) * 0.7, (r() - 0.5) * 0.7],
      stops,
      wobble: lerp(5, 2, p),
      edgeSeed: Math.floor(r() * 1e6),
    })
  }
  // Draw the spot last within its colour so the order is stable and the accent sits on top.
  swaths.sort((a, b) => (a.ink === b.ink ? 0 : a.ink === 'ink' ? -1 : 1))

  // The eraser: how much of the previous release was rubbed out. Many hands leave the old marks
  // in; a reorganising release clears; a release that folds earlier ones back in barely erases.
  const erase = clamp(0.2 + 1.6 * clearing + 0.5 * w - 0.4 * h - 2.5 * carry, 0.08, 0.95)
  const eraserCount = clamp(Math.round(1 + erase * 7), 1, 8)
  const erasures = []
  for (let i = 0; i < eraserCount; i++) {
    // The eraser goes where the old marks are, rubbing along them, a hand's stroke at a time.
    const target = under.length ? under[Math.floor(r() * under.length)] : null
    const t = r() - 0.5
    const rad = target ? (target.angle * Math.PI) / 180 : 0
    erasures.push({
      x: target ? target.x + Math.cos(rad) * t * target.length * 0.6 : lerp(140, WIDTH - 140, r()),
      y: target ? target.y + Math.sin(rad) * t * target.length * 0.6 : lerp(120, HEIGHT - 120, r()),
      angle: (target ? target.angle : theta0 + 90) + (r() - 0.5) * 36,
      length: lerp(300, 600, r()) * (0.6 + erase * 1.1),
      width: lerp(80, 160, r()),
      strength: Math.min(1, lerp(0.6, 0.95, r()) * (0.45 + 0.6 * erase)),
    })
  }

  return {
    version,
    seed,
    dominant,
    theta0,
    count,
    spread,
    regular,
    stagger,
    erase,
    ghostWeight: clamp(0.82 + 2.2 * carry - 0.25 * erase, 0.5, 1.2),
    mix,
    swaths,
    erasures,
    toothSeed: Math.floor(r() * 997) + 1,
    dragSeed: Math.floor(r() * 997) + 1,
  }
}

// ---------------------------------------------------------------------------------------------
// Drawing

// A swath is drawn in its own frame, along +x from 0 to its length, centred on y = 0, then placed
// with one transform, so the drag streaks run with the stroke.
function swathPath(s, r, edgeOnly = false) {
  const n = 14
  const top = []
  const bottom = []
  const half = s.width / 2
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const x = t * s.length
    const bow = s.bow * Math.sin(Math.PI * t)
    const jt = (r() - 0.5) * s.wobble * 2
    const jb = (r() - 0.5) * s.wobble * 2
    if (edgeOnly) {
      const y0 = s.edge * half
      const inner = s.edge * (half - s.width * 0.28)
      top.push([x, bow + y0 + jt * 0.5])
      bottom.push([x, bow + inner + jb])
    } else {
      top.push([x, bow - half + jt])
      bottom.push([x, bow + half + jb])
    }
  }
  // Blunt, slightly angled ends: the stick's square face meeting the paper at a slant.
  top[0][0] += s.skew[0] * half
  bottom[0][0] -= s.skew[0] * half
  top[n][0] += s.skew[1] * half
  bottom[n][0] -= s.skew[1] * half
  const pts = [...top, ...bottom.reverse()]
  return `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}Z`
}

function swathTransform(s) {
  const rad = (s.angle * Math.PI) / 180
  const x0 = s.x - (Math.cos(rad) * s.length) / 2
  const y0 = s.y - (Math.sin(rad) * s.length) / 2
  return `translate(${f(x0)} ${f(y0)}) rotate(${f(s.angle)})`
}

function gradient(id, s, scale) {
  const stops = s.reverse ? s.stops.map(([t, a]) => [1 - t, a]).reverse() : s.stops
  return (
    `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${f(s.length)}" y2="0">` +
    stops.map(([t, a]) => `<stop offset="${f2(t)}" stop-opacity="${f2(clamp(a * scale, 0, 1))}"/>`).join('') +
    `</linearGradient>`
  )
}

function drawSwaths(swaths, prefix, scale, seed) {
  const r = rng(seed)
  const defs = []
  const body = { ink: [], spot: [] }
  swaths.forEach((s, i) => {
    const id = `${prefix}${i}`
    defs.push(gradient(id, s, scale))
    const edge = clamp(scale * 0.5, 0, 1)
    body[s.ink].push(
      `<g transform="${swathTransform(s)}" filter="url(#drag)">` +
        `<path d="${swathPath(s, r)}" fill="url(#${id})"/>` +
        `<path d="${swathPath(s, r, true)}" fill="#000000" fill-opacity="${f2(edge * 0.55)}"/>` +
        `</g>`,
    )
  })
  return { defs, body }
}

// The tooth: the pigment catches where the paper stands up and the hand pressed hard enough.
// alpha = gain * (pressure + tooth - threshold), then flooded with the stick's colour.
function toothFilter(id, colour, seed, frequency, gain, threshold) {
  return (
    `<filter id="${id}" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">` +
    `<feTurbulence type="fractalNoise" baseFrequency="${frequency}" numOctaves="3" seed="${seed}" result="n"/>` +
    `<feColorMatrix in="n" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1.25 0 0 0 -0.12" result="t"/>` +
    `<feComponentTransfer in="SourceAlpha" result="p"><feFuncA type="linear" slope="0.8"/></feComponentTransfer>` +
    `<feComposite in="p" in2="t" operator="arithmetic" k1="0" k2="${gain}" k3="${gain}" k4="${f2(-gain * threshold)}" result="a"/>` +
    `<feFlood flood-color="${colour}"/>` +
    `<feComposite in2="a" operator="in"/>` +
    `</filter>`
  )
}

function svgFor(version, plan, ghost, variant, notesSummary) {
  const pal = PALETTE[variant]
  const look = VARIANTS[variant]
  const defs = []

  // The drag: streaks along the stroke, and a ragged edge where the stick met the tooth.
  defs.push(
    `<filter id="drag" x="-4%" y="-40%" width="108%" height="180%" color-interpolation-filters="sRGB">` +
      `<feTurbulence type="fractalNoise" baseFrequency="0.006 0.34" numOctaves="2" seed="${plan.dragSeed}" result="s"/>` +
      `<feColorMatrix in="s" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1.25 0 0 0 0.12" result="sa"/>` +
      `<feTurbulence type="fractalNoise" baseFrequency="0.09" numOctaves="2" seed="${plan.dragSeed + 7}" result="e"/>` +
      `<feDisplacementMap in="SourceGraphic" in2="e" scale="14" xChannelSelector="R" yChannelSelector="G" result="d"/>` +
      `<feComposite in="d" in2="sa" operator="in"/>` +
      `</filter>`,
  )
  defs.push(toothFilter('tooth-ink', pal.ink, plan.toothSeed, '0.62', 2.9, 0.9))
  defs.push(toothFilter('tooth-spot', pal.spot, plan.toothSeed + 31, '0.62', 2.9, 0.9))
  defs.push(toothFilter('ghost-ink', pal.ink, plan.toothSeed + 61, '0.55', 2.4, 0.93))
  defs.push(toothFilter('ghost-spot', pal.spot, plan.toothSeed + 91, '0.55', 2.4, 0.93))
  defs.push(
    `<filter id="smudge" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" filterUnits="userSpaceOnUse"><feGaussianBlur stdDeviation="1.6"/></filter>`,
  )
  defs.push(
    `<filter id="feather" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="18"/></filter>`,
  )
  // The sheet's own grain, so the bare ground is paper and not a fill.
  defs.push(
    `<filter id="paper" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">` +
      `<feTurbulence type="fractalNoise" baseFrequency="0.9 0.75" numOctaves="2" seed="${plan.toothSeed + 5}" result="n"/>` +
      `<feColorMatrix in="n" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 3.2 0 0 0 -1.45" result="a"/>` +
      `<feFlood flood-color="${pal.ink}"/>` +
      `<feComposite in2="a" operator="in"/>` +
      `</filter>`,
  )

  // The eraser's strokes: a mask over the ghost, and the cleaner ground it left behind.
  const eraserShapes = plan.erasures
    .map((e) => {
      const rad = (e.angle * Math.PI) / 180
      const x0 = e.x - (Math.cos(rad) * e.length) / 2
      const y0 = e.y - (Math.sin(rad) * e.length) / 2
      return { e, transform: `translate(${f(x0)} ${f(y0)}) rotate(${f(e.angle)})` }
    })
    .map(
      ({ e, transform }) =>
        `<rect transform="${transform}" x="0" y="${f(-e.width / 2)}" width="${f(e.length)}" height="${f(e.width)}" rx="${f(e.width / 2)}" fill-opacity="${f2(e.strength)}"/>`,
    )
    .join('')
  defs.push(
    `<mask id="erased" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" maskUnits="userSpaceOnUse">` +
      `<rect width="${WIDTH}" height="${HEIGHT}" fill="#FFFFFF"/>` +
      `<g fill="#000000" filter="url(#feather)">${eraserShapes}</g>` +
      `</mask>`,
  )

  const ghostLayer = drawSwaths(ghost.swaths, 'g', ghost.weight, plan.seed ^ 0x51ed)
  const nowLayer = drawSwaths(plan.swaths, 's', 1, plan.seed ^ 0x2b)
  defs.push(...ghostLayer.defs, ...nowLayer.defs)

  const layer = (filter, body, opacity, blend) =>
    body.length
      ? `<g style="mix-blend-mode:${blend}" opacity="${f2(opacity)}"><g filter="url(#${filter})">${body.join('')}</g></g>`
      : ''

  const title = `CrossBoard ${version}`
  const desc = `Abstract artwork for release ${version}: broad conté swaths over the erased ghost of the release before. ${notesSummary}`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="t d">` +
    `<title id="t">${title}</title><desc id="d">${desc}</desc>` +
    `<defs>${defs.join('')}</defs>` +
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${pal.ground}"/>` +
    `<g style="isolation:isolate">` +
    `<g opacity="${f2(look.ghostOpacity)}" mask="url(#erased)"><g filter="url(#smudge)">` +
    layer('ghost-ink', ghostLayer.body.ink, 1, 'normal') +
    layer('ghost-spot', ghostLayer.body.spot, 0.9, 'normal') +
    `</g></g>` +
    `<g fill="${pal.cleaned}" opacity="${f2(look.cleanedOpacity)}" filter="url(#feather)">${eraserShapes}</g>` +
    `<rect width="${WIDTH}" height="${HEIGHT}" filter="url(#paper)" opacity="${f2(look.paperGrain)}"/>` +
    layer('tooth-ink', nowLayer.body.ink, look.inkOpacity, look.blend) +
    layer('tooth-spot', nowLayer.body.spot, look.spotOpacity, look.blend) +
    `</g></svg>\n`
  )
}

// ---------------------------------------------------------------------------------------------
// The series

function versionKey(v) {
  return v
    .replace(/^v/, '')
    .split('.')
    .map((n) => Number(n))
}

function compareVersions(a, b) {
  const ka = versionKey(a)
  const kb = versionKey(b)
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (ka[i] ?? 0) - (kb[i] ?? 0)
    if (d) return d
  }
  return 0
}

function previousVersion(version) {
  const [major, minor, patch] = versionKey(version)
  if (patch > 0) return `v${major}.${minor}.${patch - 1}`
  if (minor > 0) return `v${major}.${minor - 1}.9`
  return `v${Math.max(0, major - 1)}.9.9`
}

export function listReleases(dir = NOTES_DIR) {
  return readdirSync(dir)
    .filter((file) => /^v\d+\.\d+\.\d+\.md$/.test(file))
    .map((file) => file.slice(0, -3))
    .sort(compareVersions)
}

// A release's ghost is the release before it in the notes folder; the first release in the
// folder gets the one before it by number, drawn from neutral themes (a sheet that was used).
export function seriesPlans(dir = NOTES_DIR) {
  const versions = listReleases(dir)
  return versions.map((version, index) => {
    const themes = readThemes(readFileSync(join(dir, `${version}.md`), 'utf8'))
    const prev = index > 0 ? versions[index - 1] : previousVersion(version)
    const prevThemes = index > 0 ? readThemes(readFileSync(join(dir, `${prev}.md`), 'utf8')) : NEUTRAL
    const ghostPlan = planPiece(prev, prevThemes)
    const plan = planPiece(version, themes, seedFor(version), ghostPlan.swaths)
    return {
      version,
      themes,
      plan,
      ghost: { version: prev, swaths: ghostPlan.swaths, weight: plan.ghostWeight },
    }
  })
}

function summarise(themes) {
  const pct = (n) => `${Math.round(n * 100)}%`
  return `Read as ${pct(themes.hands)} many hands, ${pct(themes.precision)} precision, ${pct(themes.wayfinding)} wayfinding.`
}

export function renderSeries(dir = NOTES_DIR) {
  const files = {}
  const releases = []
  for (const { version, themes, plan, ghost } of seriesPlans(dir)) {
    for (const variant of ['light', 'dark']) {
      files[`${version}-${variant}.svg`] = svgFor(version, plan, ghost, variant, summarise(themes))
    }
    releases.push({
      version,
      seed: plan.seed,
      ghostOf: ghost.version,
      themes: {
        items: themes.items,
        hands: Number(themes.hands.toFixed(3)),
        precision: Number(themes.precision.toFixed(3)),
        wayfinding: Number(themes.wayfinding.toFixed(3)),
        volume: Number(themes.volume.toFixed(3)),
        carry: Number(themes.carry.toFixed(3)),
        clearing: Number(themes.clearing.toFixed(3)),
      },
      reading: plan.dominant,
      mix: Number(plan.mix.toFixed(2)),
      swaths: plan.count,
      spotSwaths: plan.swaths.filter((s) => s.ink === 'spot').length,
      handAngle: Number(plan.theta0.toFixed(1)),
      angleSpread: Number(plan.spread.toFixed(1)),
      regularity: Number(plan.regular.toFixed(2)),
      stagger: Number(plan.stagger.toFixed(2)),
      erased: Number(plan.erase.toFixed(2)),
      eraserStrokes: plan.erasures.length,
      ghostWeight: Number(plan.ghostWeight.toFixed(2)),
      files: { light: `${version}-light.svg`, dark: `${version}-dark.svg` },
    })
  }
  const manifest = {
    direction: 'palimpsest',
    madeBy: 'Claude Opus 5.5 (medium effort)',
    generator: 'scripts/release-art/palimpsest.mjs',
    canvas: { width: WIDTH, height: HEIGHT },
    palette: PALETTE,
    releases,
  }
  files['manifest.json'] = `${JSON.stringify(manifest, null, 2)}\n`
  return files
}

function main(argv) {
  let out = ASSET_DIR
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = resolve(argv[++i] ?? '')
    else throw new Error(`unknown argument: ${argv[i]}`)
  }
  const files = renderSeries()
  mkdirSync(out, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(out, name), content)
  for (const [name, content] of Object.entries(files)) {
    process.stdout.write(`${name}  ${(Buffer.byteLength(content) / 1024).toFixed(1)} KB\n`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  }
}
