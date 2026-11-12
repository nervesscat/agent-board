#!/usr/bin/env node
// Faceted tension: one abstract SVG piece per release, drawn by a deterministic generator.
//
// The composition is a field of hard-edged planes over a soft, grained field: shards that look like
// they are holding something in, with refracted light on a few edges. The version is the seed, so
// the same release always produces the same bytes, and a release nobody has seen yet needs no
// drawing: point the script at its notes and it gets its own piece.
//
//   node scripts/release-art/generate.mjs --all
//   node scripts/release-art/generate.mjs --version 0.2.5 --notes releases/v0.2.5.md
//   node scripts/release-art/generate.mjs --all --check
//
// The composition rule, what each theme signal does and how to add the next release are in
// scripts/release-art/README.md. The direction's rationale is in
// docs/release-art-faceted-tension.md.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const WIDTH = 1600
export const HEIGHT = 900
export const SIZE_BUDGET = 150 * 1024
export const OUTPUT_DIR = 'src/assets/release-art/faceted-tension'
export const NOTES_DIR = 'scripts/release-art/releases'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')

const PALETTES = {
  light: {
    ground: '#ece7db',
    ink: '#1b1c1e',
    steel: '#2f5464',
    rust: '#b2472e',
    light: '#fbf7ea',
    field: '#e7e2d5',
    deep: '#1e2528',
    seam: '#1b1c1e',
    speck: '#1b1c1e',
  },
  dark: {
    ground: '#101214',
    ink: '#070809',
    steel: '#7c9aa6',
    rust: '#c75b3b',
    light: '#f0e7d4',
    field: '#191d20',
    deep: '#050607',
    seam: '#d8d0be',
    speck: '#d8d0be',
  },
}

const PRECISION_WORDS =
  /focus|rings?\b|safe-area|safe area|sticky|\bcap\b|clock|cache|proxy|retry|\bkeep\b|\balign\b|pixel|small|\bfix(es|ed|ing)?\b|tight|seam|quiet/g
const WAYFINDING_WORDS =
  /\bmove(s|d)?\b|\bsplit|\bmenu|\bpalette|\bremove|\breorg|\bfold\b|\bsearch|\bsidebar|\bnav\b|\bwindow\b|\blayout\b|\bclutter\b|\bpanel/g

/**
 * Themes are read from the release's real notes, not written down per version: the number of
 * changes gives the density, the share of precision words the holding, the share of wayfinding
 * words the clearing. Every value is 0..1 and scales one part of the composition.
 */
export function themesOf(notes) {
  const items = notes.split('\n').filter((line) => /^\s*(?:[*-]|\d+\.)\s+/.test(line)).length
  const text = notes.toLowerCase()
  const count = (re) => (text.match(re) ?? []).length
  const perItem = (n) => n / Math.max(items, 6)
  return {
    items,
    density: clamp01(Math.log2(items + 1) / 7.5),
    holding: clamp01(perItem(count(PRECISION_WORDS)) / 0.8),
    clearing: clamp01(perItem(count(WAYFINDING_WORDS)) / 0.55),
  }
}

export function planFor(version, notes) {
  const seed = hash(`faceted-tension:v${version}`)
  const theme = themesOf(notes)
  const params = parameters(version, theme)
  const field = mulberry32(hash(`field:v${version}`))
  const geo = mulberry32(hash(`geometry:v${version}`))
  const fill = mulberry32(hash(`fill:v${version}`))
  const grid = fieldLines(field, theme, params)
  const cluster = makeCluster(geo, theme)
  let cells = subdivide(cluster, geo, theme, params)
  if (params.corridor >= 32) cells = carveCorridor(cells, geo, theme, params)
  cells = cells.map((poly) => ({ poly, area: Math.abs(polygonArea(poly)) })).filter((cell) => cell.area > 240)
  const edges = collectEdges(cells)
  paint(cells, edges, fill, theme, params)
  const lit = lightEdges(edges, fill, theme)
  return { version, seed, theme, params, grid, cluster, cells, edges, lit }
}

