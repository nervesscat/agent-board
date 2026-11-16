#!/usr/bin/env node
// Release artwork, direction "ikat": a warp-ikat cloth seen flat.
//
// The piece is 200 vertical warp threads. Before weaving, groups of threads (courses) are bound and
// dyed in two or three hues; on the loom every bundle of threads slips a little along its length, so
// each block of colour ends in the stepped, feathered edge that ikat is known by. Colour is carried
// by threads only: there is no outline, no curve and no shape drawn on top of the cloth.
//
// The release's notes set the binding (how many courses, how many blocks, how far they are staggered
// or stepped, what was left undyed) and the slip (how far the threads drifted). The version seeds
// every remaining choice, so the same version and notes write the same bytes on every run. A release
// nobody has seen needs only its notes file.
//
//   node scripts/release-art/ikat.mjs                      every release in notes/, into the assets folder
//   node scripts/release-art/ikat.mjs --out /tmp/art       the same, somewhere else
//   node scripts/release-art/ikat.mjs --version v0.3.0 \
//     --notes scripts/release-art/notes/v0.3.0.md --out /tmp/art
//
// Notes for a new release:
//   gh release view vX.Y.Z --json body --jq .body > scripts/release-art/notes/vX.Y.Z.md

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const NOTES_DIR = join(ROOT, 'scripts/release-art/notes')
const DEFAULT_OUT = join(ROOT, 'src/assets/release-art/ikat')

export const WIDTH = 1600
export const HEIGHT = 900
export const THREADS = 200
const PITCH = WIDTH / THREADS

// Undyed cotton, an indigo vat, madder and a little weld. In light the cloth is undyed and the blocks
// are indigo; in dark the cloth is vat-dyed and the blocks are the cotton the ties kept white.
export const PALETTE = {
  cotton: '#EAE2D1',
  vat: '#1A2036',
  indigo: '#2C3E6E',
  madder: '#B9492D',
  weld: '#C9A03C',
}
export const PALETTE_HEXES = Object.values(PALETTE)

const MODES = {
  light: { ground: PALETTE.cotton, shade: PALETTE.vat, hues: [PALETTE.indigo, PALETTE.madder, PALETTE.weld] },
  dark: { ground: PALETTE.vat, shade: PALETTE.cotton, hues: [PALETTE.cotton, PALETTE.madder, PALETTE.weld] },
}

// ---------------------------------------------------------------------------------------------
// Seeded randomness

export function seedOf(version) {
  let hash = 0x811c9dc5
  for (const char of `ikat:${version}`) {
    hash ^= char.codePointAt(0)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function randomFrom(seed) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  next.between = (low, high) => low + (high - low) * next()
  next.int = (low, high) => Math.floor(next.between(low, high + 1))
  next.pick = (list) => list[Math.floor(next() * list.length)]
  return next
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value))
const lerp = (from, to, t) => from + (to - from) * t
const round1 = (value) => Math.round(value * 10) / 10

// ---------------------------------------------------------------------------------------------
// Reading the notes

const THEMES = {
  // many hands: agents, reviews, queues, people working on one thing
  hands:
    /\bagents?\b|\breviews?\b|\bprs?\b|pull request|queue|delegat|orchestrat|worker|\bteam\b|\blanes?\b|hand-?off|decision|skills?\b|session|shared|token/,
  // things holding: fixes, limits, things kept in place
  hold: /\bfix|\bkeep|\bcap\b|retry|cache|sticky|remember|focus|safe area|proxy|stall|clock|\block\b|settle|guard|\bpin\b|inside|only\b/,
  // wayfinding: things moved, split, renamed, found
  way: /\bmove|split|menu|palette|rename|sidebar|\binto\b|\bfold\b|window|header|\brow\b|beside|search|filter|step to|link/,
  // what was taken away
  removed: /\bremove|\bdrop\b|delete|no longer|\bleave\b|stops? showing|\bnot under\b/,
  // repair after something broke
  repair: /\bfix|flaky|retry|restart|\bdies\b|refus|missing|\blose\b|fail|stale|headroom|reliable|settle/,
}

