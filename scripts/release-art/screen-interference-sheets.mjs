#!/usr/bin/env node
// Contact sheets for the screen interference pieces: rasterizes the SVGs with the repo's
// Playwright Chromium so the series can be looked at side by side. Nothing here is committed
// output; the sheets go wherever --out says.
//
//   node scripts/release-art/screen-interference-sheets.mjs --out /tmp/sheets [--dir <svg dir>]
//
// Writes: matrix-light.png and matrix-dark.png (rows: majors 0 and 1, columns: minors 1, 2, 3),
// matrix-third.png (the same at a third of the size, light above dark), real-0.2.png (the
// four real 0.2.x releases, light above dark), and card.png (one piece of each thematic in a
// mock of the update card, light and dark).

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function parseArgs(argv) {
  const args = { dir: join(ROOT, 'src/assets/release-art/screen-interference') }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i]
    else if (argv[i] === '--dir') args.dir = argv[++i]
    else throw new Error(`Unknown argument: ${argv[i]}`)
  }
  if (!args.out) throw new Error('--out <dir> is needed')
  return { dir: resolve(args.dir), out: resolve(args.out) }
}

const MATRIX = [
  ['v0.1.0', 'v0.2.0', 'v0.3.0'],
  ['v1.1.0', 'v1.2.0', 'v1.3.0'],
]
const REAL = ['v0.2.2', 'v0.2.3', 'v0.2.4', 'v0.2.5']
const SHEET = { light: '#E4DED2', dark: '#0B0C10' }
const INK = { light: '#2A2620', dark: '#D9D4CA' }

function grid(dir, rows, variant, width) {
  const cells = rows
    .map(
      (row) =>
        `<div class="row">${row
          .map(
            (version) =>
              `<figure><img src="${pathToFileURL(join(dir, `${version}-${variant}.svg`)).href}" width="${width}" height="${Math.round((width * 9) / 16)}"><figcaption>${version}</figcaption></figure>`,
          )
          .join('')}</div>`,
    )
    .join('')
  return `<section class="${variant}">${cells}</section>`
}

function page(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; font: 13px/1.4 system-ui, sans-serif; display: inline-block; }
    section { padding: 18px; display: flex; flex-direction: column; gap: 14px; }
    section.light { background: ${SHEET.light}; color: ${INK.light}; }
    section.dark { background: ${SHEET.dark}; color: ${INK.dark}; }
    .row { display: flex; gap: 14px; }
    figure { margin: 0; }
    img { display: block; }
    figcaption { margin-top: 4px; opacity: 0.7; }
    .card { width: 640px; border-radius: 12px; overflow: hidden; }
    .light .card { background: #FBF8F2; box-shadow: 0 1px 3px #0002; }
    .dark .card { background: #1B1E26; box-shadow: 0 1px 3px #0008; }
    .card img { width: 640px; height: 360px; }
    .card .text { padding: 16px 20px 20px; }
    .card h3 { margin: 0 0 6px; font-size: 17px; }
    .card ul { margin: 0; padding-left: 18px; opacity: 0.8; }
  </style></head><body>${body}</body></html>`
}

function card(dir, version, variant, title, lines) {
  return `<div class="card"><img src="${pathToFileURL(join(dir, `${version}-${variant}.svg`)).href}"><div class="text"><h3>${title}</h3><ul>${lines
    .map((line) => `<li>${line}</li>`)
    .join('')}</ul></div></div>`
}

async function main() {
  const { dir, out } = parseArgs(process.argv.slice(2))
  mkdirSync(out, { recursive: true })
  const sheets = {
    'matrix-light.png': page(grid(dir, MATRIX, 'light', 800)),
    'matrix-dark.png': page(grid(dir, MATRIX, 'dark', 800)),
    'matrix-third.png': page(grid(dir, MATRIX, 'light', 533 / 2) + grid(dir, MATRIX, 'dark', 533 / 2)),
    'real-0.2.png': page(grid(dir, [REAL], 'light', 600) + grid(dir, [REAL], 'dark', 600)),
    'card.png': page(
      ['light', 'dark']
        .map(
          (variant) =>
            `<section class="${variant}"><div class="row">${card(dir, 'v0.2.5', variant, 'CrossBoard 0.2.5', [
              'Progress jobs and notices for long work',
              'Live work states on every ticket',
              'Project notes beside the instructions',
            ])}${card(dir, 'v1.2.0', variant, 'CrossBoard 1.2.0', [
              'Agents of several projects share one review queue',
              'Lanes delegated to workers, verdicts on the parent',
              'Tokens per agent session',
            ])}</div></section>`,
        )
        .join(''),
    ),
  }
  const browser = await chromium.launch()
  try {
    const tab = await browser.newPage({ viewport: { width: 2490, height: 600 }, deviceScaleFactor: 1 })
    for (const [name, html] of Object.entries(sheets)) {
      const file = join(out, name.replace(/\.png$/, '.html'))
      writeFileSync(file, html)
      await tab.goto(pathToFileURL(file).href)
      await tab.waitForLoadState('networkidle')
      await tab.locator('body').screenshot({ path: join(out, name) })
      console.log(`wrote ${join(out, name)}`)
    }
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(`sheets: ${error.message}`)
  process.exitCode = 1
})