function parameters(version, theme) {
  const r = mulberry32(hash(`params:v${version}`))
  const refraction = -24 + r() * 48
  return {
    refraction,
    planes: Math.round(22 + theme.density * 18 - theme.holding * 8 + r() * 3),
    minCell: 620 + theme.holding * 500,
    cutJitter: (1 - theme.holding * 0.85) * (0.06 + theme.density * 0.12),
    fieldLines: Math.round(46 + theme.density * 54 + r() * 12),
    grainDots: Math.round(130 + theme.density * 90),
    grainAlpha: 0.13 + theme.density * 0.06,
    places: 3 + Math.round(theme.density * 2),
    deepen: 1 + Math.round((1 - theme.holding) * 2),
    refractions: 2 + Math.round((1 - theme.holding) * 2.5),
    corridor: Math.round(Math.pow(theme.clearing, 1.6) * 170 + theme.density * 4),
    corridorAngle: r() * 40 - 20,
    breaks: 0.25 + theme.density * 0.55,
    step: 0.14 + theme.density * 0.2,
  }
}

/** The planes start as one irregular, cropped mass that runs off at least one edge: structure seen
 *  through the frame, never an object floating in it. */
function makeCluster(rng, theme) {
  const w = WIDTH * (0.68 + theme.density * 0.3)
  const h = HEIGHT * (0.74 + theme.density * 0.24)
  const cx = WIDTH * (0.46 + (rng() - 0.5) * 0.12) + theme.clearing * WIDTH * 0.06
  const cy = HEIGHT * (0.46 + (rng() - 0.5) * 0.12)
  let x0 = cx - w / 2
  let x1 = cx + w / 2
  let y0 = cy - h / 2
  let y1 = cy + h / 2
  const sides = shuffle(
    [
      [0, 1],
      [2, 1],
      [0, 3],
      [2, 3],
    ],
    rng,
  )[0]
  for (const side of sides) {
    const reach = 110 + rng() * 300
    if (side === 0) y0 = -reach
    if (side === 1) x1 = WIDTH + reach
    if (side === 2) y1 = HEIGHT + reach
    if (side === 3) x0 = -reach
  }
  const jitter = () => (rng() - 0.5) * 36
  const points = [
    { x: x0 + jitter(), y: y0 + jitter() },
    { x: x1 + jitter(), y: y0 + jitter() },
    { x: x1 + jitter(), y: y1 + jitter() },
    { x: x0 + jitter(), y: y1 + jitter() },
    { x: (x0 + x1) / 2 + jitter() * 2, y: y0 + jitter() },
    { x: x1 + jitter(), y: (y0 + y1) / 2 + jitter() * 2 },
    { x: (x0 + x1) / 2 + jitter() * 2, y: y1 + jitter() },
    { x: x0 + jitter(), y: (y0 + y1) / 2 + jitter() * 2 },
  ]
  return hull(points)
}

/** Splits the mass with straight cuts in two angle families: mostly the refraction angle, some
 *  square to it. Precision releases cut in fewer directions; busy ones splinter in more. */
function subdivide(cluster, rng, theme, params) {
  const cells = [{ poly: cluster, area: Math.abs(polygonArea(cluster)) }]
  const base = (params.refraction * Math.PI) / 180
  for (let i = 0; i < params.planes; i += 1) {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const target = pickWeighted(cells, (cell) => Math.pow(cell.area, 1.2), rng)
      const cell = cells[target]
      const across = longestEdgeAngle(cell.poly) + Math.PI / 2
      const roll = rng()
      let angle
      if (roll < 0.4) angle = across
      else if (roll < 0.66) angle = base
      else if (roll < 0.85) angle = base + Math.PI / 2
      else angle = base + (rng() < 0.5 ? -1 : 1) * (0.35 + rng() * 0.4)
      angle += (rng() - 0.5) * 2 * params.cutJitter
      const center = centroid(cell.poly)
      const span = Math.sqrt(cell.area) * 0.34
      const nx = -Math.sin(angle)
      const ny = Math.cos(angle)
      const offset = (rng() - 0.5) * 2 * span
      const c = nx * center.x + ny * center.y + offset
      const left = clipHalfPlane(cell.poly, nx, ny, c)
      const right = clipHalfPlane(cell.poly, -nx, -ny, -c)
      const leftArea = Math.abs(polygonArea(left))
      const rightArea = Math.abs(polygonArea(right))
      if (left.length < 3 || right.length < 3) continue
      if (leftArea < params.minCell || rightArea < params.minCell) continue
      cells.splice(target, 1, { poly: left, area: leftArea }, { poly: right, area: rightArea })
      break
    }
  }
  return cells.map((cell) => cell.poly)
}

