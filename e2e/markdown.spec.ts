import type { Locator, Page } from '@playwright/test'

import { expect, test } from './fixtures'

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
