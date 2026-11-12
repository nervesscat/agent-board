#!/usr/bin/env node
/**
 * Release artwork: long exposure.
 *
 * A long exposure keeps the frame open while something moves through it: no object survives, only
 * the direction it went. Each release gets one piece, in a dark and a light variant that share the
 * same drawing and differ only in paper and ink. Everything is derived from the release's version
 * and its notes, so a release nobody has drawn yet gets its own piece:
 *
 *   node scripts/release-art.mjs --release v0.2.4
 *
 * The version's hash drives the vector, the streak lengths, the falloff across the frame and which
 * pigment bleeds in. The notes drive how much of the frame the release fills: how many changes they
 * carry sets the density; how much of them is about agents and shared tickets sets how many bundles
 * the field breaks into and how far the streaks fan; how much is about focus and polish narrows the
 * strokes and sharpens the one still line; how much is about moving things around bands the field and
 * steps it sideways. The derived character is printed, so a piece can be read back to its notes.
 *
 * The output is a pair of committed SVGs. Committed, not built, because an asset cannot change
 * between builds; regeneration from the same notes is byte for byte the same file.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const WIDTH = 1600
const HEIGHT = 900
const STRIDE = 1000 // the streak shape's native length, before its per-instance scale

/** Two hues and a ground, nothing else: a paper, an ink, and one pigment that bleeds in. */
const PIGMENTS = [
  { name: 'rust', light: '#a44e2a', dark: '#d17a4b' },
  { name: 'indigo', light: '#334a72', dark: '#8097c6' },
  { name: 'verdigris', light: '#3d6b5e', dark: '#8fc0ae' },
  { name: 'plum', light: '#683c53', dark: '#bb8ba2' },
  { name: 'ochre', light: '#8c6c26', dark: '#cfac60' },
]

const THEMES = {
  light: {
    ground: '#f3efe5',
    ink: '#191b1f',
    fleck: '#fffdf6',
    washStrength: 1,
    fieldStrength: 1,
    grain: 0.55,
  },
  dark: {
    ground: '#0b0d10',
    ink: '#e9e4d7',
    fleck: '#fffaf0',
    washStrength: 1.3,
    fieldStrength: 0.78,
    grain: 0.6,
  },
}

/**
 * The notes are read by line, not by word: one line of `## What's Changed` is one change that
 * shipped, and the share of those lines matching a theme is that theme's weight for the piece.
 * URLs and authors are stripped first, so the repository's name is not read as a mention of agents.
 */