/** A cleared channel through the mass, straight-edged, for the releases about wayfinding. Its
 *  width comes from the notes; a release with nothing to reorganize keeps its mass intact. */
function carveCorridor(cells, rng, theme, params) {
  const angle = (params.refraction * Math.PI) / 180 + Math.PI / 2 + (params.corridorAngle * Math.PI) / 180
  const nx = -Math.sin(angle)
  const ny = Math.cos(angle)
  const center = { x: WIDTH * (0.5 + (rng() - 0.5) * 0.1), y: HEIGHT * (0.5 + (rng() - 0.5) * 0.1) }
  const c = nx * center.x + ny * center.y + (rng() - 0.5) * 90
  const half = params.corridor / 2
  const kept = []
  for (const poly of cells) {
    const below = clipHalfPlane(poly, nx, ny, c - half)
    const above = clipHalfPlane(poly, -nx, -ny, -(c + half))
    if (Math.abs(polygonArea(below)) > 320) kept.push(below)
    if (Math.abs(polygonArea(above)) > 320) kept.push(above)
  }
  return kept
}

function collectEdges(cells) {
  const edges = new Map()
  cells.forEach((cell, index) => {
    const points = cell.poly
    points.forEach((point, i) => {
      const a = roundPoint(point)
      const b = roundPoint(points[(i + 1) % points.length])
      if (Math.hypot(a.x - b.x, a.y - b.y) < 0.8) return
      const first = comparePoints(a, b) <= 0 ? a : b
      const second = first === a ? b : a
      const key = `${first.x},${first.y}|${second.x},${second.y}`
      const edge = edges.get(key)
      if (edge) edge.cells.push(index)
      else edges.set(key, { a: first, b: second, cells: [index], length: Math.hypot(a.x - b.x, a.y - b.y) })
    })
  })
  return [...edges.values()]
}

/** Each plane gets one flat value: quiet tint, mid tint, a deep mass, or an accent plane. A few
 *  get a stepped facet along an edge and a band of refracted light across them. */
function paint(cells, edges, rng, theme, params) {
  const order = shuffle(
    cells.map((_, i) => i),
    rng,
  )
  for (const index of order) cells[index].kind = 'quiet'
  const take = (count, filter, weight = (cell) => Math.pow(cell.area, 0.75)) => {
    const candidates = order.filter((index) => filter(cells[index]))
    const chosen = []
    for (let n = 0; n < count && candidates.length; n += 1) {
      const target = pickWeighted(candidates, (index) => weight(cells[index]), rng)
      chosen.push(candidates.splice(target, 1)[0])
    }
    return chosen
  }
  const pickQuiet = (count, filter, weight) =>
    take(count, (cell) => cell.kind === 'quiet' && filter(cell), weight)
  const deep = pickQuiet(params.deepen, (cell) => cell.area > 6500 && cell.area < 150000)
  for (const index of deep) cells[index].kind = 'deep'
  const accents = pickQuiet(
    params.places,
    (cell) => cell.area > 2400 && cell.area < 52000,
    (cell) => Math.pow(cell.area, 0.35),
  )
  for (const index of accents) cells[index].kind = 'accent'
  for (const index of order) {
    if (cells[index].kind !== 'quiet') continue
    const roll = rng()
    if (roll < 0.4 + theme.holding * 0.1) cells[index].kind = 'mid'
    else if (roll < 0.58) cells[index].kind = 'panel'
  }
  for (const index of order) {
    const cell = cells[index]
    if (cell.kind === 'deep' || cell.kind === 'accent') continue
    if (cell.area < 9000 || rng() > params.step) continue
    const strip = steppedFacet(cell.poly, rng)
    if (strip) cell.step = strip
  }
  const bands = take(params.refractions, (cell) => cell.area > 5200 && cell.kind !== 'quiet')
  for (const index of bands) {
    const band = refractionBand(cells[index].poly, rng, params)
    if (band) cells[index].band = band
  }
}

function steppedFacet(poly, rng) {
  let best = 0
  let bestLength = 0
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const length = Math.hypot(a.x - b.x, a.y - b.y)
    if (length > bestLength) {
      bestLength = length
      best = i
    }
  }
  if (bestLength < 90) return null
  const a = poly[best]
  const b = poly[(best + 1) % poly.length]
  const center = centroid(poly)
  let nx = -(b.y - a.y) / bestLength
  let ny = (b.x - a.x) / bestLength
  if (nx * center.x + ny * center.y < nx * a.x + ny * a.y) {
    nx = -nx
    ny = -ny
  }
  const depth = 6 + rng() * 16
  const c = nx * a.x + ny * a.y + depth
  const strip = clipHalfPlane(poly, nx, ny, c)
  return strip.length >= 3 && Math.abs(polygonArea(strip)) > 240 ? strip : null
}