export function readThemes(notes) {
  const items = notes
    .split(/\r?\n/)
    .filter((line) => /^\s*[*-]\s+/.test(line))
    .map((line) =>
      line
        .replace(/^\s*[*-]\s+/, '')
        .replace(/\s+by @\S+ in \S+\s*$/, '')
        .toLowerCase(),
    )
    .filter((line) => !/^release\b|^version\b|^bump\b/.test(line))
  const count = Math.max(1, items.length)
  const share = (pattern) => items.filter((item) => pattern.test(item)).length / count
  return {
    items: items.length,
    hands: round3(share(THEMES.hands)),
    hold: round3(share(THEMES.hold)),
    way: round3(share(THEMES.way)),
    removed: round3(share(THEMES.removed)),
    repair: round3(share(THEMES.repair)),
  }
}

const round3 = (value) => Math.round(value * 1000) / 1000

// ---------------------------------------------------------------------------------------------
// The binding plan: which threads are dyed where, before any thread slips

export function planPiece(version, themes, seed) {
  const random = randomFrom(seed)
  const size = clamp(Math.log2(Math.max(2, themes.items)) / Math.log2(160), 0, 1) // 0 small, 1 huge
  const total = themes.hands + themes.hold + themes.way || 1
  const hands = themes.hands / total
  const hold = themes.hold / total
  const way = themes.way / total

  // How many courses the warp is bound in, and how many bands of colour run across them.
  const courses = clamp(Math.round(lerp(4, 15, size ** 1.6) + hands * 3), 4, 16)
  const rows = size > 0.82 ? 3 : size > 0.62 ? 2 : 1
  // Stagger: neighbouring courses pushed apart, up then down (many hands, each its own).
  const stagger = clamp(hands * 2 - hold * 0.5 - way * 0.9, 0, 1)
  // Drift: the courses step one way across the cloth (a route).
  const drift = clamp(way * 2.1 - hold * 0.7, 0, 1)
  // Slip: how far the bundles slid on the loom. Tight when things hold, loose after repairs and in
  // a big release.
  const slip = round1(clamp(6 + 90 * themes.repair + 14 * size - 14 * hold, 5, 40))
  const ghosts = clamp(Math.round(themes.removed * themes.items * 0.5), 0, rows + 1)
  const ties = clamp(Math.round(hold * 4.4 - 0.6), 0, 3)

  // The dyed field: bare cloth on each side, a little off centre. A huge release runs off both edges.
  const span = Math.round(lerp(104, 214, size ** 2))
  const lean = random.between(-0.5, 0.5)
  const first = Math.round((THREADS - span) / 2 + lean * Math.max(0, THREADS - span) * 0.4)

  // Course widths in threads. The courses touch: a band is one piece with a stepped edge.
  const weights = Array.from({ length: courses }, () => random.between(0.65, 1.5))
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0)
  const widths = weights.map((weight) => Math.max(3, Math.round((weight / weightSum) * span)))

  const direction = random() < 0.5 ? -1 : 1
  const phase = random() < 0.5 ? 0 : 1
  const centre = HEIGHT / 2 + random.between(-20, 20)
  const travel = drift * lerp(330, 440, 1 - size)
  const push = stagger * lerp(40, 78, 1 - size)
  const bandHeight = rows === 1 ? lerp(210, 150, Math.max(drift, stagger)) : rows === 2 ? 142 : 112
  const bare = rows === 1 ? 0 : lerp(54, 76, random()) // the cloth left between two bands
  const period = bandHeight + bare

  // Every band follows the same steps, so the bare cloth between two bands steps with them.
  const steps = []
  for (let course = 0; course < courses; course++) {
    const u = courses === 1 ? 0 : course / (courses - 1) - 0.5
    const side = (course + phase) % 2 === 0 ? -1 : 1
    const loose = (1 - hold * 0.7) * 14
    steps.push(direction * u * travel + side * push * random.between(0.55, 1) + random.between(-loose, loose))
  }

  // Keep the whole binding on the cloth: centre the steps, and shorten them if they would run off.
  const reach = ((rows - 1) * period + bandHeight * 1.12) / 2
  const room = HEIGHT / 2 - 64 - reach
  const high = Math.max(...steps)
  const low = Math.min(...steps)
  const fit = Math.min(1, (2 * Math.max(20, room)) / Math.max(1, high - low))
  for (let course = 0; course < courses; course++) steps[course] = (steps[course] - (high + low) / 2) * fit

  // A band is dyed in one hue; with many hands a run of courses in it is dyed in the other.
  const bandHue = (row) => row % 2
  const blocks = []
  for (let row = 0; row < rows; row++) {
    const hue = bandHue(row)
    const other = hue === 0 ? 1 : 0
    const runs = hands > 0.3 ? 1 + (size > 0.8 ? 1 : 0) : 0
    const swapped = new Set()
    for (let n = 0; n < runs; n++) {
      const length = random.int(1, 3)
      const start = random.int(0, courses - length)
      for (let c = start; c < start + length; c++) swapped.add(c)
    }
    // One over-dyed core runs through part of the band.
    const coreLength = random.int(
      Math.max(1, Math.round(courses * 0.2)),
      Math.max(2, Math.round(courses * 0.45)),
    )
    const coreStart = random.int(0, courses - coreLength)
    const coreAt = random.between(0.32, 0.56)
    const coreSize = random.between(0.14, 0.22)
    const offset = (row - (rows - 1) / 2) * period
    const grow = random.between(-0.06, 0.06)
    let thread = first
    for (let course = 0; course < courses; course++) {
      const height = bandHeight * (1 + grow + random.between(-0.1, 0.1) * (1 - hold * 0.6))
      const y = centre + offset + steps[course]
      const blockHue = swapped.has(course) ? other : hue
      const cored = course >= coreStart && course < coreStart + coreLength
      blocks.push({
        row,
        course,
        from: thread,
        to: thread + widths[course],
        y0: round1(y - height / 2),
        y1: round1(y + height / 2),
        hue: blockHue,
        core: cored
          ? {
              hue: blockHue === 0 ? 1 : row % 2 === 0 ? 2 : 0,
              y0: round1(y - height / 2 + height * coreAt),
              y1: round1(y - height / 2 + height * (coreAt + coreSize)),
            }
          : null,
        ghost: false,
      })
      thread += widths[course]
    }
  }
  const last = first + widths.reduce((sum, width) => sum + width, 0)

  // What the release took away: a course bound but never dyed, never at the end of a band.
  for (let n = 0; n < ghosts; n++) {
    const candidates = blocks.filter(
      (block) =>
        block.course > 0 &&
        block.course < courses - 1 &&
        !blocks.some((b) => b.ghost && (b.row === block.row || Math.abs(b.course - block.course) < 2)),
    )
    if (candidates.length === 0) break
    const taken = random.pick(candidates)
    taken.ghost = true
    taken.core = null
  }

  // Things holding: narrow ties across the field, above and below the bands.
  const top = Math.min(...blocks.map((block) => block.y0))
  const bottom = Math.max(...blocks.map((block) => block.y1))
  const lines = []
  for (let n = 0; n < ties; n++) {
    const above = n % 2 === 1
    const away = 40 + Math.floor(n / 2) * 26 + random.between(0, 8)
    const y = above ? top - away : bottom + away
    if (y < 56 || y > HEIGHT - 56) continue
    const inset = random.int(0, Math.round(span * 0.18))
    lines.push({
      from: clamp(first + (n === 0 ? 0 : inset), 0, THREADS),
      to: clamp(last - (n === 1 ? 0 : random.int(0, Math.round(span * 0.18))), 0, THREADS),
      y0: round1(y - 3.5),
      y1: round1(y + 3.5),
      hue: n === 0 ? 2 : n === 1 ? 0 : 1,
    })
  }

  return {
    version,
    seed,
    themes,
    binding: {
      courses,
      rows,
      stagger: round3(stagger),
      drift: round3(drift),
      slip,
      ghosts,
      ties: lines.length,
    },
    field: { first, last },
    blocks,
    lines,
  }
}