const THEMES_IN_NOTES = {
  collab:
    /\bagent|\bticket|\blane|shared|delegat|\breview|decision|repl(y|ies)|\bposts?\b|\bteam|worker|orchestrat|brief|attach|feed/i,
  precision:
    /focus|\bring|phone|safe.area|cache|retry|\bclock|sticky|\bcap\b|keep|copy|clipboard|wait|\bcount|minute|header|rememb|\bfix|flaky|reliab|green|re-ask/i,
  wayfinding:
    /\bmove|split|remove|\bmenu|instruction|setting|palette|command|window|fold|cleanup|unpushed|reorder|\brows?\b|first|second|module|overview|\bnav|sidebar|\bfind|search|filter|sort|\bstage|\btabs?\b/i,
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const round = (value, places = 2) => {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}
const num = (value) => String(round(value))

/** FNV-1a, then mulberry32: a tiny deterministic PRNG, no dependency, the same on every machine. */
function hash32(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
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

/** What the notes say the release was made of, as three weights in [0, 1] and a size. */
export function readNotes(notes) {
  const lines = notes
    .split('\n')
    .filter((line) => line.trim().startsWith('* '))
    .map((line) => line.replace(/https?:\/\/\S+/g, '').replace(/by @\S+/g, ''))
  const total = lines.length || 1
  const share = (pattern) => lines.filter((line) => pattern.test(line)).length / total
  return {
    changes: lines.length,
    collab: share(THEMES_IN_NOTES.collab),
    precision: share(THEMES_IN_NOTES.precision),
    wayfinding: share(THEMES_IN_NOTES.wayfinding),
  }
}

/**
 * The composition, as numbers. The theme only maps these to colors, so the dark and the light
 * variant are the same drawing and not two drawings. Positions are in the frame's own coordinates:
 * the vector only turns the strokes, it never throws the field off the canvas.
 */
export function planRelease({ version, notes }) {
  const rng = mulberry32(hash32(`${version}\n${notes}`))
  const read = readNotes(notes)

  // How much of the frame the release fills: the count of what shipped, damped by its square root
  // so a release of one hundred and sixty changes is busy but a release of sixteen is not empty.
  const density = clamp(Math.round(18 + 3.2 * Math.sqrt(read.changes)), 18, 64)
  // Many hands fan the field apart; precision pulls it parallel and thins it; reorganization bands it.
  const bundles = 1 + Math.round(3 * read.collab)
  const bands = 1 + Math.floor(3 * clamp((read.wayfinding - 0.3) / 0.6, 0, 1))
  const fan = 0.35 + 3.4 * read.collab
  const widthScale = 1.2 - 0.4 * read.precision
  const threadAlpha = 0.14 + 0.24 * read.precision
  const opacitySpread = 1 - 0.22 * read.precision

  const direction = rng() < 0.5 ? -1 : 1
  const angle = round(direction * (7 + rng() * 13), 1)
  // The pigment comes from the version alone, not from the notes' length, so two releases of the
  // same size still land on different hues.
  const pigment = PIGMENTS[hash32(version) % PIGMENTS.length]
  const grainSeed = Math.floor(rng() * 10000)

  const radians = (angle * Math.PI) / 180
  const ux = Math.cos(radians)
  const uy = Math.sin(radians)
  const px = -uy
  const py = ux
  // Where the exposure is thickest: off the middle of the frame, never centered.
  const centerX = WIDTH / 2 + (rng() < 0.5 ? -1 : 1) * (60 + rng() * 190)
  const centerY = HEIGHT / 2 + (rng() * 2 - 1) * 110
  const at = (along, across) => ({
    x: round(centerX + ux * along + px * across, 2),
    y: round(centerY + uy * along + py * across, 2),
  })

  const peak = (rng() * 2 - 1) * 210 // the dense band's offset across the vector
  const spread = 330 + rng() * 190 // how far the field reaches across the vector

  const bundleCenters = []
  const bundleTilts = []
  for (let i = 0; i < bundles; i += 1) {
    const offset = bundles === 1 ? 0 : (i - (bundles - 1) / 2) * (140 + rng() * 90)
    bundleCenters.push(peak + offset + (rng() * 2 - 1) * 30)
    bundleTilts.push((rng() * 2 - 1) * (bundles > 1 ? 1.6 : 0.4))
  }

  const bandLanes = []
  if (bands > 1) {
    const span = spread * 1.75
    for (let i = 0; i < bands; i += 1) {
      bandLanes.push({
        across: peak - span / 2 + ((i + 0.5) * span) / bands,
        shift: (rng() * 2 - 1) * 130 + (i - (bands - 1) / 2) * (170 + rng() * 80),
        tilt: (rng() * 2 - 1) * 1.5,
      })
    }
  }

  const streaks = []
  // Three families make a long exposure. Smears are light with no edge left in it, the field's mass.
  // Filaments are the few things bright enough to keep a core while everything around them smeared.
  // Haze is the air itself: the widest, faintest marks, laid under both.
  const hazeCount = Math.round(density * 0.12)
  const filamentCount = Math.round(density * 0.24)
  for (let i = 0; i < density; i += 1) {
    const kind = i < hazeCount ? 'haze' : i < hazeCount + filamentCount ? 'filament' : 'smear'
    const banded = bands > 1
    const lane = banded ? i % bands : Math.floor(rng() * bundles)
    const across = banded
      ? bandLanes[lane].across + (rng() * 2 - 1) * ((spread * 0.9) / bands)
      : bundleCenters[lane] + Math.sign(rng() - 0.5) * rng() ** 1.7 * spread * 0.8
    const tilt = banded ? bandLanes[lane].tilt : bundleTilts[lane]
    const along =
      (rng() < 0.72 ? (rng() * 2 - 1) * 620 : -1300 + rng() * 2600) -
      260 +
      (banded ? bandLanes[lane].shift : 0)
    // A few marks are doubled: the shutter opened twice and left two exposures a step apart.
    const ghost = kind === 'haze' ? 0 : rng() < 0.22 ? 40 + rng() * 110 : 0
    const length =
      kind === 'haze' ? 900 + 1200 * rng() : kind === 'filament' ? 700 + 1900 * rng() : 500 + 1900 * rng()
    const width =
      kind === 'haze'
        ? 90 + rng() * 120
        : kind === 'filament'
          ? (8 + rng() * 16) * widthScale
          : (16 + rng() ** 1.3 * 64) * widthScale
    const alpha =
      kind === 'haze'
        ? 0.05 + rng() * 0.06
        : kind === 'filament'
          ? (0.3 + rng() * 0.34) * opacitySpread
          : (0.16 + rng() ** 1.3 * 0.3) * opacitySpread
    streaks.push({
      ...at(along, across),
      kind,
      length,
      width,
      coreWidth: kind === 'filament' ? (0.9 + rng() * 1.5) * widthScale : 0,
      alpha: round(alpha, 3),
      tilt: round(tilt + (rng() * 2 - 1) * fan * (kind === 'haze' ? 0.5 : 1), 2),
      accent: rng() < (kind === 'filament' ? 0.08 : 0.03),
      ghost,
    })
  }

  const washes = []
  const washCount = 2 + (rng() < 0.4 ? 1 : 0)
  for (let i = 0; i < washCount; i += 1) {
    const along = -620 + rng() * 1240
    const across = peak + (rng() * 2 - 1) * 320
    washes.push({
      ...at(along, across),
      rx: 360 + rng() * 540,
      ry: 110 + rng() * 220,
      tilt: round((rng() * 2 - 1) * 9, 2),
      alpha: round(0.03 + rng() * 0.05, 3),
      accent: i < 2 ? rng() < 0.6 : false,
      fx: 0.25 + rng() * 0.5,
      fy: 0.25 + rng() * 0.5,
    })
  }

  // One still edge: the thing that did not move while the shutter was open. It is a crease in the
  // ground, not a drawn line: the tone steps across it and only part of it catches light.
  const foldAlong = (rng() < 0.5 ? -1 : 1) * (140 + rng() * 260)
  const foldAcross = [-1120, -680, -220, 240, 700, 1140].map((across, i) => ({
    ...at(foldAlong + (rng() * 2 - 1) * (i === 0 || i === 5 ? 150 : 80), across),
    index: i,
  }))
  const foldSide = rng() < 0.5 ? -1 : 1

  const threadAlong = (rng() * 2 - 1) * 130
  const threadAcross = (bands > 1 ? bandLanes[0].across : bundleCenters[0]) + (rng() * 2 - 1) * 70
  const thread = [-1080, -540, 0, 520, 1080].map((across, i) =>
    at(threadAlong + (rng() * 2 - 1) * (i === 0 || i === 4 ? 20 : 12), across + threadAcross),
  )

  const flecks = []
  const fleckCount = 10 + Math.round(10 * read.collab)
  for (let i = 0; i < fleckCount; i += 1) {
    const along = -900 + rng() * 1900
    const across = peak + (rng() * 2 - 1) * spread * 0.9
    flecks.push({
      ...at(along, across),
      length: 18 + rng() * 110,
      width: 0.9 + rng() * 1.1,
      alpha: round(0.25 + rng() * 0.32, 3),
      tilt: round((rng() * 2 - 1) * fan * 0.5, 2),
      light: rng() < 0.72,
    })
  }

  // The field does not fill the frame evenly: one corner stays quiet, as if the light fell off there.
  const veils = []
  const veilCount = 1 + (rng() < 0.5 ? 1 : 0)
  for (let i = 0; i < veilCount; i += 1) {
    const cornerX = rng() < 0.5 ? -80 + rng() * 260 : WIDTH - 180 + rng() * 240
    const cornerY = rng() < 0.5 ? -80 + rng() * 220 : HEIGHT - 180 + rng() * 240
    veils.push({
      x: round(cornerX, 2),
      y: round(cornerY, 2),
      rx: 620 + rng() * 420,
      ry: 380 + rng() * 280,
      tilt: round((rng() * 2 - 1) * 12, 2),
      alpha: round((i === 0 ? 0.55 : 0.32) + rng() * 0.18, 3),
      fx: 0.3 + rng() * 0.4,
      fy: 0.3 + rng() * 0.4,
    })
  }

  const dust = []
  const dustCount = 130 + Math.round(90 * (1 - read.precision)) + Math.round(40 * read.collab)
  for (let i = 0; i < dustCount; i += 1) {
    dust.push({
      x: round(-40 + rng() * (WIDTH + 80), 2),
      y: round(-40 + rng() * (HEIGHT + 80), 2),
      r: round(0.45 + rng() * 1.05, 2),
      alpha: round(0.05 + rng() * 0.26, 3),
    })
  }

  return {
    version,
    angle,
    density,
    bundles,
    bands,
    fan: round(fan, 2),
    pigment,
    grainSeed,
    center: { x: round(centerX, 2), y: round(centerY, 2) },
    peak: round(peak, 2),
    spread: round(spread, 2),
    washes,
    streaks,
    fold: { points: foldAcross.map(({ x, y }) => ({ x, y })), side: foldSide, highlight: [1, 4] },
    thread: { points: thread, alpha: round(threadAlpha, 3) },
    flecks,
    veils,
    dust,
    read,
  }
}

function inkGradient(id, color, stops) {
  return `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">${stops
    .map(([offset, alpha]) => `<stop offset="${offset}" stop-color="${color}" stop-opacity="${alpha}"/>`)
    .join('')}</linearGradient>`
}

function washGradient(id, color, wash) {
  // Uneven stops and an off-center focus, so a wash reads as diffused light and not as a CSS gradient.
  return `<radialGradient id="${id}" cx="0.5" cy="0.5" r="0.42" fx="${num(wash.fx)}" fy="${num(wash.fy)}"><stop offset="0" stop-color="${color}" stop-opacity="${num(wash.alpha)}"/><stop offset="0.46" stop-color="${color}" stop-opacity="${num(wash.alpha * 0.58)}"/><stop offset="0.8" stop-color="${color}" stop-opacity="${num(wash.alpha * 0.16)}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`
}

/**
 * The SVG for one theme. Same plan, so the ink and the paper swap and nothing else moves.
 */
export function renderSVG(plan, themeName) {
  const theme = THEMES[themeName]
  if (!theme) throw new Error(`unknown theme: ${themeName}`)
  const ink = theme.ink
  const pigment = plan.pigment[themeName]
  const geo = (value) => round(value, 2)
  const turned = (tilt) => plan.angle + tilt

  const washDefs = plan.washes
    .map((wash, i) =>
      washGradient(`wash-${i}`, wash.accent ? pigment : ink, {
        ...wash,
        alpha: wash.alpha * theme.washStrength,
      }),
    )
    .join('')

  const washes = plan.washes
    .map(
      (wash, i) =>
        `<ellipse cx="${geo(wash.x)}" cy="${geo(wash.y)}" rx="${geo(wash.rx)}" ry="${geo(wash.ry)}" fill="url(#wash-${i})" transform="rotate(${num(turned(wash.tilt))} ${geo(wash.x)} ${geo(wash.y)})"/>`,
    )
    .join('')

  const field = plan.streaks
    .map((streak) => {
      const scaleX = round(streak.length / STRIDE, 4)
      const glow = streak.accent ? 'url(#glow-accent)' : 'url(#glow-ink)'
      const line = streak.accent ? 'url(#streak-accent)' : 'url(#streak-ink)'
      const radians = (turned(streak.tilt) * Math.PI) / 180
      const place = (href, fill, shift, alpha, height) =>
        `<use href="#${href}" fill="${fill}" opacity="${alpha}" transform="translate(${geo(streak.x + Math.cos(radians) * shift)} ${geo(streak.y + Math.sin(radians) * shift)}) rotate(${num(turned(streak.tilt))}) scale(${scaleX} ${round(height / 2, 3)})"/>`
      const draw = (shift, alpha) => {
        const exposed = round(alpha * theme.fieldStrength, 3)
        const smear = place('trail', glow, shift, exposed, streak.width)
        if (!streak.coreWidth) return smear
        // The filament keeps a line inside its own glow: the one thing bright enough to hold.
        return `${smear}${place('streak', line, shift, round(exposed * 0.92, 3), streak.coreWidth)}`
      }
      return streak.ghost
        ? `${draw(0, streak.alpha)}${draw(streak.ghost, round(streak.alpha * 0.45, 3))}`
        : draw(0, streak.alpha)
    })
    .join('')

  const flecks = plan.flecks
    .map(
      (fleck) =>
        `<use href="#speck" stroke="${fleck.light ? theme.fleck : ink}" opacity="${fleck.alpha}" transform="translate(${geo(fleck.x)} ${geo(fleck.y)}) rotate(${num(turned(fleck.tilt))}) scale(${round(fleck.length / 20, 3)} ${round(fleck.width, 2)})"/>`,
    )
    .join('')

  const veils = plan.veils
    .map(
      (veil) =>
        `<ellipse cx="${geo(veil.x)}" cy="${geo(veil.y)}" rx="${geo(veil.rx)}" ry="${geo(veil.ry)}" fill="url(#veil)" opacity="${num(veil.alpha)}" transform="rotate(${num(veil.tilt)} ${geo(veil.x)} ${geo(veil.y)})"/>`,
    )
    .join('')

  const dust = plan.dust
    .map(
      (dot) =>
        `<circle cx="${geo(dot.x)}" cy="${geo(dot.y)}" r="${num(dot.r)}" fill="${ink}" opacity="${dot.alpha}"/>`,
    )
    .join('')

  const path = (points) => points.map((p, i) => `${i === 0 ? 'M' : 'L'}${geo(p.x)} ${geo(p.y)}`).join(' ')
  const foldPoints = plan.fold.points
  const foldPath = path(foldPoints)
  // The band closes far outside the frame, on the side the crease turns away from.
  const farAlong = plan.fold.side * 2400
  const far = foldPoints.map((p) => ({
    x: p.x + Math.cos((plan.angle * Math.PI) / 180) * farAlong,
    y: p.y + Math.sin((plan.angle * Math.PI) / 180) * farAlong,
  }))
  const bandPath = `${foldPath} L${geo(far[far.length - 1].x)} ${geo(far[far.length - 1].y)} L${geo(far[0].x)} ${geo(far[0].y)} Z`

  // Only the middle of the crease catches light, and it fades back into the ground at both ends.
  const [from, to] = plan.fold.highlight
  const lightPath = path(foldPoints.slice(from, to + 1))
  const lightA = foldPoints[from]
  const lightB = foldPoints[to]
  const lightLength = Math.hypot(lightB.x - lightA.x, lightB.y - lightA.y) || 1
  const lightDir = { x: (lightB.x - lightA.x) / lightLength, y: (lightB.y - lightA.y) / lightLength }
  const lightStart = { x: lightA.x - lightDir.x * 50, y: lightA.y - lightDir.y * 50 }
  const lightEnd = { x: lightB.x + lightDir.x * 50, y: lightB.y + lightDir.y * 50 }

  const threadPoints = plan.thread.points
  const threadPath = path(threadPoints)
  const threadStart = threadPoints[0]
  const threadEnd = threadPoints[threadPoints.length - 1]

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img">
<title>Release artwork for ${plan.version}, ${themeName}</title>
<defs>
${inkGradient('streak-ink', ink, [
  [0, 0],
  [0.16, 0.5],
  [0.5, 1],
  [0.84, 0.36],
  [1, 0],
])}
${inkGradient('streak-accent', pigment, [
  [0, 0],
  [0.2, 0.42],
  [0.55, 0.9],
  [0.86, 0.3],
  [1, 0],
])}
${washDefs}
<linearGradient id="foldlight" gradientUnits="userSpaceOnUse" x1="${geo(lightStart.x)}" y1="${geo(lightStart.y)}" x2="${geo(lightEnd.x)}" y2="${geo(lightEnd.y)}"><stop offset="0" stop-color="${theme.fleck}" stop-opacity="0"/><stop offset="0.3" stop-color="${theme.fleck}" stop-opacity="0.4"/><stop offset="0.6" stop-color="${theme.fleck}" stop-opacity="0.26"/><stop offset="1" stop-color="${theme.fleck}" stop-opacity="0"/></linearGradient>
<linearGradient id="threadfade" gradientUnits="userSpaceOnUse" x1="${geo(threadStart.x)}" y1="${geo(threadStart.y)}" x2="${geo(threadEnd.x)}" y2="${geo(threadEnd.y)}"><stop offset="0" stop-color="${pigment}" stop-opacity="0"/><stop offset="0.16" stop-color="${pigment}" stop-opacity="1"/><stop offset="0.84" stop-color="${pigment}" stop-opacity="0.85"/><stop offset="1" stop-color="${pigment}" stop-opacity="0"/></linearGradient>
<radialGradient id="glow-ink" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${ink}" stop-opacity="0.85"/><stop offset="0.3" stop-color="${ink}" stop-opacity="0.42"/><stop offset="0.64" stop-color="${ink}" stop-opacity="0.13"/><stop offset="1" stop-color="${ink}" stop-opacity="0"/></radialGradient>
<radialGradient id="glow-accent" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${pigment}" stop-opacity="0.8"/><stop offset="0.3" stop-color="${pigment}" stop-opacity="0.38"/><stop offset="0.64" stop-color="${pigment}" stop-opacity="0.12"/><stop offset="1" stop-color="${pigment}" stop-opacity="0"/></radialGradient>
<ellipse id="trail" cx="0" cy="0" rx="${STRIDE / 2}" ry="1"/>
<rect id="streak" width="${STRIDE}" height="2" rx="1"/>
<path id="speck" d="M0 0 H20" stroke-width="2" stroke-linecap="round" fill="none"/>
<g id="field">${field}${flecks}</g>
<radialGradient id="veil" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${theme.ground}" stop-opacity="1"/><stop offset="0.42" stop-color="${theme.ground}" stop-opacity="0.86"/><stop offset="0.74" stop-color="${theme.ground}" stop-opacity="0.34"/><stop offset="1" stop-color="${theme.ground}" stop-opacity="0"/></radialGradient>
<filter id="smear" filterUnits="userSpaceOnUse" x="-300" y="-300" width="${WIDTH + 600}" height="${HEIGHT + 600}" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="10 1.4"/></filter>
<filter id="drift" filterUnits="userSpaceOnUse" x="-200" y="-200" width="${WIDTH + 400}" height="${HEIGHT + 400}" color-interpolation-filters="sRGB">
  <feTurbulence type="fractalNoise" baseFrequency="0.0014 0.003" numOctaves="2" seed="${plan.grainSeed}" result="wave"/>
  <feDisplacementMap in="SourceGraphic" in2="wave" scale="40" xChannelSelector="R" yChannelSelector="G"/>
</filter>
<filter id="grain" filterUnits="userSpaceOnUse" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" color-interpolation-filters="sRGB">
  <feTurbulence type="fractalNoise" baseFrequency="0.74" numOctaves="3" seed="${plan.grainSeed + 1}" stitchTiles="stitch" result="noise"/>
  <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.34 0.34 0.34 0 0" result="alpha"/>
  <feComponentTransfer in="alpha" result="sparse"><feFuncA type="table" tableValues="0 0 0 0 0 0.55 1"/></feComponentTransfer>
  <feComposite in="SourceGraphic" in2="sparse" operator="in"/>
</filter>
</defs>
<rect width="${WIDTH}" height="${HEIGHT}" fill="${theme.ground}"/>
<g filter="url(#drift)">
${washes}
${dust}
<use href="#field" filter="url(#smear)" opacity="0.6"/>
<use href="#field"/>
</g>
${veils}
<path d="${bandPath}" fill="${ink}" opacity="0.07"/>
<path d="${foldPath}" fill="none" stroke="${ink}" stroke-opacity="0.05" stroke-width="26" stroke-linejoin="round" transform="translate(${geo(Math.cos((plan.angle * Math.PI) / 180) * plan.fold.side * 10)} ${geo(Math.sin((plan.angle * Math.PI) / 180) * plan.fold.side * 10)})"/>
<path d="${lightPath}" fill="none" stroke="url(#foldlight)" stroke-width="2.4" stroke-linejoin="round"/>
<path d="${threadPath}" fill="none" stroke="url(#threadfade)" stroke-opacity="${plan.thread.alpha}" stroke-width="1.4" stroke-linecap="round"/>
<rect width="${WIDTH}" height="${HEIGHT}" fill="${ink}" opacity="${theme.grain}" filter="url(#grain)"/>
</svg>
`
}

/** The next release's piece: the same call, with that release's version and notes. */
export function renderRelease(version, notes, themeName) {
  return renderSVG(planRelease({ version, notes }), themeName)
}

export function describePlan(plan) {
  return [
    `${plan.version}: ${plan.streaks.length} strokes, ${plan.bundles} bundle${plan.bundles === 1 ? '' : 's'}`,
    `${plan.bands} band${plan.bands === 1 ? '' : 's'}, vector ${plan.angle}°, ${plan.pigment.name}`,
    `notes: ${plan.read.changes} changes, collab ${plan.read.collab.toFixed(2)}, precision ${plan.read.precision.toFixed(2)}, wayfinding ${plan.read.wayfinding.toFixed(2)}`,
  ].join('; ')
}

function parseArgs(argv) {
  const args = { themes: ['dark', 'light'], out: 'public/release-art' }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--release') args.release = argv[(i += 1)]
    else if (flag === '--notes') args.notes = argv[(i += 1)]
    else if (flag === '--out') args.out = argv[(i += 1)]
    else if (flag === '--themes') args.themes = argv[(i += 1)].split(',')
    else if (flag === '--help' || flag === '-h') args.help = true
    else throw new Error(`unknown argument: ${flag}`)
  }
  return args
}

function main(argv) {
  const args = parseArgs(argv)
  if (args.help || !args.release) {
    console.log(`Usage: node scripts/release-art.mjs --release v0.2.4 [--notes <file>] [--out <dir>]

  --release  the version the piece is seeded by and named after
  --notes    the release notes; defaults to scripts/release-art/notes/<release>.md
  --out      where the SVGs go; defaults to public/release-art
  --themes   comma separated, defaults to "dark,light"

  The notes are read, never fetched, so a regeneration is offline and byte for byte the same file.
  To make the next release's piece:

    gh release view v0.3.0 --json name,body -q '.name + "\\n" + .body' > scripts/release-art/notes/v0.3.0.md
    node scripts/release-art.mjs --release v0.3.0`)
    process.exit(args.help ? 0 : 1)
  }

  const here = dirname(fileURLToPath(import.meta.url))
  const notesPath = resolve(args.notes ?? join(here, 'release-art/notes', `${args.release}.md`))
  const notes = readFileSync(notesPath, 'utf8')
  const plan = planRelease({ version: args.release, notes })
  mkdirSync(resolve(args.out), { recursive: true })
  const written = []
  for (const theme of args.themes) {
    const path = resolve(args.out, `${args.release}-${theme}.svg`)
    const svg = renderSVG(plan, theme)
    writeFileSync(path, svg)
    written.push(`${path} (${Math.round(Buffer.byteLength(svg) / 1024)} KB)`)
  }
  console.log(describePlan(plan))
  console.log(`notes: ${notesPath}`)
  for (const line of written) console.log(`wrote ${line}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
}