function refractionBand(poly, rng, params) {
  const angle = (params.refraction * Math.PI) / 180 + (rng() - 0.5) * 0.22
  const nx = -Math.sin(angle)
  const ny = Math.cos(angle)
  const center = centroid(poly)
  const c = nx * center.x + ny * center.y + (rng() - 0.5) * Math.sqrt(Math.abs(polygonArea(poly))) * 0.3
  const width = 18 + rng() * 38
  const near = clipHalfPlane(poly, nx, ny, c + width / 2)
  const band = clipHalfPlane(near, -nx, -ny, -(c - width / 2))
  return band.length >= 3 && Math.abs(polygonArea(band)) > 200 ? { poly: band } : null
}

/** Two edges catch the light. They are broken and offset a hair, so the refraction reads as a
 *  displaced edge rather than a glow. */
function lightEdges(edges, rng, theme) {
  const candidates = edges.filter((edge) => {
    if (edge.length < 140) return false
    const x = (edge.a.x + edge.b.x) / 2
    const y = (edge.a.y + edge.b.y) / 2
    return x > 60 && x < WIDTH - 60 && y > 60 && y < HEIGHT - 60
  })
  if (candidates.length < 2) return []
  const chosen = []
  for (let n = 0; n < 2 && candidates.length; n += 1) {
    const target = pickWeighted(candidates, (edge) => Math.pow(edge.length, 2), rng)
    chosen.push(candidates.splice(target, 1)[0])
  }
  return chosen.map((edge) => {
    const t0 = 0.06 + rng() * 0.14
    const t1 = 0.82 + rng() * 0.12
    const gap = theme.density > 0.7 && rng() < 0.7 ? 0.38 + rng() * 0.24 : null
    const offset = 2.4 + rng() * 2.6
    return { edge, t0, t1, gap, offset }
  })
}

function fieldLines(rng, theme, params) {
  const lines = []
  for (let i = 0; i < params.fieldLines; i += 1) {
    const y = ((i + 0.5) / params.fieldLines) * HEIGHT + (rng() - 0.5) * 5
    const start = rng() < 0.35 ? -60 : rng() * WIDTH * 0.62
    const length = WIDTH * (0.24 + rng() * 0.78)
    lines.push({ x1: start, y1: y, x2: start + length, y2: y, alpha: 0.035 + rng() * 0.055 })
  }
  const hatch = []
  const angle = (params.refraction * Math.PI) / 180
  for (let patch = 0; patch < 2; patch += 1) {
    const cx = WIDTH * (0.16 + rng() * 0.68)
    const cy = HEIGHT * (0.12 + rng() * 0.76)
    for (let i = 0; i < 14; i += 1) {
      const offset = (i - 7) * (9 + theme.holding * 6)
      const x = cx + Math.cos(angle + Math.PI / 2) * offset
      const y = cy + Math.sin(angle + Math.PI / 2) * offset
      const half = 40 + rng() * 120
      hatch.push({
        x1: x - Math.cos(angle) * half,
        y1: y - Math.sin(angle) * half,
        x2: x + Math.cos(angle) * half,
        y2: y + Math.sin(angle) * half,
        alpha: 0.025 + rng() * 0.035,
      })
    }
  }
  return { lines, hatch }
}

export function renderPiece(version, notes, mode) {
  const plan = planFor(version, notes)
  return render(plan, mode)
}

