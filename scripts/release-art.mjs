#!/usr/bin/env node
/**
 * Release artwork: ink diffusion in still water.
 *
 * Each release gets one piece: two inks dropped into a still, empty ground. The version seeds the
 * composition (how many drops, where they land, how far they bloom, which quarter stays empty), and
 * the release's own notes tilt that plan: a release of many hands blooms wide and busy, a release of
 * quiet fixes holds a small, calm cluster, a release about moving things around leaves more paper
 * empty and still.
 *
 * A piece is drawn from the plan alone: no dependencies and no randomness the version does not
 * decide, so the same version and notes always write the same bytes.
 *
 *   node scripts/release-art.mjs                 write every release in the notes cache
 *   node scripts/release-art.mjs --check         fail when a committed piece is out of date
 *   node scripts/release-art.mjs --capture       refresh the cache from `gh release view`
 *   node scripts/release-art.mjs --version 0.2.5 --notes notes.md
 *   node scripts/release-art.mjs --version 0.2.5  write one release from the cache
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(HERE, '..')
export const OUT_DIR = path.join(REPO, 'src/assets/release-art')
export const NOTES_FILE = path.join(HERE, 'release-art/releases.json')

export const WIDTH = 1600
export const HEIGHT = 900
export const BUDGET_BYTES = 150 * 1024
export const THEMES = ['light', 'dark']

/**
 * Two inks over one ground per theme, and nothing else. The light piece is ink on paper (multiply);
 * the dark piece is the same ink seen by transmitted light (screen).
 */
const PALETTE = {
  light: { ground: '#f2efe7', inks: ['#1d2358', '#6f2458'], blend: 'multiply', grain: 0.17, mottle: 0.05 },
  dark: { ground: '#0e0d12', inks: ['#9dabf0', '#d98cc0'], blend: 'screen', grain: 0.09, mottle: 0.035 },
}

const TAU = Math.PI * 2

// ---------------------------------------------------------------------------
// Determinism

