#!/usr/bin/env node
// Release artwork: Tracks. Made by Claude Fable 5.2.
//
// A plate that recorded what passed through it. Nothing is drawn but paths: each one is a row of
// beads, bent by a field nobody sees. One rule moves every trail: it turns at a rate set by how
// much momentum it has left, and it loses momentum as it goes. A trail with plenty crosses the plate
// almost straight; one with little winds into a coil and stops. Which way a trail bends decides
// its ink, so the two colours are the two signs and never a decoration.
//
// The release's notes are read for four themes, and each theme is one way of loading the plate:
//   hands    forks: one trail arrives, several leave
//   holding  orbits that keep their radius, and ruled passes at an even pitch
//   route    one tight bundle that the field sorts into lanes
//   flight   a beam of fast passes, each shedding small curls
// The strongest theme sets the plate, the second one adds a few trails of its own, and the version
// seeds every remaining choice. The same version and notes write the same bytes on every run.
//
// Usage:
//   node scripts/release-art/tracks.mjs                      # regenerate the committed series
//   node scripts/release-art/tracks.mjs --out /tmp/art       # write somewhere else
//   node scripts/release-art/tracks.mjs --version v0.3.0 \
//     --notes scripts/release-art/notes/v0.3.0.md --out /tmp/art
//
// To draw the next release:
//   gh release view vX.Y.Z --json body --jq .body > scripts/release-art/notes/vX.Y.Z.md
//   node scripts/release-art/tracks.mjs

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const NOTES_DIR = join(ROOT, 'scripts/release-art/notes')
const ASSET_DIR = join(ROOT, 'src/assets/release-art/tracks')

export const WIDTH = 1600
export const HEIGHT = 900
const MARGIN = 70

// Three bead sizes, by how much momentum the trail has left: a slow trail leaves a heavier mark.
// `pitch` is the distance between bead centres as a multiple of the bead's width.
export const BEADS = {
  widths: [4.6, 6, 7.8],
  pitch: 1.36,
  momentum: [150, 55],
}

// Paper and ink grounds, one neutral for the trails that do not bend, and one ink per sign.
export const PALETTE = {
  light: { ground: '#ECE7DA', neutral: '#2B3036', minus: '#1B7F7A', plus: '#C9621B' },
  dark: { ground: '#12191D', neutral: '#DED8C8', minus: '#56BDB0', plus: '#EDA13A' },
}
export const PALETTE_HEXES = [...Object.values(PALETTE.light), ...Object.values(PALETTE.dark)]

const VARIANTS = {
  light: { mottle: 0.1, grain: 0.3, stray: 0.6, scratch: 0.16, opacity: [0.9, 0.95, 1] },
  dark: { mottle: 0.16, grain: 0.25, stray: 0.5, scratch: 0.13, opacity: [0.88, 0.95, 1] },
}

// Word stems, matched at the start of a word. A line of the notes counts once per theme.
export const THEME_WORDS = {
  hands: [
    'agent',
    'share',
    'lane',
    'delegat',
    'review',
    'decision',
    'orchestrat',
    'worker',
    'hand-off',
    'reply',
    'replies',
    'ask',
    'team',
    'queue',
    'post',
    'verdict',
    'brief',
  ],
  holding: [
    'keep',
    'cache',
    'cap',
    'focus',
    'ring',
    'safe',
    'sticky',
    'proxy',
    'clock',
    'count',
    'remember',
    'serve',
    'hold',
    'inside',
    'paint',
    'draw',
    'forward',
  ],
  route: [
    'split',
    'move',
    'remove',
    'menu',
    'palette',
    'fold',
    'leave',
    'window',
    'across',
    'row',
    'rename',
    'sidebar',
    'module',
    'default',
    'lives',
    'only',
    'find',
  ],
  flight: [
    'progress',
    'job',
    'speed',
    'remote',
    'notification',
    'tracked',
    'run',
    'state',
    'stall',
    'idle',
    'connection',
    'retry',
    'long',
    'download',
    'start',
    'stop',
    'update',
    'alive',
    'live',
  ],
}
export const THEMES = Object.keys(THEME_WORDS)