// ---------------------------------------------------------------------------------------------
// The loom: threads, bundles and their slip

function loom(plan) {
  const random = randomFrom(plan.seed ^ 0x9e3779b9)
  const slip = plan.binding.slip
  const threads = []
  let wave = random.between(-1, 1)
  let index = 0
  while (index < THREADS) {
    const size = random.int(3, 7)
    // Bundles wander: each one starts from its neighbour's slip and moves a little.
    wave = clamp(wave * 0.72 + random.between(-0.75, 0.75), -1.6, 1.6)
    const bundle = wave * slip
    for (let n = 0; n < size && index < THREADS; n++, index++) {
      const stray = random() < 0.045 ? random.between(-2.6, 2.6) * slip : 0
      threads.push({
        x: round1(PITCH / 2 + index * PITCH + random.between(-0.5, 0.5)),
        slip: bundle + random.between(-0.22, 0.22) * slip + stray,
        width: random.pick([6.1, 6.6, 6.6, 7.1]),
        take: random.pick([0, 1, 1, 2]), // how much dye the thread took
        tint: random.pick([0, 0, 1, 1, 2, 3]),
        bleed: random.between(0.5, 1.5),
      })
    }
  }
  return { threads, random }
}

// ---------------------------------------------------------------------------------------------
// Drawing