function render(plan, mode) {
  const palette = PALETTES[mode]
  if (!palette) throw new Error(`unknown mode ${mode}`)
  const { theme, params, cells, edges, lit } = plan
  const fillOf = (cell) => cellFill(cell.kind, palette)
  const out = []
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img">`,
  )
  out.push(`<title>CrossBoard ${escapeXml(plan.version)} - faceted tension (${mode})</title>`)
  out.push(
    `<desc>Generated from the release's version and notes. seed ${plan.seed.toString(16)}, density ${theme.density.toFixed(2)}, holding ${theme.holding.toFixed(2)}, clearing ${theme.clearing.toFixed(2)}.</desc>`,
  )
  out.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="${palette.ground}"/>`)
  const suffix = `${plan.version}-${mode}`.replace(/\./g, '-')
  out.push(...field(plan, palette, suffix))
  out.push('<g shape-rendering="geometricPrecision">')
  for (const cell of cells) {
    const fill = fillOf(cell)
    out.push(`<path d="${pathOf(cell.poly)}" fill="${fill}"/>`)
  }
  for (const cell of cells) {
    if (cell.step) {
      out.push(
        `<path d="${pathOf(cell.step)}" fill="${mix(fillOf(cell), palette.light, mode === 'dark' ? 0.1 : 0.2)}"/>`,
      )
    }
  }
  for (const cell of cells) {
    if (!cell.band) continue
    const colour = mix(fillOf(cell), palette.light, mode === 'dark' ? 0.32 : 0.5)
    out.push(`<path d="${pathOf(cell.band.poly)}" fill="${colour}"/>`)
    const line = edgeLine(cell.band.poly)
    out.push(`<path d="${line}" fill="none" stroke="${palette.light}" stroke-width="0.9" opacity="0.6"/>`)
  }
  out.push(...hairlines(edges, palette, params, mode))
  out.push(...litPaths(lit, palette, params))
  out.push('</g>')
  out.push(...grain(plan, palette, suffix))
  out.push('</svg>')
  out.push('')
  return out.join('\n')
}

function cellFill(kind, palette) {
  if (kind === 'deep') return palette.deep
  if (kind === 'accent') return palette.rust
  if (kind === 'panel') return mix(palette.ground, palette.steel, 0.4)
  if (kind === 'mid') return mix(palette.ground, palette.steel, 0.22)
  return mix(palette.ground, palette.steel, 0.08)
}

function field(plan, palette, suffix) {
  const { grid } = plan
  const out = [`<rect width="${WIDTH}" height="${HEIGHT}" fill="${palette.field}"/>`]
  out.push(`<g stroke="${palette.speck}" stroke-linecap="round" shape-rendering="crispEdges">`)
  for (const line of grid.lines) {
    out.push(
      `<path d="M${num(line.x1)} ${num(line.y1)}H${num(line.x2)}" stroke-width="1" opacity="${trim(line.alpha)}"/>`,
    )
  }
  for (const line of grid.hatch) {
    out.push(
      `<path d="M${num(line.x1)} ${num(line.y1)}L${num(line.x2)} ${num(line.y2)}" stroke-width="0.8" opacity="${trim(line.alpha)}"/>`,
    )
  }
  out.push('</g>')
  const drift = mulberry32(hash(`dither:v${plan.version}`))
  const corner = Math.floor(drift() * 4)
  for (let step = 0; step < 4; step += 1) {
    const w = WIDTH * (0.62 - step * 0.13)
    const h = HEIGHT * (0.66 - step * 0.14)
    const x = corner % 2 === 0 ? 0 : WIDTH - w
    const y = corner < 2 ? 0 : HEIGHT - h
    out.push(
      `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" fill="url(#dither-${suffix})" opacity="${trim(0.025 + step * 0.012)}"/>`,
    )
  }
  return out
}

function hairlines(edges, palette, params, mode) {
  const colour = palette.seam
  const alpha = mode === 'dark' ? 0.11 + params.breaks * 0.1 : 0.16 + params.breaks * 0.14
  const out = [`<g fill="none" stroke="${colour}" stroke-linecap="butt">`]
  for (const edge of edges) {
    const a = edge.a
    const b = edge.b
    out.push(
      `<path d="M${num(a.x)} ${num(a.y)}L${num(b.x)} ${num(b.y)}" stroke-width="0.8" opacity="${trim(alpha)}"/>`,
    )
  }
  out.push('</g>')
  return out
}