// ---------------------------------------------------------------------------------------------
// Seed and numbers

export function seedOf(version) {
  let hash = 0x811c9dc5
  for (const char of version) {
    hash ^= char.codePointAt(0)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function randomOf(seed) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const between = (low, high) => low + (high - low) * next()
  return {
    next,
    between,
    int: (low, high) => Math.floor(between(low, high + 1)),
    sign: () => (next() < 0.5 ? -1 : 1),
    pick: (list) => list[Math.floor(next() * list.length)],
  }
}

function num(value) {
  const text = (Math.round(value * 10) / 10).toFixed(1)
  return text.endsWith('.0') ? text.slice(0, -2) : text
}

// ---------------------------------------------------------------------------------------------
// Reading a release

export function readThemes(notes) {
  const lines = notes
    .split('\n')
    .filter((line) => /^\s*[*-]\s+/.test(line))
    .map((line) => line.replace(/ by @\S+ in \S+\s*$/, '').toLowerCase())
    .filter((line) => !/^\s*[*-]\s+(release\b|version\b|bump\b|@)/.test(line))
  const counts = Object.fromEntries(THEMES.map((theme) => [theme, 0]))
  for (const line of lines) {
    const words = line.split(/[^a-z-]+/).filter(Boolean)
    for (const theme of THEMES) {
      if (words.some((word) => THEME_WORDS[theme].some((stem) => word.startsWith(stem)))) counts[theme] += 1
    }
  }
  const total = THEMES.reduce((sum, theme) => sum + counts[theme], 0)
  const themes = { lines: lines.length }
  for (const theme of THEMES)
    themes[theme] = total === 0 ? 0.25 : Math.round((counts[theme] / total) * 1000) / 1000
  return themes
}

function ranked(themes) {
  // Ties fall back to the order of THEMES, so the reading never depends on the engine's sort.
  return [...THEMES].sort((a, b) => themes[b] - themes[a] || THEMES.indexOf(a) - THEMES.indexOf(b))
}

// ---------------------------------------------------------------------------------------------
// The one rule: a trail turns by its momentum and loses momentum as it goes.

function trace({
  x,
  y,
  heading,
  sign,
  momentum,
  loss,
  stop = 0.15,
  reach = 5200,
  hue,
  random,
  drift = 0.24,
}) {
  const points = [[x, y, momentum]]
  const stopAt = Math.max(11, momentum * stop)
  let travelled = 0
  // The field is not even: how hard a trail turns drifts as it goes, so no coil is a drawn spiral.
  let pull = 1
  while (travelled < reach && momentum > stopAt) {
    const step = Math.min(Math.max(momentum * 0.13, 1.6), 34)
    if (random && drift > 0) pull = Math.min(1.55, Math.max(0.6, pull + (random.next() - 0.5) * drift))
    heading += (sign * step * pull) / momentum
    x += Math.cos(heading) * step
    y += Math.sin(heading) * step
    momentum -= loss * step
    travelled += step
    points.push([x, y, momentum])
    if (x < -MARGIN || x > WIDTH + MARGIN || y < -MARGIN || y > HEIGHT + MARGIN) break
  }
  return { points, hue: hue ?? (sign < 0 ? 'minus' : 'plus'), heading }
}

function pass({ x, y, heading, length, weight = 0 }) {
  return {
    points: [
      [x, y, 9999],
      [x + Math.cos(heading) * length, y + Math.sin(heading) * length, 9999],
    ],
    hue: 'neutral',
    weight,
    heading,
  }
}

// A pass that crosses the whole plate through (x, y).
function crossing(x, y, heading) {
  const back = 2200
  return pass({ x: x - Math.cos(heading) * back, y: y - Math.sin(heading) * back, heading, length: back * 2 })
}

// ---------------------------------------------------------------------------------------------
// Four ways of loading the plate

function forks(random, count, focus, spread) {
  const trails = []
  const vertices = []
  for (let index = 0; index < count; index += 1) {
    let vertex = null
    for (let attempt = 0; attempt < 40 && !vertex; attempt += 1) {
      const candidate = {
        x: focus.x + random.between(-spread.x, spread.x),
        y: focus.y + random.between(-spread.y, spread.y),
      }
      const clear = vertices.every((other) => Math.hypot(other.x - candidate.x, other.y - candidate.y) > 300)
      const inside =
        candidate.x > 120 && candidate.x < WIDTH - 120 && candidate.y > 110 && candidate.y < HEIGHT - 110
      if (clear && inside) vertex = candidate
    }
    if (!vertex) continue
    vertices.push(vertex)

    // The arrival: a straight pass that comes in from off the plate and ends here.
    const heading = random.between(-0.42, 0.42)
    trails.push(
      pass({
        x: vertex.x - Math.cos(heading) * 2000,
        y: vertex.y - Math.sin(heading) * 2000,
        heading,
        length: 2000,
      }),
    )

    // The departures: two to four trails of both signs, never evenly fanned.
    const prongs = random.int(2, index === 0 ? 4 : 3)
    let sign = random.sign()
    for (let prong = 0; prong < prongs; prong += 1) {
      sign = -sign
      const slow = random.next() < 0.55
      const momentum = slow ? random.between(75, 190) : random.between(300, 900)
      const trail = trace({
        x: vertex.x,
        y: vertex.y,
        heading: heading + random.between(-0.75, 0.75),
        sign,
        momentum,
        loss: slow ? random.between(0.08, 0.13) : random.between(0.004, 0.02),
        reach: slow ? 5200 : random.between(380, 1500),
        stop: random.between(0.15, 0.55),
        random,
        drift: slow ? 0.24 : 0.05,
      })
      trails.push(trail)
      // A fast departure that stops inside the plate forks once more.
      const last = trail.points.at(-1)
      const landed = last[0] > 60 && last[0] < WIDTH - 60 && last[1] > 60 && last[1] < HEIGHT - 60
      if (!slow && landed && random.next() < 0.6) {
        for (const childSign of [-1, 1]) {
          trails.push(
            trace({
              x: last[0],
              y: last[1],
              heading: trail.heading + random.between(-0.5, 0.5),
              sign: childSign,
              momentum: random.between(55, 120),
              loss: random.between(0.09, 0.14),
              stop: random.between(0.2, 0.6),
              random,
            }),
          )
        }
      }
    }
  }
  return trails
}

function holds(random, orbits, rules, focus, spread) {
  const trails = []
  const placed = []
  for (let index = 0; index < orbits; index += 1) {
    const radius = index === 0 ? random.between(200, 260) : random.between(85, 150)
    let centre = null
    for (let attempt = 0; attempt < 60 && !centre; attempt += 1) {
      const candidate = {
        x: focus.x + random.between(-spread.x, spread.x),
        y: focus.y + random.between(-spread.y, spread.y),
      }
      const clear = placed.every(
        (other) => Math.hypot(other.x - candidate.x, other.y - candidate.y) > other.radius + radius + 50,
      )
      if (clear) centre = candidate
    }
    if (!centre) continue
    placed.push({ ...centre, radius })
    const start = random.between(0, Math.PI * 2)
    const sign = index % 2 === 0 ? -1 : 1
    // An orbit that keeps most of its radius: it stops while it is still a ring, not a point.
    trails.push(
      trace({
        x: centre.x + Math.cos(start) * radius,
        y: centre.y + Math.sin(start) * radius,
        heading: start + (sign * Math.PI) / 2,
        sign,
        momentum: radius,
        loss: random.between(0.026, 0.04),
        stop: random.between(0.5, 0.6),
        random,
        drift: 0.04,
        reach: 9000,
      }),
    )
  }
  // Ruled passes: one heading, one pitch.
  const heading = random.between(-0.09, 0.09)
  const pitch = random.between(62, 84)
  const anchor = {
    x: WIDTH / 2,
    y: focus.y > HEIGHT / 2 ? random.between(150, 250) : random.between(650, 750),
  }
  for (let rule = 0; rule < rules; rule += 1) {
    const offset = (rule - (rules - 1) / 2) * pitch
    trails.push(
      crossing(anchor.x - Math.sin(heading) * offset, anchor.y + Math.cos(heading) * offset, heading),
    )
  }
  return trails
}

function route(random, count, focus) {
  const trails = []
  // One bundle enters tight, off the plate, and the field sorts it: the slow leave first.
  const fromLeft = focus.x > WIDTH / 2
  const origin = {
    x: fromLeft ? -40 : WIDTH + 40,
    y: focus.y > HEIGHT / 2 ? random.between(250, 340) : random.between(560, 650),
  }
  const towards = Math.atan2(focus.y - origin.y, focus.x - origin.x)
  const sign = random.sign()
  const heading = towards - sign * random.between(0.3, 0.42)
  const base = random.between(900, 1200)
  for (let index = 0; index < count; index += 1) {
    const share = count === 1 ? 0.5 : index / (count - 1)
    const offset = (share - 0.5) * count * 9
    trails.push(
      trace({
        x: origin.x - Math.sin(heading) * offset,
        y: origin.y + Math.cos(heading) * offset,
        heading: heading + random.between(-0.012, 0.012),
        sign,
        momentum: base * (0.52 + 1.25 * share ** 1.5) * random.between(0.97, 1.03),
        loss: 0.0012,
        reach: 6000,
      }),
    )
  }
  // What was cleared away: a couple of the other sign that peel off early and wind down.
  for (let index = 0; index < Math.max(1, Math.round(count / 4)); index += 1) {
    const along = 170 + index * random.between(240, 330) + random.between(0, 90)
    trails.push(
      trace({
        x: origin.x + Math.cos(heading) * along,
        y: origin.y + Math.sin(heading) * along,
        heading: heading + sign * random.between(0.1, 0.5),
        sign: -sign,
        momentum: random.between(75, 150),
        loss: random.between(0.09, 0.13),
        stop: random.between(0.18, 0.5),
        random,
      }),
    )
  }
  return trails
}

function beam(random, count, focus, curls) {
  const trails = []
  const heading = random.between(0.3, 0.52) * random.sign()
  const lanes = []
  for (let index = 0; index < count; index += 1) {
    // Uneven pitch: passes arrive in loose groups, never as a ruled set.
    const offset = (random.next() + random.next() + random.next() - 1.5) * 300
    lanes.push(offset)
    const through = crossing(
      focus.x - Math.sin(heading) * offset,
      focus.y + Math.cos(heading) * offset,
      heading,
    )
    // Some passes start or stop on the plate: not everything that flies crosses it.
    const cut = random.next()
    const at = 0.5 + random.between(-0.16, 0.16)
    const [[x0, y0], [x1, y1]] = through.points
    const mid = [x0 + (x1 - x0) * at, y0 + (y1 - y0) * at, 9999]
    if (cut < 0.22) through.points[0] = mid
    else if (cut < 0.44) through.points[1] = mid
    trails.push(through)
  }
  // Curls shed along the passes: always the same sign, always small.
  for (let index = 0; index < curls; index += 1) {
    const offset = random.pick(lanes)
    const along = random.between(-760, 760)
    trails.push(
      trace({
        x: focus.x - Math.sin(heading) * offset + Math.cos(heading) * along,
        y: focus.y + Math.cos(heading) * offset + Math.sin(heading) * along,
        heading: heading + random.between(-0.9, 0.9),
        sign: -1,
        momentum: random.between(32, 84),
        loss: random.between(0.12, 0.2),
        stop: random.between(0.3, 0.75),
        random,
      }),
    )
  }
  return trails
}

// ---------------------------------------------------------------------------------------------
// The plan: what the notes and the version decide before anything is drawn

export function planPiece(version, themes, seed = seedOf(version)) {
  const random = randomOf(seed)
  const [primary, secondary] = ranked(themes)
  // A long release loads the plate more, but only a little: the plate stays mostly empty.
  const load = Math.min(1, Math.log2(Math.max(themes.lines, 2)) / 7)
  const side = random.sign()
  const focus = {
    x: Math.round(WIDTH * (0.5 + side * random.between(0.1, 0.2))),
    y: Math.round(HEIGHT * random.between(0.42, 0.58)),
  }
  const counts = {
    hands: { forks: 2 + Math.round(load * 2) },
    holding: { orbits: 2 + Math.round(load), rules: 3 },
    route: { bundle: 7 + Math.round(load * 4) },
    flight: { passes: 5 + Math.round(load * 5), curls: 5 + Math.round(load * 6) },
  }
  const accents = {
    hands: { forks: 1 },
    holding: { orbits: 1, rules: 2 },
    route: { bundle: 4 },
    flight: { passes: 2, curls: 3 },
  }
  return {
    version,
    seed,
    primary,
    secondary,
    load: Math.round(load * 1000) / 1000,
    focus,
    counts: counts[primary],
    accents: accents[secondary],
    stray: 260 + Math.round(load * 260),
    scratches: 3 + (seed % 3),
    grainSeed: 1 + (seed % 97),
  }
}

function loadPlate(theme, random, amounts, focus, spread) {
  if (theme === 'hands') return forks(random, amounts.forks, focus, spread)
  if (theme === 'holding') return holds(random, amounts.orbits, amounts.rules, focus, spread)
  if (theme === 'route') return route(random, amounts.bundle, focus)
  return beam(random, amounts.passes, focus, amounts.curls)
}

export function composePiece(plan) {
  const random = randomOf(plan.seed ^ 0x9e3779b9)
  const main = loadPlate(plan.primary, random, plan.counts, plan.focus, { x: 420, y: 250 })
  // The second theme sits on the other side of the plate, smaller.
  const away = { x: WIDTH - plan.focus.x + (plan.focus.x > WIDTH / 2 ? -90 : 90), y: HEIGHT - plan.focus.y }
  const accent = loadPlate(plan.secondary, random, plan.accents, away, { x: 170, y: 150 })

  const stray = []
  for (let index = 0; index < plan.stray; index += 1) {
    stray.push([random.between(0, WIDTH), random.between(0, HEIGHT), random.next()])
  }
  const scratches = []
  for (let index = 0; index < plan.scratches; index += 1) {
    const x = random.between(0, WIDTH)
    const y = random.between(0, HEIGHT)
    const heading = Math.PI / 2 + random.between(-0.12, 0.12)
    const length = random.between(160, 520)
    scratches.push([x, y, x + Math.cos(heading) * length, y + Math.sin(heading) * length])
  }
  return { trails: [...main, ...accent], stray, scratches }
}

// ---------------------------------------------------------------------------------------------
// Drawing

function beadClass(momentum) {
  if (momentum >= BEADS.momentum[0]) return 0
  return momentum >= BEADS.momentum[1] ? 1 : 2
}

function inFrame(point) {
  return point[0] >= -8 && point[0] <= WIDTH + 8 && point[1] >= -8 && point[1] <= HEIGHT + 8
}

// Cuts a trail into runs of one bead size, each a relative polyline, and drops what is off the plate.
function runsOf(trail) {
  const runs = []
  let run = null
  const close = () => {
    if (run && run.points.length > 1) runs.push(run)
    run = null
  }
  for (let index = 0; index < trail.points.length; index += 1) {
    const point = trail.points[index]
    const size = trail.hue === 'neutral' ? (trail.weight ?? 0) : beadClass(point[2])
    const visible = inFrame(point) || (index > 0 && inFrame(trail.points[index - 1]))
    if (!visible) {
      close()
      continue
    }
    if (run && run.size !== size) {
      run.points.push(point)
      close()
    }
    if (!run) run = { size, points: index > 0 && trail.hue !== 'neutral' ? [trail.points[index - 1]] : [] }
    run.points.push(point)
  }
  close()
  return runs
}

function clipPass(points) {
  // A pass is one straight segment: keep only the part that lies on the plate.
  const [[x0, y0], [x1, y1]] = points
  let low = 0
  let high = 1
  const dx = x1 - x0
  const dy = y1 - y0
  const edges = [
    [-dx, x0 + 6],
    [dx, WIDTH + 6 - x0],
    [-dy, y0 + 6],
    [dy, HEIGHT + 6 - y0],
  ]
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null
      continue
    }
    const t = q / p
    if (p < 0) low = Math.max(low, t)
    else high = Math.min(high, t)
  }
  if (low >= high) return null
  return [
    [x0 + dx * low, y0 + dy * low],
    [x0 + dx * high, y0 + dy * high],
  ]
}