function strokes(layers, key, x, y0, y1) {
  if (y1 - y0 < 0.4) return
  const top = clamp(y0, -2, HEIGHT + 2)
  const bottom = clamp(y1, -2, HEIGHT + 2)
  if (bottom - top < 0.4) return
  layers.set(key, `${layers.get(key) ?? ''}M${x} ${round1(top)}V${round1(bottom)}`)
}

export function renderPiece(plan, modeName) {
  const mode = MODES[modeName]
  const { threads, random } = loom(plan)
  const dark = modeName === 'dark'

  // The cloth itself: every thread a slightly different shade of the ground.
  const cloth = new Map()
  for (const thread of threads) {
    if (thread.tint > 0) strokes(cloth, `${thread.tint}|${thread.width}`, thread.x, 0, HEIGHT)
  }

  // Dyed lengths, grouped by hue, by how much dye the thread took and by thread width.
  const dyed = new Map()
  const paint = (hue, from, to, y0, y1, bleedScale = 1) => {
    for (let index = Math.max(0, from); index < Math.min(THREADS, to); index++) {
      const thread = threads[index]
      const a = y0 + thread.slip
      const b = y1 + thread.slip
      strokes(dyed, `${hue}|${thread.take}|${thread.width}`, thread.x, a, b)
      // Dye wicks a little way under the ties, thinner as it goes.
      const reach = thread.bleed * bleedScale * (5 + plan.binding.slip * 0.45)
      strokes(dyed, `${hue}|3|${thread.width}`, thread.x, a - reach, a)
      strokes(dyed, `${hue}|3|${thread.width}`, thread.x, b, b + reach)
      strokes(dyed, `${hue}|4|${thread.width}`, thread.x, a - reach * 2.1, a - reach)
      strokes(dyed, `${hue}|4|${thread.width}`, thread.x, b + reach, b + reach * 2.1)
    }
  }
  const ghost = (hue, from, to, y0, y1) => {
    // Bound, then barely dyed: a pale wash where the colour was held back.
    for (let index = Math.max(0, from); index < Math.min(THREADS, to); index++) {
      const thread = threads[index]
      const a = y0 + thread.slip
      const b = y1 + thread.slip
      strokes(dyed, `${hue}|${thread.take === 2 ? 3 : 4}|${thread.width}`, thread.x, a, b)
    }
  }

  const cores = []
  for (const block of plan.blocks) {
    if (block.ghost) {
      ghost(block.hue, block.from, block.to, block.y0, block.y1)
      continue
    }
    paint(block.hue, block.from, block.to, block.y0, block.y1)
    if (block.core) cores.push(block)
  }
  for (const line of plan.lines) paint(line.hue, line.from, line.to, line.y0, line.y1, 0.35)

  // A second binding inside a block: the core is over-dyed, so it is drawn after its block.
  const over = new Map()
  for (const block of cores) {
    for (let index = block.from; index < Math.min(THREADS, block.to); index++) {
      const thread = threads[index]
      const a = block.core.y0 + thread.slip * 1.2
      const b = block.core.y1 + thread.slip * 1.2
      const reach = thread.bleed * (4 + plan.binding.slip * 0.3)
      strokes(over, `${block.core.hue}|${thread.take}|${thread.width}`, thread.x, a, b)
      strokes(over, `${block.core.hue}|3|${thread.width}`, thread.x, a - reach, a)
      strokes(over, `${block.core.hue}|3|${thread.width}`, thread.x, b, b + reach)
    }
  }

  // Slubs: short thick places in the yarn, anywhere on the cloth.
  let slubs = ''
  for (let n = 0; n < 46; n++) {
    const thread = random.pick(threads)
    const y = random.between(10, HEIGHT - 30)
    slubs += `M${thread.x} ${round1(y)}v${round1(random.between(5, 22))}`
  }

  const takeOpacity = dark ? [0.86, 0.93, 1, 0.46, 0.2] : [0.8, 0.9, 1, 0.5, 0.22]
  const tintOpacity = dark ? [0, 0.035, 0.07, 0.11] : [0, 0.03, 0.06, 0.1]
  const out = []
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Release artwork ${plan.version}">`,
    '<defs>',
    // Weft: a plain weave shows as short ticks where the weft crosses over the warp.
    `<pattern id="w" width="${PITCH * 2}" height="10" patternUnits="userSpaceOnUse"><path d="M0.6 2.5h6.8M${PITCH + 0.6} 7.5h6.8" stroke="${mode.ground}" stroke-width="1.5" opacity="${dark ? 0.4 : 0.42}"/><path d="M0.6 7.5h6.8M${PITCH + 0.6} 2.5h6.8" stroke="${mode.shade}" stroke-width="1" opacity="${dark ? 0.1 : 0.08}"/></pattern>`,
    // Dye is never even: a slow mottle along the warp, and a fine tooth over everything.
    '<filter id="m" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.012 0.0016" numOctaves="3" seed="' +
      (plan.seed % 997) +
      `"/><feColorMatrix values="0 0 0 0 ${dark ? 0.1 : 0.92} 0 0 0 0 ${dark ? 0.125 : 0.89} 0 0 0 0 ${dark ? 0.21 : 0.82} 0 0 0 ${dark ? 1.5 : 1.3} ${dark ? -0.55 : -0.5}"/></filter>`,
    '<filter id="g" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="' +
      (plan.seed % 991) +
      '"/><feColorMatrix values="0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 0.9 -0.28"/></filter>',
    '</defs>',
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${mode.ground}"/>`,
  )
  out.push(`<g fill="none" stroke="${mode.shade}">`)
  for (const key of [...cloth.keys()].sort()) {
    const [tint, width] = key.split('|')
    out.push(`<path stroke-width="${width}" opacity="${tintOpacity[Number(tint)]}" d="${cloth.get(key)}"/>`)
  }
  out.push('</g>')
  const emit = (layers) => {
    out.push('<g fill="none">')
    for (const key of [...layers.keys()].sort()) {
      const [hue, take, width] = key.split('|')
      const colour = mode.hues[Number(hue)]
      const opacity = takeOpacity[Number(take)]
      out.push(
        `<path stroke="${colour}" stroke-width="${width}" opacity="${opacity}" d="${layers.get(key)}"/>`,
      )
    }
    out.push('</g>')
  }
  emit(dyed)
  emit(over)
  out.push(
    `<path fill="none" stroke="${mode.shade}" stroke-width="7.6" opacity="${dark ? 0.12 : 0.1}" d="${slubs}"/>`,
    `<rect width="${WIDTH}" height="${HEIGHT}" filter="url(#m)" opacity="${dark ? 0.34 : 0.42}"/>`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#w)"/>`,
    `<rect width="${WIDTH}" height="${HEIGHT}" filter="url(#g)" opacity="${dark ? 0.3 : 0.34}" style="mix-blend-mode:${dark ? 'overlay' : 'multiply'}"/>`,
    '</svg>',
  )
  return `${out.join('\n')}\n`
}

