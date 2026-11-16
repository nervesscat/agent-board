#!/usr/bin/env node
// Release artwork: burin.
//
// Tone is built the way an engraver builds it: passes of straight, hand-ruled hatch strokes. A
// pass is one ink at one angle and one pitch. Where a pass needs more tone it rules more of its
// lines, where it needs less it leaves them out, and where two passes cross the tone deepens into
// cross-hatch. There are no outlines, no fills and no curves on the plate: only ruled strokes that
// swell and taper, on paper or on ink.
//
// The release's notes are read for three themes (many hands, precision, wayfinding) and for their
// volume. The themes set the plate: how many passes and how far their angles spread, how tight
// and how steady the ruling is, whether a straight edge holds the hatching, and whether a bare
// channel is left through it. The version seeds every remaining choice, so the same version and
// notes write the same bytes on every run. A release nobody has seen needs only its notes file.
//
// Usage:
//   node scripts/release-art/burin.mjs                      # regenerate the committed series
//   node scripts/release-art/burin.mjs --out /tmp/art       # write somewhere else
//   node scripts/release-art/burin.mjs --version v0.3.0 \
//     --notes scripts/release-art/notes/v0.3.0.md --out /tmp/art
//
// To draw the next release:
//   gh release view vX.Y.Z --json body --jq .body > scripts/release-art/notes/vX.Y.Z.md
//   node scripts/release-art/burin.mjs

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const NOTES_DIR = join(ROOT, 'scripts/release-art/notes')
const ASSET_DIR = join(ROOT, 'src/assets/release-art/burin')

export const WIDTH = 1600
export const HEIGHT = 900
const REACH = 960
const STEP = 4
const MIN_STROKE = 22

// A pass rules every fourth line first, then the lines between, then the rest: the tone a line
// needs before it is ruled, by its place in the cycle. This is what feathers a pass's edge.
const LEVELS = [0.17, 0.62, 0.38, 0.62]

// Paper, ink and two spot inks. The dark piece is the same plate printed in light inks on an ink
// ground: each ink keeps its hue and is lifted until it carries on the dark sheet.
export const PALETTE = {
  light: { ground: '#ECE5D6', ink: '#23262B', first: '#B4462B', second: '#1F5A63' },
  dark: { ground: '#16181B', ink: '#E3DBC9', first: '#E2694A', second: '#5FA7AC' },
}
export const PALETTE_HEXES = [...Object.values(PALETTE.light), ...Object.values(PALETTE.dark)]

const VARIANTS = {
  light: { blend: 'multiply', opacity: [0.9, 0.92, 0.92], wear: 0.5, dust: 0.3 },
  dark: { blend: 'screen', opacity: [0.84, 0.94, 0.94], wear: 0.55, dust: 0.22 },
}

const THEME_WORDS = {
  hands: [
    'agent',
    'agents',
    'shared',
    'share',
    'team',
    'lane',
    'lanes',
    'queue',
    'review',
    'reviews',
    'orchestrator',
    'orchestrators',
    'worker',
    'workers',
    'delegate',
    'delegated',
    'delegation',
    'hand-off',
    'together',
    'parallel',
    'verdicts',
    'tools',
    'roles',
    'brief',
  ],
  precision: [
    'focus',
    'cache',
    'retry',
    'clock',
    'count',
    'cap',
    'keep',
    'exact',
    'safe',
    'proxy',
    'sticky',
    'inside',
    'paint',
    'remember',
    'stops',
    'fix',
    'settle',
    'only',
    'serve',
    'forwarding',
    'upgrades',
    'lock',
    'headroom',
  ],
  wayfinding: [
    'move',
    'split',
    'remove',
    'menu',
    'palette',
    'window',
    'fold',
    'leave',
    'rename',
    'reorder',
    'into',
    'across',
    'row',
    'lives',
    'pages',
    'beside',
    'header',
    'drop',
    'own',
    'filter',
  ],
}

// --- seeded numbers ------------------------------------------------------------------------------