function pathOf(points) {
  let x = Math.round(points[0][0] * 10) / 10
  let y = Math.round(points[0][1] * 10) / 10
  let d = `M${num(x)} ${num(y)}l`
  for (let index = 1; index < points.length; index += 1) {
    const nx = Math.round(points[index][0] * 10) / 10
    const ny = Math.round(points[index][1] * 10) / 10
    const dx = num(nx - x)
    const dy = num(ny - y)
    d += `${index > 1 && !dx.startsWith('-') ? ' ' : ''}${dx}${dy.startsWith('-') ? '' : ' '}${dy}`
    x = nx
    y = ny
  }
  return d
}

export function renderPiece(plan, variant) {
  const colours = PALETTE[variant]
  const look = VARIANTS[variant]
  const { trails, stray, scratches } = composePiece(plan)

  // One path per ink and bead size.
  const groups = new Map()
  for (const trail of trails) {
    const runs =
      trail.hue === 'neutral'
        ? [clipPass(trail.points)].filter(Boolean).map((points) => ({ size: trail.weight ?? 0, points }))
        : runsOf(trail)
    for (const run of runs) {
      const key = `${trail.hue}:${run.size}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(pathOf(run.points))
    }
  }
  const marks = []
  for (const hue of ['neutral', 'minus', 'plus']) {
    for (const size of [0, 1, 2]) {
      const paths = groups.get(`${hue}:${size}`)
      if (!paths) continue
      const width = BEADS.widths[size]
      marks.push(
        `<path stroke="${colours[hue]}" stroke-width="${num(width)}" stroke-dasharray="0 ${num(width * BEADS.pitch)}" opacity="${look.opacity[size]}" d="${paths.join('')}"/>`,
      )
    }
  }

  const strayDots = stray.map(([x, y]) => `M${num(x)} ${num(y)}h0`)
  const third = Math.ceil(strayDots.length / 3)
  const strayPaths = [1.6, 2.4, 3.4]
    .map(
      (width, index) =>
        `<path stroke-width="${width}" d="${strayDots.slice(index * third, (index + 1) * third).join('')}"/>`,
    )
    .join('')
  const scratchPath = scratches
    .map(([x0, y0, x1, y1]) => `M${num(x0)} ${num(y0)}L${num(x1)} ${num(y1)}`)
    .join('')

  const id = `tracks-${plan.version.replace(/[^a-z0-9]/gi, '-')}-${variant}`
  const themeNames = { hands: 'forks', holding: 'orbits', route: 'a sorted bundle', flight: 'a beam' }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-labelledby="${id}-t ${id}-d">`,
    `<title id="${id}-t">Release artwork for ${plan.version}</title>`,
    `<desc id="${id}-d">Abstract beaded trails on a grainy plate: ${themeNames[plan.primary]}, with ${themeNames[plan.secondary]} beside.</desc>`,
    '<defs>',
    // Uneven exposure: slow, large patches.
    `<filter id="${id}-m" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" filterUnits="userSpaceOnUse"><feTurbulence type="fractalNoise" baseFrequency="0.0022 0.0038" numOctaves="2" seed="${plan.grainSeed}"/><feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1.5 -0.45"/><feComposite in="SourceGraphic" operator="in"/></filter>`,
    // Emulsion grain: fine, sparse specks.
    `<filter id="${id}-g" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" filterUnits="userSpaceOnUse"><feTurbulence type="fractalNoise" baseFrequency="0.62" numOctaves="2" seed="${plan.grainSeed + 5}"/><feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 6 -3.55"/><feComposite in="SourceGraphic" operator="in"/></filter>`,
    // Beads are bubbles, not printed dots: each one sits a little off its place.
    `<filter id="${id}-j" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" filterUnits="userSpaceOnUse"><feTurbulence type="fractalNoise" baseFrequency="0.21" numOctaves="1" seed="${plan.grainSeed + 11}"/><feDisplacementMap in="SourceGraphic" scale="3.2" xChannelSelector="R" yChannelSelector="G"/></filter>`,
    '</defs>',
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${colours.ground}"/>`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${colours.neutral}" opacity="${look.mottle}" filter="url(#${id}-m)"/>`,
    `<path fill="none" stroke="${colours.neutral}" stroke-width="0.9" opacity="${look.scratch}" d="${scratchPath}"/>`,
    `<g fill="none" stroke-linecap="round" filter="url(#${id}-j)">`,
    `<g stroke="${colours.neutral}" opacity="${look.stray}">${strayPaths}</g>`,
    ...marks,
    '</g>',
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${colours.neutral}" opacity="${look.grain}" filter="url(#${id}-g)"/>`,
    '</svg>',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------------------------
// Command line

function parseArgs(argv) {
  const options = { out: null, version: null, notes: null }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!['--out', '--version', '--notes'].includes(flag)) throw new Error(`Unknown argument: ${flag}`)
    const value = argv[index + 1]
    if (value === undefined || value === '' || value.startsWith('--'))
      throw new Error(`${flag} needs a value`)
    options[flag.slice(2)] = value
    index += 1
  }
  if (Boolean(options.version) !== Boolean(options.notes))
    throw new Error('--version and --notes go together')
  return options
}

function seriesVersions() {
  return readdirSync(NOTES_DIR)
    .filter((file) => /^v\d+\.\d+\.\d+\.md$/.test(file))
    .map((file) => file.slice(0, -3))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
}

function writePiece(out, version, notes) {
  const themes = readThemes(notes)
  const plan = planPiece(version, themes)
  const bytes = {}
  for (const variant of ['light', 'dark']) {
    const svg = renderPiece(plan, variant)
    writeFileSync(join(out, `${version}-${variant}.svg`), svg)
    bytes[variant] = Buffer.byteLength(svg)
  }
  return {
    version,
    themes,
    plan,
    files: { light: `${version}-light.svg`, dark: `${version}-dark.svg` },
    bytes,
  }
}

function main(argv) {
  const options = parseArgs(argv)
  const out = resolve(options.out ?? ASSET_DIR)
  mkdirSync(out, { recursive: true })

  if (options.version) {
    const piece = writePiece(out, options.version, readFileSync(resolve(options.notes), 'utf8'))
    console.log(`${piece.version}: ${piece.plan.primary} with ${piece.plan.secondary}`)
    return
  }

  const releases = seriesVersions().map((version) =>
    writePiece(out, version, readFileSync(join(NOTES_DIR, `${version}.md`), 'utf8')),
  )
  const manifest = {
    direction: 'tracks',
    madeBy: 'Claude Fable 5.2',
    generator: 'scripts/release-art/tracks.mjs',
    canvas: { width: WIDTH, height: HEIGHT },
    palette: PALETTE,
    beads: {
      width: { fast: BEADS.widths[0], slowing: BEADS.widths[1], slow: BEADS.widths[2] },
      pitch: BEADS.pitch,
      slowingBelow: BEADS.momentum[0],
      slowBelow: BEADS.momentum[1],
    },
    releases,
  }
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  for (const piece of releases) {
    console.log(
      `${piece.version}: ${piece.plan.primary} with ${piece.plan.secondary}, ${piece.bytes.light} / ${piece.bytes.dark} bytes`,
    )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