// ---------------------------------------------------------------------------------------------
// Command line

function parseArgs(argv) {
  const args = { out: null, version: null, notes: null }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`)
      return next
    }
    if (flag === '--out') args.out = value()
    else if (flag === '--version') args.version = value()
    else if (flag === '--notes') args.notes = value()
    else
      throw new Error(
        `Unknown argument ${flag}. Usage: node scripts/release-art/ikat.mjs [--version vX.Y.Z --notes FILE] [--out DIR]`,
      )
  }
  if ((args.version === null) !== (args.notes === null)) throw new Error('--version and --notes go together')
  return args
}

function notesFiles() {
  const order = (file) => file.match(/\d+/g).map(Number)
  return readdirSync(NOTES_DIR)
    .filter((file) => /^v\d+\.\d+\.\d+\.md$/.test(file))
    .sort((a, b) => {
      const [x, y] = [order(a), order(b)]
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
    })
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const outDir = resolve(args.out ?? DEFAULT_OUT)
  const single = args.version !== null
  const jobs = single
    ? [{ version: `v${args.version.replace(/^v/, '')}`, file: resolve(args.notes) }]
    : notesFiles().map((file) => ({ version: file.replace(/\.md$/, ''), file: join(NOTES_DIR, file) }))
  if (jobs.length === 0) throw new Error(`No release notes in ${NOTES_DIR}`)
  mkdirSync(outDir, { recursive: true })

  const releases = []
  for (const job of jobs) {
    const themes = readThemes(readFileSync(job.file, 'utf8'))
    const seed = seedOf(job.version)
    const plan = planPiece(job.version, themes, seed)
    const files = {}
    for (const mode of Object.keys(MODES)) {
      const name = `${job.version}-${mode}.svg`
      const svg = renderPiece(plan, mode)
      writeFileSync(join(outDir, name), svg)
      files[mode] = { file: name, bytes: Buffer.byteLength(svg) }
    }
    releases.push({
      version: job.version,
      notes: single ? null : `scripts/release-art/notes/${job.version}.md`,
      seed,
      themes,
      binding: plan.binding,
      blocks: plan.blocks.length,
      files,
    })
    console.log(`${job.version}  ${JSON.stringify(plan.binding)}`)
  }

  // A single release leaves the series manifest, which describes every release in notes/, untouched.
  if (!single) {
    const manifest = {
      direction: 'ikat',
      madeBy: 'Claude Fable 5.2',
      generator: 'scripts/release-art/ikat.mjs',
      canvas: { width: WIDTH, height: HEIGHT, threads: THREADS },
      palette: {
        hexes: PALETTE_HEXES,
        light: { ground: MODES.light.ground, hues: MODES.light.hues },
        dark: { ground: MODES.dark.ground, hues: MODES.dark.hues },
      },
      releases,
    }
    // Short lists of colours stay on one line, as the repo's formatter would set them.
    const json = JSON.stringify(manifest, null, 2).replace(
      /\[\n\s+("#[^\]]*?)\n\s+\]/g,
      (_, list) => `[${list.replace(/\n\s+/g, ' ')}]`,
    )
    writeFileSync(join(outDir, 'manifest.json'), `${json}\n`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