/** FNV-1a, so a version string always seeds the same composition. */
export function hash(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32: small, fast, and the same in every engine. */
export function prng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const saturate = (v) => clamp(v, 0, 1)

// ---------------------------------------------------------------------------
// A release's themes, read from its notes

/**
 * Three readings of one release, each from 0 to 1:
 * - many: how much moved at once (the size of the notes) — many hands leave many marks.
 * - precision: how much of it is small, exact, holding (focus rings, clocks, caches, caps).
 * - wayfinding: how much of it is moving things around (splits, menus, removals, renames).
 */
const VOCABULARY = {
  precision:
    /focus|ring\b|align|safe area|cache|clock|cap\b|sticky|within|inside|pixel|exact|retry|guard|resize|breakpoint/gi,
  wayfinding:
    /instructions|settings|menu|palette|window|split|move|reorgan|overview|remove|fold|sidebar|nav|home page|rename/gi,
}

export function readThemes(body) {
  const lines = String(body)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const bullets = lines.filter((line) => /^(?:[*-]|\d+\.)\s+/.test(line))
  const counted = bullets.length > 0 ? bullets : lines
  // No notes at all is a valid input: the version alone still decides a piece, it just has nothing
  // to tilt it. Dividing by zero would put NaN in every coordinate.
  if (counted.length === 0) return { many: 0, precision: 0, wayfinding: 0 }
  const hits = (re) => counted.reduce((sum, line) => sum + (line.match(re) ?? []).length, 0)
  return {
    many: saturate(Math.sqrt(Math.min(counted.length, 80) / 80)),
    precision: saturate(hits(VOCABULARY.precision) / counted.length / 0.45),
    wayfinding: saturate(hits(VOCABULARY.wayfinding) / counted.length / 0.45),
  }
}

// ---------------------------------------------------------------------------
// The plan: what the version and the themes decide

/**
 * The plan a version produces. Every number the drawing uses is decided here, from the version's
 * hash and the release's themes, so a change in the notes shows up as a change in the piece.
 */
export function plan(version, notes = '') {
  const seed = hash(String(version))
  const rng = prng(seed)
  const themes = readThemes(notes)

  // How many drops: more for a release where much moved, fewer when the release is about making
  // less of everything.
  const drops = clamp(Math.round(2 + 4 * themes.many - 2 * themes.wayfinding), 2, 5)
  // Precision holds the drops in one cluster, calmer at the edge and denser at the core.
  const tightness = themes.precision
  // Many hands leave the edges turbulent; precision settles them.
  const turbulence = clamp(1 - 0.5 * tightness, 0.4, 1)

  // The quarter that stays empty, and the mass that sits diagonally away from it.
  const quietCorner = Math.floor(rng() * 4)
  const quietX = quietCorner % 2 === 1 ? 0.12 : 0.88
  const quietY = quietCorner >= 2 ? 0.86 : 0.12
  const anchorX = WIDTH * (quietX < 0.5 ? 0.56 + rng() * 0.12 : 0.2 + rng() * 0.12)
  const anchorY = HEIGHT * (quietY < 0.5 ? 0.47 + rng() * 0.12 : 0.4 + rng() * 0.12)
  // The direction the bloom leans: one vector for the piece, so it reads as one movement.
  const flow = rng() * TAU
  const heroRadius =
    (285 + 85 * rng()) *
    (1 - 0.15 * themes.wayfinding) *
    (1 - 0.08 * tightness) *
    (1 - 0.05 * Math.max(0, drops - 3)) *
    (1 + 0.45 * Math.max(0, 3 - drops))

  const hero = {
    cx: anchorX,
    cy: anchorY,
    radius: heroRadius,
    ink: 0,
    squash: 0.74 + 0.36 * rng(),
    rotate: flow + (rng() - 0.5) * 0.2,
    wobble: 0.06 + 0.08 * rng() * (0.7 + 0.6 * turbulence),
    lobes: 2 + Math.floor(rng() * 2),
    density: 0.95 + 0.4 * tightness,
    spread: turbulence,
    phase: [rng() * TAU, rng() * TAU, rng() * TAU, rng() * TAU],
  }

  const quietPoint = [quietX * WIDTH, quietY * HEIGHT]

  const makeDrop = (cx, cy) => ({
    cx,
    cy,
    squash: 0.5 + 0.26 * rng(),
    rotate: flow + (rng() - 0.5) * 0.7,
    wobble: 0.05 + 0.1 * rng() * (0.7 + 0.6 * turbulence),
    lobes: 2 + Math.floor(rng() * 3),
    density: 0.9 + 0.45 * tightness,
    spread: turbulence * (0.6 + 0.6 * rng()),
    phase: [rng() * TAU, rng() * TAU, rng() * TAU, rng() * TAU],
  })

  // A sequence, not a scatter: the drops land along one current, the largest in the middle and the
  // rest smaller as the line goes on. Tightness pulls the line together; wayfinding pulls it apart.
  const dropPlans = [hero]
  const spacing = heroRadius * (0.6 + 0.3 * rng()) * (1 - 0.3 * tightness) * (1 + 0.35 * themes.wayfinding)
  for (let i = 1; i < drops; i++) {
    const step = Math.ceil(i / 2) * (i % 2 === 1 ? 1 : -1)
    const along = step * spacing
    const across = (rng() - 0.5) * heroRadius * (0.35 + 0.6 * (1 - tightness))
    const cx = anchorX + Math.cos(flow) * along - Math.sin(flow) * across
    const cy = anchorY + Math.sin(flow) * along + Math.cos(flow) * across * 0.8
    dropPlans.push({
      ...makeDrop(cx, cy),
      radius: heroRadius * (1 - 0.17 * Math.abs(step)) * (0.8 + 0.3 * rng()),
      ink: i % 2,
    })
  }

  for (const drop of dropPlans) {
    drop.cx = clamp(drop.cx, drop.radius * 0.75, WIDTH - drop.radius * 0.75)
    drop.cy = clamp(drop.cy, drop.radius * 0.75, HEIGHT - drop.radius * 0.75)
  }

  // Keep the chosen quarter honest: push a drop that would reach into it back out.
  for (const drop of dropPlans) {
    const gap = Math.hypot(drop.cx - quietPoint[0], drop.cy - quietPoint[1])
    const keep = drop.radius + heroRadius * 0.85
    if (gap >= keep) continue
    const push = (keep - gap) / Math.max(1, gap)
    drop.cx += (drop.cx - quietPoint[0]) * push
    drop.cy += (drop.cy - quietPoint[1]) * push
    drop.radius *= 0.85
  }

  return {
    version: String(version),
    seed,
    themes,
    tightness,
    turbulence,
    quiet: [quietX, quietY],
    drops: dropPlans,
    grainSeed: 1 + (seed % 97),
    mottleSeed: 1 + ((seed >>> 9) % 89),
  }
}

// ---------------------------------------------------------------------------
// Drawing

/** Coordinates keep one decimal: the grain hides the rest, and the file stays small. */
const n = (v) => {
  const r = Math.round(v * 10) / 10
  return Object.is(r, -0) ? '0' : String(r)
}

/** Opacities keep three: an ink wash is stacked out of hundredths, and rounding them to zero loses it. */
const a = (v) => {
  const r = Math.round(v * 1000) / 1000
  return Object.is(r, -0) ? '0' : String(r)
}

/**
 * The shape of a bloom at one angle: slow lobes for the mass and a few fine harmonics for the
 * coast, because a wet edge never repeats itself smoothly. Stored on the drop so the silhouette,
 * the rim and the inner marks all describe the same shape.
 */
function radiusFactor(drop, theta) {
  const p = drop.phase
  return (
    1 +
    drop.wobble * Math.sin(drop.lobes * theta + p[0]) +
    drop.wobble * 0.4 * Math.sin((drop.lobes + 2) * theta + p[1]) +
    drop.wobble * 0.22 * Math.sin(9 * theta + p[2]) +
    drop.wobble * 0.12 * Math.sin(14 * theta + p[3])
  )
}

const at = (drop, theta, distance, squash = drop.squash) => [
  drop.cx + Math.cos(theta) * distance,
  drop.cy + Math.sin(theta) * distance * squash,
]

/** A point on the bloom's own outline at this fraction of the way out. */
const onEdge = (drop, theta, t = 1) => at(drop, theta, drop.radius * radiusFactor(drop, theta) * t)

/** Catmull-Rom through the points, as cubic béziers: a soft outline with no visible joints. */
function curve(pts, closed) {
  const count = pts.length
  const atPoint = (i) => pts[closed ? (i + count) % count : clamp(i, 0, count - 1)]
  let d = `M${n(pts[0][0])} ${n(pts[0][1])}`
  for (let i = 0; i < (closed ? count : count - 1); i++) {
    const p0 = atPoint(i - 1)
    const p1 = atPoint(i)
    const p2 = atPoint(i + 1)
    const p3 = atPoint(i + 2)
    d += `C${n(p1[0] + (p2[0] - p0[0]) / 6)} ${n(p1[1] + (p2[1] - p0[1]) / 6)} ${n(
      p2[0] - (p3[0] - p1[0]) / 6,
    )} ${n(p2[1] - (p3[1] - p1[1]) / 6)} ${n(p2[0])} ${n(p2[1])}`
  }
  return closed ? `${d}Z` : d
}

/** A stretch of the bloom's outline: only part of a wet edge, never a clean ring. */
function edge(drop, from, span, t = 1) {
  const pts = []
  const count = Math.max(5, Math.round(span * 10))
  for (let i = 0; i <= count; i++) {
    pts.push(onEdge(drop, from + span * (i / count), t))
  }
  return curve(pts, false)
}

/**
 * One drop: a field of pigment that thins toward its own outline, a broken wet edge, soft wisps that
 * keep going past it, granulation where it dried, and one quiet mark where it went in. The core
 * settles; the edge keeps moving.
 */
function plume(rng, drop, steep) {
  // Ink on paper can be piled up to a dark core; pigment seen by transmitted light saturates to
  // white instead, so on dark the body is kept low and the marks carry the shape.
  const fieldGain = steep ? 0.78 : 1
  const markGain = steep ? 0.85 : 1
  const alpha = (v, gain = markGain) => Math.min(0.95, v * drop.density * gain)
  const field = []
  const marks = []

  // The pigment field: stamps of wash spread through the bloom's own shape, thinning outward, in
  // a few uneven clusters so the density is never a clean radial ramp (that would read as a
  // gradient). The whole field is blurred once, which leaves no banding to see.
  const clusters = 3 + Math.floor(rng() * 3)
  const seeds = []
  for (let i = 0; i < clusters; i++) {
    seeds.push({
      theta: rng() * TAU,
      reach: 0.12 + 0.72 * Math.pow(rng(), 1.15),
      weight: 0.5 + rng() * 0.9,
    })
  }
  const stamps = 64 + Math.round(46 * drop.spread)
  for (let i = 0; i < stamps; i++) {
    const seed = seeds[Math.floor(rng() * seeds.length)]
    const theta = seed.theta + (rng() - 0.5) * 1.6
    const t = clamp(seed.reach + (rng() - 0.5) * 0.6, 0, 0.98)
    const [cx, cy] = onEdge(drop, theta, t)
    const radius = drop.radius * (0.06 + 0.06 * rng()) * (1 - 0.2 * t)
    const falloff = Math.pow(1 - Math.min(1, t), 0.85)
    field.push(
      `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(radius)}" opacity="${a(
        alpha((0.07 + 0.3 * falloff) * (0.6 + 0.8 * rng()) * seed.weight, fieldGain),
      )}"/>`,
    )
  }

  // The wet edge: two or three stretches where the pigment stopped, not a closed outline.
  const edges = 2 + Math.round(2 * drop.spread)
  for (let i = 0; i < edges; i++) {
    marks.push(
      `<path d="${edge(drop, rng() * TAU, 0.16 + 0.4 * rng(), 0.88)}" fill="none" stroke-width="${n(
        1 + 1.6 * rng(),
      )}" opacity="${a(alpha(0.12 + 0.16 * rng()))}" stroke-linecap="round"/>`,
    )
  }
  // A fainter inner edge, where an earlier wash stopped.
  for (let i = 0; i < 2; i++) {
    marks.push(
      `<path d="${edge(drop, rng() * TAU, 0.12 + 0.28 * rng(), 0.48 + 0.18 * rng())}" fill="none" stroke-width="${n(
        0.8 + 0.8 * rng(),
      )}" opacity="${a(alpha(0.06 + 0.08 * rng()))}" stroke-linecap="round"/>`,
    )
  }

  // The head: pigment that fell straight down is densest where it went in, and it is what gives
  // the bloom its weight against all the pale wash around it.
  const head = 10 + Math.round(8 * (1 - drop.spread))
  for (let i = 0; i < head; i++) {
    const [cx, cy] = onEdge(drop, rng() * TAU, 0.24 * Math.sqrt(rng()))
    field.push(
      `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(drop.radius * (0.05 + 0.05 * rng()))}" opacity="${a(
        alpha(0.16 + 0.14 * rng(), fieldGain),
      )}"/>`,
    )
  }

  // Wisps: the ink keeps going after the body stops, in soft fingers along the flow and off a few
  // crests. The body ends; the diffusion does not.
  const wisps = 5 + Math.round(5 * drop.spread)
  for (let i = 0; i < wisps; i++) {
    const from = drop.rotate + (rng() - 0.5) * (i < wisps / 2 ? 1.2 : 3.2)
    const length = 0.1 + 0.3 * rng()
    const curl = (rng() - 0.5) * 1.4
    const steps = 3 + Math.floor(rng() * 3)
    for (let k = 1; k <= steps; k++) {
      const [cx, cy] = onEdge(drop, from + curl * (k / steps) ** 2, 1 + (length * k) / steps)
      const radius = drop.radius * (0.05 + 0.05 * rng()) * (1 - k / (steps + 2))
      field.push(
        `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(radius * 1.6)}" ry="${n(radius)}" transform="rotate(${n(
          (from * 180) / Math.PI,
        )} ${n(cx)} ${n(cy)})" opacity="${a(alpha(0.05 + 0.07 * (1 - k / steps), fieldGain))}"/>`,
      )
    }
  }
  // A last fleck or two that got furthest, so the edge never quite closes.
  for (let i = 0; i < 2 + Math.round(3 * drop.spread); i++) {
    const [cx, cy] = onEdge(drop, rng() * TAU, 1.02 + 0.3 * rng())
    marks.push(
      `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(0.6 + 1.6 * rng() * rng())}" opacity="${a(
        alpha(0.12 + 0.18 * rng()),
      )}"/>`,
    )
  }

  // Granulation: pigment settling out of the wash, heaviest where the body stopped moving.
  const grains = 16 + Math.round(22 * drop.spread)
  for (let i = 0; i < grains; i++) {
    const [cx, cy] = onEdge(drop, rng() * TAU, 0.25 + 0.7 * Math.sqrt(rng()))
    marks.push(
      `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(0.5 + 1.7 * rng() * rng())}" opacity="${a(
        alpha(0.05 + 0.11 * rng()),
      )}"/>`,
    )
  }

  // Dry-brush: short tangential grazes just inside the edge.
  const streaks = 2 + Math.round(4 * drop.spread)
  for (let i = 0; i < streaks; i++) {
    marks.push(
      `<path d="${edge(drop, rng() * TAU, 0.04 + 0.08 * rng(), 0.55 + 0.28 * rng())}" fill="none" stroke-width="${n(
        0.6 + 1.1 * rng(),
      )}" opacity="${a(alpha(0.05 + 0.08 * rng()))}" stroke-linecap="round"/>`,
    )
  }

  // Granules caught on the edge, in a few turbulent crests: the outside is still moving.
  const crests = 2 + Math.round(3 * drop.spread)
  for (let c = 0; c < crests; c++) {
    const crest = rng() * TAU
    const caught = 2 + Math.floor(5 * rng())
    for (let i = 0; i < caught; i++) {
      const [cx, cy] = onEdge(drop, crest + (rng() - 0.5) * 0.44, 0.86 + 0.16 * rng())
      marks.push(
        `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(0.9 + 4.5 * rng() * rng())}" ry="${n(
          0.9 + 3.5 * rng() * rng(),
        )}" opacity="${a(alpha(0.07 + 0.15 * rng()))}"/>`,
      )
    }
  }
  // Settling: tiny drops that made it a little further than the rest.
  const settling = 4 + Math.round(8 * drop.spread)
  for (let i = 0; i < settling; i++) {
    const [cx, cy] = onEdge(drop, rng() * TAU, 0.95 + 0.75 * rng())
    marks.push(
      `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(0.6 + 1.8 * rng() * rng())}" opacity="${a(
        0.05 + 0.1 * rng(),
      )}"/>`,
    )
  }

  // The entry: one small, quiet, dense mark, and the faint ring of the first moment.
  marks.push(
    `<circle cx="${n(drop.cx)}" cy="${n(drop.cy)}" r="${n(drop.radius * (0.035 + 0.02 * rng()))}" opacity="${a(alpha(steep ? 0.42 : 0.72))}"/>`,
  )
  marks.push(
    `<path d="${edge(drop, rng() * TAU, 5.6, 0.16)}" fill="none" stroke-width="1" opacity="${a(
      alpha(0.07),
    )}"/>`,
  )

  return { field, marks }
}

const GRAIN = (
  seed,
) => `<filter id="grain" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="0.62" numOctaves="3" seed="${seed}"/>
<feColorMatrix type="saturate" values="0"/>
<feComponentTransfer><feFuncA type="linear" slope="1.35" intercept="-0.28"/></feComponentTransfer>
</filter>`

const MOTTLE = (
  seed,
) => `<filter id="mottle" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="0.008 0.013" numOctaves="4" seed="${seed}"/>
<feColorMatrix type="saturate" values="0"/>
</filter>`

/** The piece: one version and its notes, one theme, one SVG document. */
export function draw(plan, theme = 'light') {
  const palette = PALETTE[theme]
  const rng = prng(plan.seed ^ (theme === 'dark' ? 0x9e3779b9 : 0))
  const inks = [0, 1]
    .map((index) => {
      const parts = []
      for (const drop of plan.drops) {
        if (drop.ink !== index) continue
        const { field, marks } = plume(rng, drop, theme === 'dark')
        const bucket = drop.radius > 300 ? 'lg' : drop.radius > 150 ? 'md' : 'sm'
        parts.push(`<g filter="url(#field-${bucket})">${field.join('')}</g>${marks.join('')}`)
      }
      if (parts.length === 0) return ''
      return `<g fill="${palette.inks[index]}" stroke="${palette.inks[index]}">${parts.join('')}</g>`
    })
    .join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">
<defs>
${GRAIN(plan.grainSeed)}
${MOTTLE(plan.mottleSeed)}
<filter id="field-lg" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="14"/></filter>
<filter id="field-md" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="11"/></filter>
<filter id="field-sm" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="5"/></filter>
</defs>
<g style="isolation:isolate">
<rect width="${WIDTH}" height="${HEIGHT}" fill="${palette.ground}"/>
<rect width="${WIDTH}" height="${HEIGHT}" filter="url(#mottle)" opacity="${a(palette.mottle)}" style="mix-blend-mode:${
    palette.blend
  }"/>
<g style="mix-blend-mode:${palette.blend}">${inks}</g>
<rect width="${WIDTH}" height="${HEIGHT}" filter="url(#grain)" opacity="${a(palette.grain)}" style="mix-blend-mode:${palette.blend}"/>
</g>
</svg>
`
}

// ---------------------------------------------------------------------------
// Files

export function fileName(version, theme) {
  return `v${version}-${theme}.svg`
}

export async function readNotesCache() {
  try {
    return JSON.parse(await fs.readFile(NOTES_FILE, 'utf8'))
  } catch {
    return []
  }
}

function capture(versions) {
  return versions.map((version) => {
    const raw = execFileSync(
      'gh',
      ['release', 'view', `v${version}`, '--json', 'name,body', '--jq', '.name, .body'],
      { encoding: 'utf8' },
    )
    const [name, ...rest] = raw.split('\n')
    return { version, name, body: rest.join('\n').trim() }
  })
}

async function main(argv) {
  const flag = (name) => {
    const index = argv.indexOf(`--${name}`)
    return index >= 0 ? argv[index + 1] : undefined
  }
  if (argv.includes('--capture')) {
    const cache = await readNotesCache()
    const versions = (flag('versions') ?? cache.map((r) => r.version).join(','))
      .split(',')
      .map((v) => v.trim().replace(/^v/, ''))
      .filter(Boolean)
    if (versions.length === 0) throw new Error('--capture needs --versions, or a cache to name them')
    const releases = capture(versions)
    await fs.mkdir(path.dirname(NOTES_FILE), { recursive: true })
    await fs.writeFile(NOTES_FILE, `${JSON.stringify(releases, null, 2)}\n`)
    console.log(`captured ${releases.map((r) => r.version).join(', ')}`)
    return
  }

  let releases = await readNotesCache()
  const version = flag('version')
  const notesPath = flag('notes')
  if (notesPath) {
    if (!version) throw new Error('--notes needs --version to say which release it belongs to')
    const body = await fs.readFile(notesPath, 'utf8')
    releases = [...releases.filter((r) => r.version !== version), { version, name: version, body }]
  }
  if (version) releases = releases.filter((r) => r.version === version)
  if (releases.length === 0) {
    throw new Error('no releases to draw: pass --capture, or --version with --notes')
  }

  let stale = 0
  for (const release of releases) {
    for (const theme of THEMES) {
      const svg = draw(plan(release.version, release.body), theme)
      const file = path.join(OUT_DIR, fileName(release.version, theme))
      const bytes = Buffer.byteLength(svg)
      if (bytes > BUDGET_BYTES) {
        throw new Error(`${fileName(release.version, theme)} is ${bytes} bytes, over the budget`)
      }
      if (argv.includes('--check')) {
        let current = ''
        try {
          current = await fs.readFile(file, 'utf8')
        } catch {}
        if (current !== svg) {
          stale += 1
          console.error(`out of date: ${path.relative(REPO, file)}`)
        }
        continue
      }
      await fs.mkdir(OUT_DIR, { recursive: true })
      await fs.writeFile(file, svg)
      console.log(`${path.relative(REPO, file)} ${bytes} bytes`)
    }
  }
  if (argv.includes('--check')) {
    if (stale > 0) process.exitCode = 1
    else console.log('release art is up to date')
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2))
}
