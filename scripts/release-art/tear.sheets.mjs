#!/usr/bin/env node
// Rasterizes the tear pieces into review sheets (PNG): the matrix of thematics by minors in light
// and in dark, the matrix at one-third size, the row of the real 0.2.x releases, and one piece of
// each thematic in a mock of the update card. Not part of the release assets: a way to look at them.
//
// Usage: node scripts/release-art/tear.sheets.mjs <dir with the SVGs> <out dir>

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { chromium } from '@playwright/test'

import { parseVersion, thematicFor } from './tear.mjs'

const [dirArg, outArg] = process.argv.slice(2)
if (!dirArg || !outArg) {
  console.error('Usage: node scripts/release-art/tear.sheets.mjs <svg dir> <out dir>')
  process.exit(1)
}
const dir = resolve(dirArg)
const out = resolve(outArg)
mkdirSync(out, { recursive: true })

const MATRIX = [
  ['v0.1.0', 'v0.2.0', 'v0.3.0'],
  ['v1.1.0', 'v1.2.0', 'v1.3.0'],
]
const REAL = ['v0.2.2', 'v0.2.3', 'v0.2.4', 'v0.2.5', 'v0.2.6']
const CARDS = [
  {
    version: 'v0.2.5',
    lines: [
      'Long operations show as progress jobs in a notification panel',
      'One work-state line per ticket: stall means no agent alive',
      'Tracked request cards and important notices for agents',
    ],
  },
  {
    version: 'v1.2.0',
    lines: [
      'Organizations: several humans share a project and its agents',
      'Agents hand a ticket to another agent with delegation notes',
      'Review threads: reply to a verdict line by line',
    ],
  },
]

const uri = (version, variant) =>
  `data:image/svg+xml;base64,${readFileSync(join(dir, `${version}-${variant}.svg`)).toString('base64')}`
const has = (version) => existsSync(join(dir, `${version}-light.svg`))
const font = `font-family: ui-sans-serif, system-ui, 'Segoe UI', Helvetica, Arial, sans-serif;`
const rowName = (version) => {
  const { major } = parseVersion(version)
  return `${major}.x<br><span style="font-weight:400">${thematicFor(major).name}</span>`
}

// A grid of pieces: one row per list of versions, a label before each row and under each piece.
function gridPage(rows, variants, width, label = rowName) {
  const gap = Math.round(width / 40)
  const size = Math.max(11, Math.round(width / 34))
  const body = rows
    .map((row) => {
      const cells = row
        .map(
          (version) =>
            `<div>${variants.map((variant) => `<img src="${uri(version, variant)}" width="${width}">`).join(`<div style="height:${Math.round(gap / 2)}px"></div>`)}<div class="cap">${version}</div></div>`,
        )
        .join('')
      return `<div class="label">${label(row[0])}</div>${cells}`
    })
    .join('')
  return `<body style="margin:0;background:#8b8b8b;${font}"><div id="sheet" style="display:inline-grid;grid-template-columns:auto repeat(${rows[0].length}, ${width}px);gap:${gap}px;padding:${Math.round(width / 28)}px;align-items:center">
<style>.label{color:#fff;font-size:${size}px;font-weight:600;line-height:1.3} .cap{color:#fff;font-size:${Math.round(size * 0.86)}px;padding-top:${Math.round(gap / 3)}px} img{display:block}</style>${body}</div></body>`
}

function cardPage() {
  const card = ({ version, lines }, variant) => {
    const dark = variant === 'dark'
    const bg = dark ? '#16161a' : '#ffffff'
    const fg = dark ? '#ececf1' : '#18181b'
    const dim = dark ? '#9c9ca8' : '#6b6b76'
    const page = dark ? '#0b0b0d' : '#f1f1f3'
    const edge = dark ? '#2a2a31' : '#e2e2e6'
    return `<div style="background:${page};padding:36px"><div style="width:440px;background:${bg};color:${fg};border:1px solid ${edge};border-radius:14px;overflow:hidden;box-shadow:0 12px 32px rgba(0,0,0,${dark ? 0.5 : 0.12})">
<img src="${uri(version, variant)}" width="440" style="display:block">
<div style="padding:18px 20px 20px">
<div style="font-size:12px;color:${dim};letter-spacing:.04em;text-transform:uppercase">Update available</div>
<div style="font-size:19px;font-weight:650;margin:4px 0 10px">CrossBoard ${version.slice(1)}</div>
<ul style="margin:0;padding-left:18px;font-size:13.5px;line-height:1.55;color:${fg}">
${lines.map((line) => `<li>${line}</li>`).join('')}
</ul>
<div style="display:flex;gap:10px;margin-top:16px"><div style="background:${fg};color:${bg};font-size:13px;font-weight:600;padding:7px 14px;border-radius:8px">Install and restart</div><div style="color:${dim};font-size:13px;padding:7px 4px">Later</div></div>
</div></div></div>`
  }
  const rows = CARDS.filter(({ version }) => has(version))
    .map((entry) => `<div style="display:flex">${card(entry, 'light')}${card(entry, 'dark')}</div>`)
    .join('')
  return `<body style="margin:0;${font}"><div id="sheet" style="display:inline-block">${rows}</div></body>`
}

const shots = []
if (MATRIX.flat().every(has)) {
  shots.push(
    ['tear-matrix-light.png', gridPage(MATRIX, ['light'], 760), 1],
    ['tear-matrix-dark.png', gridPage(MATRIX, ['dark'], 760), 1],
    ['tear-matrix-third.png', gridPage(MATRIX, ['light', 'dark'], 533), 1],
  )
}
if (REAL.every(has)) {
  shots.push([
    'tear-real-0.2.png',
    gridPage(
      [REAL],
      ['light', 'dark'],
      Math.round(2240 / REAL.length),
      () => '0.2.x<br><span style="font-weight:400">real</span>',
    ),
    1,
  ])
}
if (CARDS.some(({ version }) => has(version))) shots.push(['tear-card.png', cardPage(), 2])

const browser = await chromium.launch()
for (const [file, html, scale] of shots) {
  const page = await browser.newPage({ viewport: { width: 2600, height: 1400 }, deviceScaleFactor: scale })
  await page.setContent(html)
  await page.waitForFunction(() => [...document.images].every((image) => image.complete))
  await page.locator('#sheet').screenshot({ path: join(out, file) })
  await page.close()
  console.log(join(out, file))
}
await browser.close()