export function seedFor(version) {
  let hash = 2166136261
  for (const char of `burin:${version}`) {
    hash ^= char.codePointAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function random(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function lattice(seed, x, y) {
  let h = (seed ^ Math.imul(x, 374761393) ^ Math.imul(y, 668265263)) >>> 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

// Smooth value noise in -1..1, for the unevenness of a pass's edge.
function noise(seed, x, y) {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const top = lattice(seed, x0, y0) * (1 - sx) + lattice(seed, x0 + 1, y0) * sx
  const bottom = lattice(seed, x0, y0 + 1) * (1 - sx) + lattice(seed, x0 + 1, y0 + 1) * sx
  return (top * (1 - sy) + bottom * sy) * 2 - 1
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value))
const mix = (from, to, amount) => from + (to - from) * amount
const ramp = (low, high, value) => clamp((value - low) / (high - low), 0, 1)
const radians = (degrees) => (degrees * Math.PI) / 180
const round = (value, places = 3) => Number(value.toFixed(places))

// --- reading a release ----------------------------------------------------------------------------

// The share of the notes' lines that speak of each theme, and how much there is of them.
export function readThemes(notes) {
  const lines = notes
    .split('\n')
    .filter((line) => /^\s*[*-]\s/.test(line))
    .map((line) =>
      line
        .replace(/ by @.*$/, '')
        .replace(/https?:\S+/g, '')
        .toLowerCase(),
    )
  const hits = { hands: 0, precision: 0, wayfinding: 0 }
  for (const line of lines) {
    const words = new Set(line.match(/[a-z][a-z-]*/g) ?? [])
    for (const theme of Object.keys(hits)) {
      if (THEME_WORDS[theme].some((word) => words.has(word))) hits[theme] += 1
    }
  }
  const total = hits.hands + hits.precision + hits.wayfinding
  const share = (count) => (total === 0 ? 1 / 3 : count / total)
  return {
    lines: lines.length,
    hands: round(share(hits.hands)),
    precision: round(share(hits.precision)),
    wayfinding: round(share(hits.wayfinding)),
    volume: round(clamp(Math.log(Math.max(lines.length, 1)) / Math.log(160), 0, 1)),
  }
}

// --- planning the plate ---------------------------------------------------------------------------

// Everything the plate is, as numbers: the passes, the edge that holds them, the channel left bare.
export function planPiece(version, themes, seed = seedFor(version)) {
  const next = random(seed)
  const between = (low, high) => mix(low, high, next())
  const { hands, precision, wayfinding, volume } = themes

  const steadiness = ramp(0.2, 0.6, precision)
  const hold = ramp(0.22, 0.5, precision)
  const channel = ramp(0.25, 0.5, wayfinding)
  const count = hands + 0.25 * volume > 0.4 ? 3 : 2

  const meet = { x: between(0.36, 0.64) * WIDTH, y: between(0.38, 0.62) * HEIGHT }
  const baseAngle = between(-38, 38)
  const turn = between(0, 360)
  const spread = mix(180 / count, 90, steadiness)
  const secondFirst = next() < 0.5
  const inks = secondFirst ? ['ink', 'second', 'first'] : ['ink', 'first', 'second']
  const reachOut = mix(0.72, 0.56, hands)
  const scale = mix(0.86, 1.04, volume)

  const passes = []
  for (let index = 0; index < count; index += 1) {
    const around = radians(turn + (index * 360) / count + between(-22, 22))
    const angle = baseAngle + index * spread + between(-9, 9) * (1 - steadiness)
    passes.push({
      ink: inks[index],
      angle: round(angle),
      pitch: round(mix(17, 10.5, steadiness) * (1 + 0.14 * index) * between(0.94, 1.06)),
      weight: round(index === 0 ? 1.35 : 1.5),
      lobe: {
        x: round(meet.x + Math.cos(around) * reachOut * WIDTH * 0.62, 1),
        y: round(meet.y + Math.sin(around) * reachOut * HEIGHT * 0.78, 1),
        rx: round(between(640, 900) * scale, 1),
        ry: round(between(270, 380) * scale, 1),
        turn: round(between(-40, 40)),
      },
      grainSeed: Math.floor(next() * 0xffffffff),
    })
  }

  // The edge is square to the first pass's ruling, so that pass ends on it stroke by stroke.
  const edgeAngle = passes[0].angle + 90
  const edge = {
    strength: round(hold),
    x: round(meet.x + between(-90, 90), 1),
    y: round(meet.y + between(-50, 50), 1),
    angle: round(edgeAngle),
    side: next() < 0.5 ? 1 : -1,
    band: round(between(70, 120), 1),
  }

  // The channel crosses the plate in one straight run, opening as it goes.
  const from =
    next() < 0.5 ? { x: -80, y: between(0.15, 0.85) * HEIGHT } : { x: between(0.1, 0.5) * WIDTH, y: -80 }
  const to =
    next() < 0.5
      ? { x: WIDTH + 80, y: between(0.15, 0.85) * HEIGHT }
      : { x: between(0.5, 0.9) * WIDTH, y: HEIGHT + 80 }
  const path = {
    strength: round(channel),
    width: round(between(16, 24), 1),
    widen: round(between(1.6, 2.6)),
    points: [from, to].map((point) => ({ x: round(point.x, 1), y: round(point.y, 1) })),
    flank: next() < 0.5 ? 1 : -1,
  }

  return {
    version,
    seed,
    count,
    wobble: round(mix(0.22, 0.04, steadiness)),
    drift: round(mix(1.6, 0.25, steadiness)),
    taper: round(mix(36, 7, steadiness), 1),
    stroke: { low: round(mix(240, 420, steadiness), 1), high: round(mix(820, 1200, steadiness), 1) },
    passes,
    edge,
    path,
  }
}

// --- the tone a pass wants at a point ---------------------------------------------------------------

function lobeTone(lobe, x, y) {
  const cos = Math.cos(radians(lobe.turn))
  const sin = Math.sin(radians(lobe.turn))
  const dx = x - lobe.x
  const dy = y - lobe.y
  const along = (dx * cos + dy * sin) / lobe.rx
  const across = (-dx * sin + dy * cos) / lobe.ry
  return Math.exp(-(along * along + across * across))
}

// Signed distance to the edge: positive on the side the hatching is kept.
function edgeDistance(edge, x, y) {
  const normalX = Math.cos(radians(edge.angle + 90))
  const normalY = Math.sin(radians(edge.angle + 90))
  return ((x - edge.x) * normalX + (y - edge.y) * normalY) * edge.side
}

// Distance to the channel's centre line, signed by the side of it.
function pathDistance(path, x, y) {
  let best = Infinity
  let side = 1
  let along = 0
  for (let index = 0; index < path.points.length - 1; index += 1) {
    const a = path.points[index]
    const b = path.points[index + 1]
    const abx = b.x - a.x
    const aby = b.y - a.y
    const t = clamp(((x - a.x) * abx + (y - a.y) * aby) / (abx * abx + aby * aby), 0, 1)
    const px = x - (a.x + abx * t)
    const py = y - (a.y + aby * t)
    const distance = Math.hypot(px, py)
    if (distance < best) {
      best = distance
      side = abx * py - aby * px >= 0 ? 1 : -1
      along = t
    }
  }
  return { distance: best * side, along }
}

export function toneAt(plan, index, x, y) {
  const pass = plan.passes[index]
  const { edge, path } = plan
  // A held plate has no mass of its own in the first pass: the edge is its whole tone.
  let tone = lobeTone(pass.lobe, x, y) * (index === 0 ? 1 - 0.9 * edge.strength : 1)
  tone += 0.05 * noise(pass.grainSeed, x / 330, y / 330)

  if (path.strength > 0) {
    const { distance, along } = pathDistance(path, x, y)
    const off = Math.abs(distance)
    const width = path.width * (1 + path.widen * along)
    // A wayfinding plate is ruled lightly all over, so the channel is cut through something.
    if (index === 0) tone = Math.max(tone, 0.44 * path.strength)
    // One flank of the channel is ruled in the second ink: the side to keep to.
    if (index === 1 && distance * path.flank > 0) {
      tone = Math.max(tone, 0.78 * path.strength * (1 - ramp(width, width + 150, off)))
    }
    tone *= 1 - path.strength * (1 - ramp(width - 6, width + 6, off))
  }

  if (edge.strength > 0) {
    const distance = edgeDistance(edge, x, y)
    const kept = ramp(-1, 1, distance)
    if (index === 0) {
      // Densest at the edge, thinning as it leaves it: the edge is what holds the tone.
      tone = Math.max(tone, edge.strength * mix(0.74, 0.12, ramp(0, 760, distance)))
      tone *= mix(1, kept, edge.strength)
    } else if (index === 1) {
      const strip = kept * (1 - ramp(edge.band - 1, edge.band + 1, distance))
      tone = mix(tone, Math.max(tone * 0.5, 0.8) * strip, edge.strength)
    } else {
      tone *= mix(1, 1 - kept, edge.strength)
    }
  }
  return tone
}

// --- ruling a pass ----------------------------------------------------------------------------------

function tenths(value) {
  return Math.round(value * 10)
}

function print(value) {
  const sign = value < 0 ? '-' : ''
  const whole = Math.abs(value)
  const text = whole % 10 === 0 ? String(whole / 10) : `${Math.floor(whole / 10) || ''}.${whole % 10}`
  return `${sign}${text}`
}

// One stroke as a closed sliver: a point, swelling to its weight, and back to a point.
function sliver(points) {
  let previousX = tenths(points[0][0])
  let previousY = tenths(points[0][1])
  let d = `M${print(previousX)} ${print(previousY)}l`
  for (let index = 1; index < points.length; index += 1) {
    const x = tenths(points[index][0])
    const y = tenths(points[index][1])
    const dx = print(x - previousX)
    const dy = print(y - previousY)
    d += `${index > 1 && !dx.startsWith('-') ? ' ' : ''}${dx}${dy.startsWith('-') ? '' : ' '}${dy}`
    previousX = x
    previousY = y
  }
  return `${d}z`
}

export function rulePass(plan, index) {
  const pass = plan.passes[index]
  const next = random(pass.grainSeed ^ 0x9e3779b9)
  const strokes = []
  const lines = Math.ceil(REACH / pass.pitch)

  for (let line = -lines; line <= lines; line += 1) {
    const level = LEVELS[((line % 4) + 4) % 4]
    const lead = level === LEVELS[0] ? 1.22 : 1
    const angle = radians(pass.angle + (next() * 2 - 1) * plan.wobble)
    const offset = line * pass.pitch + (next() * 2 - 1) * plan.drift
    const dirX = Math.cos(angle)
    const dirY = Math.sin(angle)
    const normalX = -Math.sin(radians(pass.angle))
    const normalY = Math.cos(radians(pass.angle))
    const originX = WIDTH / 2 + normalX * offset
    const originY = HEIGHT / 2 + normalY * offset
    const at = (s) => [originX + dirX * s, originY + dirY * s]
    const tone = (s) => {
      const [x, y] = at(s)
      if (x < -24 || x > WIDTH + 24 || y < -24 || y > HEIGHT + 24) return -1
      return toneAt(plan, index, x, y)
    }
    const cross = (outside, inside) => {
      for (let pass = 0; pass < 5; pass += 1) {
        const middle = (outside + inside) / 2
        if (tone(middle) > level) inside = middle
        else outside = middle
      }
      return inside
    }

    // The stretches of this line where the tone asks for it.
    const runs = []
    let start = null
    for (let s = -REACH; s <= REACH; s += STEP) {
      const on = tone(s) > level
      if (on && start === null) start = cross(s - STEP, s)
      if (!on && start !== null) {
        runs.push([start, cross(s, s - STEP)])
        start = null
      }
    }
    if (start !== null) runs.push([start, REACH])

    // The hand lifts: a long stretch is several strokes with a breath between them.
    for (const [from, to] of runs) {
      let s = from
      while (to - s >= MIN_STROKE) {
        let end = Math.min(to, s + mix(plan.stroke.low, plan.stroke.high, next()))
        if (to - end < MIN_STROKE * 2) end = to
        const length = end - s
        const taper = Math.min(plan.taper * mix(0.7, 1.3, next()), length / 2.4)
        const weight = (s2) => pass.weight * lead * mix(0.5, 1.28, clamp(tone(s2), 0, 1))
        const w0 = weight(s + taper)
        const w1 = weight(end - taper)
        const [ax, ay] = at(s)
        const [bx, by] = at(s + taper)
        const [cx, cy] = at(end - taper)
        const [dx, dy] = at(end)
        const nx = -dirY
        const ny = dirX
        strokes.push(
          sliver([
            [ax, ay],
            [bx + nx * w0, by + ny * w0],
            [cx + nx * w1, cy + ny * w1],
            [dx, dy],
            [cx - nx * w1, cy - ny * w1],
            [bx - nx * w0, by - ny * w0],
          ]),
        )
        s = end + mix(3, 8, next())
      }
    }
  }
  return strokes
}

// --- the sheet --------------------------------------------------------------------------------------

function channels(hex) {
  return [1, 3, 5].map((start) => round(Number.parseInt(hex.slice(start, start + 2), 16) / 255))
}

// Speckle in one colour: fine noise, kept only where it peaks.
function speckle(id, hex, frequency, seed, gain, cut) {
  const [r, g, b] = channels(hex)
  return (
    `<filter id="${id}" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" filterUnits="userSpaceOnUse">` +
    `<feTurbulence type="fractalNoise" baseFrequency="${frequency}" numOctaves="2" seed="${seed}"/>` +
    `<feColorMatrix values="0 0 0 0 ${r} 0 0 0 0 ${g} 0 0 0 0 ${b} ${gain} 0 0 0 -${cut}"/>` +
    `</filter>`
  )
}

export function renderPiece(plan, variantName) {
  const variant = VARIANTS[variantName]
  const palette = PALETTE[variantName]
  const grainSeed = (plan.seed % 900) + 1
  const inkOrder = ['ink', 'first', 'second']

  const passes = plan.passes
    .map((pass, index) => {
      const strokes = rulePass(plan, index)
      if (strokes.length === 0) return ''
      const opacity = variant.opacity[inkOrder.indexOf(pass.ink)]
      return `<path fill="${palette[pass.ink]}" fill-opacity="${opacity}" style="mix-blend-mode:${variant.blend}" d="${strokes.join('')}"/>`
    })
    .join('\n')

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-labelledby="t d">`,
    `<title id="t">Release artwork ${plan.version}</title>`,
    `<desc id="d">Abstract hatching: ${plan.count} passes of ruled strokes on ${variantName === 'light' ? 'paper' : 'ink'}.</desc>`,
    `<defs>`,
    // The burr: the strokes' edges are bitten a little, the way a ruled line takes ink.
    `<filter id="b" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" filterUnits="userSpaceOnUse">` +
      `<feTurbulence type="fractalNoise" baseFrequency="0.55" numOctaves="2" seed="${grainSeed}"/>` +
      `<feDisplacementMap in="SourceGraphic" scale="1.7" xChannelSelector="R" yChannelSelector="G"/>` +
      `</filter>`,
    speckle('w', palette.ground, 0.82, grainSeed + 7, 5.2, round(5.2 * 0.5 + (1 - variant.wear) * 1.6)),
    speckle('s', palette.ink, 0.6, grainSeed + 19, 4.4, round(4.4 * 0.5 + (1 - variant.dust) * 1.5)),
    `</defs>`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${palette.ground}"/>`,
    `<g filter="url(#b)">`,
    passes,
    `</g>`,
    // Wear: the ground showing through the ink. Dust: the ink where nothing was ruled.
    `<rect width="${WIDTH}" height="${HEIGHT}" filter="url(#w)"/>`,
    `<rect width="${WIDTH}" height="${HEIGHT}" filter="url(#s)" opacity="0.5"/>`,
    `</svg>`,
    '',
  ].join('\n')
}

// --- writing the series -----------------------------------------------------------------------------

function versionOrder(a, b) {
  const parts = (version) => version.replace(/^v/, '').split('.').map(Number)
  const [left, right] = [parts(a), parts(b)]
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

export function buildSeries(releases) {
  const files = {}
  const pieces = []
  for (const { version, notes } of releases) {
    const themes = readThemes(notes)
    const plan = planPiece(version, themes)
    const entry = { version, seed: plan.seed, themes, plan, files: {} }
    for (const variant of ['light', 'dark']) {
      const name = `${version}-${variant}.svg`
      files[name] = renderPiece(plan, variant)
      entry.files[variant] = { name, bytes: Buffer.byteLength(files[name]) }
    }
    pieces.push(entry)
  }
  const manifest = {
    direction: 'burin',
    madeBy: 'Claude Fable 5.2',
    generator: 'scripts/release-art/burin.mjs',
    canvas: { width: WIDTH, height: HEIGHT },
    palette: PALETTE,
    pieces,
  }
  files['manifest.json'] = `${JSON.stringify(manifest, null, 2)}\n`
  return files
}

function parseArgs(argv) {
  const options = { out: ASSET_DIR, version: null, notes: null }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!['--out', '--version', '--notes'].includes(flag)) throw new Error(`Unknown option: ${flag}`)
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`${flag} needs a value`)
    options[flag.slice(2)] = value
    index += 1
  }
  if (Boolean(options.version) !== Boolean(options.notes)) {
    throw new Error('--version and --notes go together')
  }
  if (options.version && !/^v\d+\.\d+\.\d+$/.test(options.version)) {
    throw new Error(`Not a release version: ${options.version}`)
  }
  return options
}

function main(argv) {
  const options = parseArgs(argv)
  const releases = options.version
    ? [{ version: options.version, notes: readFileSync(resolve(options.notes), 'utf8') }]
    : readdirSync(NOTES_DIR)
        .filter((file) => /^v\d+\.\d+\.\d+\.md$/.test(file))
        .map((file) => file.replace(/\.md$/, ''))
        .sort(versionOrder)
        .map((version) => ({ version, notes: readFileSync(join(NOTES_DIR, `${version}.md`), 'utf8') }))
  const out = resolve(options.out)
  mkdirSync(out, { recursive: true })
  for (const [name, content] of Object.entries(buildSeries(releases))) {
    writeFileSync(join(out, name), content)
    if (name.endsWith('.svg')) console.log(`${name}  ${(Buffer.byteLength(content) / 1024).toFixed(1)} KB`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
