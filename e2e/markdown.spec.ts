import type { Locator, Page } from '@playwright/test'

import type { TicketFull, TicketRow } from '#/lib/api'
import { expect, ok, test } from './fixtures'

/** What the page computes for `--muted` as a background color, to compare a chip's background with. */
const muted = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.backgroundColor = 'var(--muted)'
    document.body.append(probe)
    const color = getComputedStyle(probe).backgroundColor
    probe.remove()
    return color
  })

const look = (code: Locator) =>
  code.evaluate((el) => {
    const style = getComputedStyle(el)
    const pseudo = (which: string) => getComputedStyle(el, which).content
    return {
      before: pseudo('::before'),
      after: pseudo('::after'),
      background: style.backgroundColor,
      padding: style.paddingLeft,
    }
  })

/** No generated text either side: `none` (or `normal`, the same for these). */
const NO_CONTENT = /^(none|normal)$/

test('inline code renders as a tinted chip without backticks; a code block keeps its look', async ({
  page,
  api,
}) => {
  const t = await api.ticket({
    title: 'Code in the text',
    body: 'Run `pnpm dev` in the worktree.\n\n```\nconst port = 47101\n```',
  })
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  const instructions = page.getByRole('region', { name: 'Instructions' })
  const inline = instructions.locator('p code')
  const block = instructions.locator('pre code')
  await expect(inline).toHaveText('pnpm dev')
  await expect(block).toContainText('const port = 47101')
  const color = await muted(page)
  expect(color).not.toBe('rgba(0, 0, 0, 0)')

  const chip = await look(inline)
  expect(chip.before).toMatch(NO_CONTENT)
  expect(chip.after).toMatch(NO_CONTENT)
  expect(chip.background).toBe(color)
  expect(parseFloat(chip.padding)).toBeGreaterThan(0)
  // The paragraph reads as written: no backtick in what the page shows.
  expect(await instructions.locator('p').first().innerText()).toBe('Run pnpm dev in the worktree.')

  // The block's code is the typography plugin's: no chip inside the block.
  const code = await look(block)
  expect(code.before).toMatch(NO_CONTENT)
  expect(code.after).toMatch(NO_CONTENT)
  expect(code.background).toBe('rgba(0, 0, 0, 0)')
  expect(code.padding).toBe('0px')

  // The editor shows inline code the same way.
  await instructions.getByRole('button', { name: 'edit' }).click()
  const edited = instructions.getByRole('textbox', { name: 'Instructions' }).locator('p code')
  await expect(edited).toHaveText('pnpm dev')
  const inEditor = await look(edited)
  expect(inEditor.before).toMatch(NO_CONTENT)
  expect(inEditor.after).toMatch(NO_CONTENT)
  expect(inEditor.background).toBe(color)
})

/**
 * How the paragraphs in `el` are set: the space between each one and the next (from the bottom of
 * one box to the top of the next, so margins are not counted), and the first one's line height and
 * font size.
 */
const paragraphs = (el: Locator) =>
  el.locator('p').evaluateAll((ps) => {
    const boxes = ps.map((p) => p.getBoundingClientRect())
    const style = getComputedStyle(ps[0]!)
    return {
      count: ps.length,
      gaps: boxes.slice(1).map((b, i) => b.top - boxes[i]!.bottom),
      pitches: boxes.slice(1).map((b, i) => b.top - boxes[i]!.top),
      heights: boxes.map((b) => b.height),
      lineHeight: parseFloat(style.lineHeight),
      fontSize: parseFloat(style.fontSize),
    }
  })

/** Lines a paragraph apart sit about a line apart: at most a quarter of a line between them. */
function expectLinesClose(set: Awaited<ReturnType<typeof paragraphs>>, what: string) {
  expect(set.lineHeight, `${what}: line height`).toBeGreaterThan(0)
  for (const gap of set.gaps) {
    expect(gap, `${what}: gap between lines`).toBeGreaterThanOrEqual(0)
    expect(gap, `${what}: gap between lines`).toBeLessThanOrEqual(set.lineHeight / 4)
  }
  for (const pitch of set.pitches)
    expect(pitch, `${what}: from line to line`).toBeLessThanOrEqual(set.lineHeight * 1.25)
}