function litPaths(lit, palette, params) {
  const out = []
  for (const item of lit) {
    const { edge, t0, t1, gap, offset } = item
    const dx = edge.b.x - edge.a.x
    const dy = edge.b.y - edge.a.y
    const length = Math.max(edge.length, 1)
    const ux = dx / length
    const uy = dy / length
    const nx = -uy
    const ny = ux
    const at = (t) => ({ x: edge.a.x + dx * t, y: edge.a.y + dy * t })
    const runs =
      gap === null
        ? [[t0, t1]]
        : [
            [t0, gap - 0.03],
            [gap + 0.03, t1],
          ]
    for (const [from, to] of runs) {
      const p = at(from)
      const q = at(to)
      out.push(
        `<path d="M${num(p.x)} ${num(p.y)}L${num(q.x)} ${num(q.y)}" fill="none" stroke="${palette.light}" stroke-width="${trim(2.6 + params.breaks * 1.6)}" stroke-linecap="butt"/>`,
      )
      out.push(
        `<path d="M${num(p.x + nx * offset)} ${num(p.y + ny * offset)}L${num(q.x + nx * offset)} ${num(q.y + ny * offset)}" fill="none" stroke="${mix(palette.ink, palette.rust, 0.25)}" stroke-width="1" opacity="0.6"/>`,
      )
      out.push(
        `<path d="M${num(p.x - nx * 1.6)} ${num(p.y - ny * 1.6)}L${num(q.x - nx * 1.6)} ${num(q.y - ny * 1.6)}" fill="none" stroke="${palette.rust}" stroke-width="0.9" opacity="0.45"/>`,
      )
    }
  }
  return out
}

function grain(plan, palette, suffix) {
  const rng = mulberry32(hash(`grain:v${plan.version}`))
  const dots = []
  for (let i = 0; i < plan.params.grainDots; i += 1) {
    const x = Math.round(rng() * 68 * 10) / 10
    const y = Math.round(rng() * 68 * 10) / 10
    const wide = rng() > 0.72
    const tall = rng() > 0.86
    dots.push(
      `<rect x="${trim(x)}" y="${trim(y)}" width="${wide ? 1.6 : 1}" height="${tall ? 1.6 : 1}" opacity="${trim(0.3 + rng() * 0.5)}"/>`,
    )
  }
  const speck = palette.speck
  const out = [
    `<defs><pattern id="grain-${suffix}" width="68" height="68" patternUnits="userSpaceOnUse" fill="${speck}">${dots.join('')}</pattern>`,
    `<pattern id="dither-${suffix}" width="5" height="5" patternUnits="userSpaceOnUse" fill="${palette.speck}"><rect width="1" height="1"/><rect x="2.5" y="2.5" width="1" height="1"/></pattern></defs>`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#grain-${suffix})" opacity="${trim(plan.params.grainAlpha)}"/>`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#dither-${suffix})" opacity="${trim(0.05 + plan.theme.density * 0.03)}"/>`,
  ]
  return out
}

// --- geometry ------------------------------------------------------------------------------------

function clipHalfPlane(poly, nx, ny, c) {
  const out = []
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const da = nx * a.x + ny * a.y - c
    const db = nx * b.x + ny * b.y - c
    if (da <= 0) out.push(a)
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db)
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
    }
  }
  return dedupe(out)
}

function dedupe(points) {
  const out = []
  for (const point of points) {
    const last = out[out.length - 1]
    if (!last || Math.hypot(point.x - last.x, point.y - last.y) > 0.01) out.push(point)
  }
  if (out.length > 2) {
    const first = out[0]
    const last = out[out.length - 1]
    if (Math.hypot(first.x - last.x, first.y - last.y) < 0.01) out.pop()
  }
  return out
}

function polygonArea(poly) {
  let sum = 0
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    sum += a.x * b.y - b.x * a.y
  }
  return sum / 2
}

function centroid(poly) {
  let area = 0
  let x = 0
  let y = 0
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const cross = a.x * b.y - b.x * a.y
    area += cross
    x += (a.x + b.x) * cross
    y += (a.y + b.y) * cross
  }
  if (Math.abs(area) < 1e-6) return poly[0]
  return { x: x / (3 * area), y: y / (3 * area) }
}

function longestEdgeAngle(poly) {
  let best = 0
  let length = 0
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const size = Math.hypot(b.x - a.x, b.y - a.y)
    if (size > length) {
      length = size
      best = Math.atan2(b.y - a.y, b.x - a.x)
    }
  }
  return best
}

function hull(points) {
  const sorted = points.slice().sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower = []
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0)
      lower.pop()
    lower.push(point)
  }
  const upper = []
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const point = sorted[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0)
      upper.pop()
    upper.push(point)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

// --- small tools ---------------------------------------------------------------------------------

function clamp01(value) {
  return Math.max(0, Math.min(1, value))
}

function hash(text) {
  let value = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i)
    value = Math.imul(value, 0x01000193)
  }
  return value >>> 0
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

