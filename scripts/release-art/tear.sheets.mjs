#!/usr/bin/env node
// Rasterizes the tear series into three review sheets (PNG): the series, the update-card mock and
// the series at one-third size. Not part of the release assets: a way to look at them.
//
// Usage: node scripts/release-art/tear.sheets.mjs <dir with the SVGs> <out dir> [card version]

import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { chromium } from '@playwright/test'

const [dirArg, outArg, cardVersion = 'v0.2.5'] = process.argv.slice(2)
if (!dirArg || !outArg) {
  console.error('Usage: node scripts/release-art/tear.sheets.mjs <svg dir> <out dir> [card version]')
  process.exit(1)
}
const dir = resolve(dirArg)
const out = resolve(outArg)
mkdirSync(out, { recursive: true })

const versions = [
  ...new Set(
    readdirSync(dir)
      .filter((file) => file.endsWith('.svg'))
      .map((file) => file.replace(/-(dark|light)\.svg$/, '')),
  ),
].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
const uri = (version, variant) =>
  `data:image/svg+xml;base64,${readFileSync(join(dir, `${version}-${variant}.svg`)).toString('base64')}`

const font = `font-family: ui-sans-serif, system-ui, 'Segoe UI', Helvetica, Arial, sans-serif;`

function seriesPage(width) {
  const cells = versions
    .map(
      (version) =>
        `<div class="label">${version}</div><img src="${uri(version, 'light')}" width="${width}"><img src="${uri(version, 'dark')}" width="${width}">`,
    )
    .join('')
  return `<body style="margin:0;background:#8b8b8b;${font}"><div id="sheet" style="display:inline-grid;grid-template-columns:auto ${width}px ${width}px;gap:${Math.round(width / 40)}px;padding:${Math.round(width / 30)}px;align-items:center">
<style>.label{color:#fff;font-size:${Math.max(11, Math.round(width / 36))}px;font-weight:600} img{display:block}</style>${cells}</div></body>`
}

function cardPage() {
  const card = (variant) => {
    const dark = variant === 'dark'
    const bg = dark ? '#16161a' : '#ffffff'
    const fg = dark ? '#ececf1' : '#18181b'
    const dim = dark ? '#9c9ca8' : '#6b6b76'
    const page = dark ? '#0b0b0d' : '#f1f1f3'
    const edge = dark ? '#2a2a31' : '#e2e2e6'
    return `<div style="background:${page};padding:44px"><div style="width:440px;background:${bg};color:${fg};border:1px solid ${edge};border-radius:14px;overflow:hidden;box-shadow:0 12px 32px rgba(0,0,0,${dark ? 0.5 : 0.12})">
<img src="${uri(cardVersion, variant)}" width="440" style="display:block">
<div style="padding:18px 20px 20px">
<div style="font-size:12px;color:${dim};letter-spacing:.04em;text-transform:uppercase">Update available</div>
<div style="font-size:19px;font-weight:650;margin:4px 0 10px">CrossBoard ${cardVersion.slice(1)}</div>
<ul style="margin:0;padding-left:18px;font-size:13.5px;line-height:1.55;color:${fg}">
<li>Long operations show as progress jobs in a notification panel</li>
<li>One work-state line per ticket: stall means no agent alive</li>
<li>Tracked request cards and important notices for agents</li>
<li>A faster review pipeline: test slots, one build, scoped reruns</li>
</ul>
<div style="display:flex;gap:10px;margin-top:16px"><div style="background:${fg};color:${bg};font-size:13px;font-weight:600;padding:7px 14px;border-radius:8px">Install and restart</div><div style="color:${dim};font-size:13px;padding:7px 4px">Later</div></div>
</div></div></div>`
  }
  return `<body style="margin:0;${font}"><div id="sheet" style="display:inline-flex">${card('light')}${card('dark')}</div></body>`
}

const browser = await chromium.launch()
const shots = [
  ['tear-series.png', seriesPage(800), 1],
  ['tear-card.png', cardPage(), 2],
  ['tear-third.png', seriesPage(533), 1],
]
for (const [file, html, scale] of shots) {
  const page = await browser.newPage({ viewport: { width: 1900, height: 1200 }, deviceScaleFactor: scale })
  await page.setContent(html)
  await page.waitForFunction(() => [...document.images].every((image) => image.complete))
  await page.locator('#sheet').screenshot({ path: join(out, file) })
  await page.close()
  console.log(join(out, file))
}
await browser.close()