/** The same type, and the same space between the lines, within a pixel. */
function expectSameSpacing(
  a: Awaited<ReturnType<typeof paragraphs>>,
  b: Awaited<ReturnType<typeof paragraphs>>,
  what: string,
) {
  expect(b.count, what).toBe(a.count)
  expect(b.lineHeight, `${what}: line height`).toBe(a.lineHeight)
  expect(b.fontSize, `${what}: font size`).toBe(a.fontSize)
  for (const [i, gap] of a.gaps.entries())
    expect(Math.abs(b.gaps[i]! - gap), `${what}: gap ${i + 1}, ${gap} and ${b.gaps[i]}`).toBeLessThanOrEqual(
      1,
    )
}

test('lines typed with Enter sit a line apart in the editor, are saved as paragraphs, and render as they were typed', async ({
  page,
  project,
  human,
}) => {
  await page.goto(`/projects/${project.id}/features`)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Title').fill('Three lines')
  const text = dialog.getByRole('textbox', { name: 'Instructions' })
  await text.click()
  await page.keyboard.type('line 1')
  await page.keyboard.press('Enter')
  await page.keyboard.type('line 2')
  await page.keyboard.press('Enter')
  await page.keyboard.type('line 3')
  await expect(text.locator('p')).toHaveText(['line 1', 'line 2', 'line 3'])
  const typed = await paragraphs(text)
  expectLinesClose(typed, 'in the New ticket editor')

  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  const [row] = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets`))
  const ticket = await ok<TicketFull>(human.get(`/api/tickets/${row!.id}`))
  expect(ticket.body).toBe('line 1\n\nline 2\n\nline 3')

  await page.goto(`/projects/${project.id}/features/${ticket.id}`)
  const instructions = page.getByRole('region', { name: 'Instructions' })
  await expect(instructions.locator('p')).toHaveText(['line 1', 'line 2', 'line 3'])
  const rendered = await paragraphs(instructions)
  expectLinesClose(rendered, 'rendered')
  expectSameSpacing(typed, rendered, 'rendered as typed')

  // Edited again, the editor sets them as they render.
  await instructions.getByRole('button', { name: 'edit' }).click()
  const edited = instructions.getByRole('textbox', { name: 'Instructions' })
  await expect(edited.locator('p')).toHaveText(['line 1', 'line 2', 'line 3'])
  expectSameSpacing(rendered, await paragraphs(edited), 'in the editor on the ticket')
})

test('Shift+Enter breaks the line inside one paragraph, saved as a hard break and rendered one line under the other', async ({
  page,
  project,
  human,
}) => {
  await page.goto(`/projects/${project.id}/features`)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Title').fill('A broken line')
  const text = dialog.getByRole('textbox', { name: 'Instructions' })
  await text.click()
  await page.keyboard.type('line 1')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('line 2')
  await expect(text.locator('p')).toHaveCount(1)
  await expect(text.locator('p br')).not.toHaveCount(0)
  const typed = await paragraphs(text)
  // Two lines in the one paragraph, a line height each.
  expect(Math.abs(typed.heights[0]! - 2 * typed.lineHeight)).toBeLessThanOrEqual(1)

  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  const [row] = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets`))
  const ticket = await ok<TicketFull>(human.get(`/api/tickets/${row!.id}`))
  expect(ticket.body).toBe('line 1  \nline 2')

  await page.goto(`/projects/${project.id}/features/${ticket.id}`)
  const instructions = page.getByRole('region', { name: 'Instructions' })
  await expect(instructions.locator('p')).toHaveCount(1)
  await expect(instructions.locator('p br')).toHaveCount(1)
  const rendered = await paragraphs(instructions)
  expect(rendered.lineHeight).toBe(typed.lineHeight)
  expect(Math.abs(rendered.heights[0]! - typed.heights[0]!)).toBeLessThanOrEqual(1)
})