function shuffle(items, rng) {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function pickWeighted(items, weight, rng) {
  const total = items.reduce((sum, item) => sum + weight(item), 0)
  let target = rng() * total
  for (let i = 0; i < items.length; i += 1) {
    target -= weight(items[i])
    if (target <= 0) return i
  }
  return items.length - 1
}

function rgb(hex) {
  const value = parseInt(hex.slice(1), 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

function mix(a, b, t) {
  const ca = rgb(a)
  const cb = rgb(b)
  const channel = (x, y) =>
    Math.round(x + (y - x) * t)
      .toString(16)
      .padStart(2, '0')
  return `#${channel(ca.r, cb.r)}${channel(ca.g, cb.g)}${channel(ca.b, cb.b)}`
}

function num(value) {
  return String(Math.round(value * 100) / 100)
}

function trim(value) {
  return String(Math.round(value * 1000) / 1000)
}

function roundPoint(point) {
  return { x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 }
}

function comparePoints(a, b) {
  return a.x - b.x || a.y - b.y
}

function pathOf(poly) {
  return `M${poly.map((p) => `${num(p.x)} ${num(p.y)}`).join('L')}Z`
}

function edgeLine(poly) {
  const a = poly[0]
  const b = poly[1]
  return `M${num(a.x)} ${num(a.y)}L${num(b.x)} ${num(b.y)}`
}

function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// --- command line --------------------------------------------------------------------------------

export function generate(version, notes, mode) {
  const svg = renderPiece(version, notes, mode)
  const bytes = Buffer.byteLength(svg)
  if (bytes > SIZE_BUDGET) throw new Error(`${version}-${mode}.svg is ${bytes} bytes, over the budget`)
  return svg
}

function args(argv) {
  const out = { all: false, check: false, version: null, notes: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--all') out.all = true
    else if (arg === '--check') out.check = true
    else if (arg === '--version') out.version = argv[(i += 1)]
    else if (arg === '--notes') out.notes = argv[(i += 1)]
    else throw new Error(`unknown argument ${arg}`)
  }
  return out
}

function writePiece(version, notes, outDir, check) {
  let changed = false
  for (const mode of ['dark', 'light']) {
    const svg = generate(version, notes, mode)
    const file = path.join(outDir, `${version}-${mode}.svg`)
    if (check) {
      const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
      if (current !== svg) {
        changed = true
        console.error(`drift: ${path.relative(ROOT, file)}`)
      }
    } else {
      fs.mkdirSync(outDir, { recursive: true })
      fs.writeFileSync(file, svg)
      console.log(`${path.relative(ROOT, file)} (${(Buffer.byteLength(svg) / 1024).toFixed(1)} KB)`)
    }
  }
  return changed
}

function main() {
  const options = args(process.argv.slice(2))
  const outDir = path.join(ROOT, OUTPUT_DIR)
  let drift = false
  if (options.all) {
    const dir = path.join(ROOT, NOTES_DIR)
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .sort()
    const versions = files.map((name) => name.replace(/^v/, '').replace(/\.md$/, ''))
    for (const version of versions) {
      const notes = fs.readFileSync(path.join(dir, `v${version}.md`), 'utf8')
      drift = writePiece(version, notes, outDir, options.check) || drift
    }
    const expected = new Set(versions.flatMap((version) => [`${version}-dark.svg`, `${version}-light.svg`]))
    const present = fs.existsSync(outDir) ? fs.readdirSync(outDir) : []
    for (const name of present) {
      if (!name.endsWith('.svg') || expected.has(name)) continue
      const file = path.relative(ROOT, path.join(outDir, name))
      if (options.check) {
        drift = true
        console.error(`stale: ${file}`)
      } else {
        fs.unlinkSync(path.join(outDir, name))
        console.log(`removed ${file} (no notes snapshot)`)
      }
    }
  } else if (options.version && options.notes) {
    if (!path.basename(options.notes).includes(options.version)) {
      console.error(
        `warning: ${options.notes} does not name ${options.version}; check it is that release's notes`,
      )
    }
    drift = writePiece(
      options.version,
      fs.readFileSync(path.resolve(options.notes), 'utf8'),
      outDir,
      options.check,
    )
  } else {
    throw new Error('give --all, or --version <x.y.z> --notes <release notes file>')
  }
  if (options.check && drift) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
