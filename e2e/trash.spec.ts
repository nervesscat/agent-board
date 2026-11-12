import type { Locator, Page } from '@playwright/test'

import { commitFile, git } from './env'
import { expect, expectTooltip, ok, test, tooltip } from './fixtures'
import { addRun } from './runs'

/** The colour a theme variable (`--destructive`) comes to, as computed styles give colours. */
const themeColor = (page: Page, variable: string) =>
  page.evaluate((v) => {
    const probe = document.createElement('span')
    probe.style.color = `var(${v})`
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }, variable)

const icon = (trigger: Locator) => trigger.locator('svg.trash-icon')
const lid = (trigger: Locator) => trigger.locator('svg.trash-icon .trash-icon-lid')

const iconStyle = (trigger: Locator) =>
  icon(trigger).evaluate((el) => {
    const s = getComputedStyle(el)
    return { color: s.color }
  })

/** The icon's colour beside its button's own: the two match at rest. */
const iconAndButtonColour = (trigger: Locator) =>
  trigger.evaluate((el) => {
    const svg = el.querySelector('svg.trash-icon')!
    return { icon: getComputedStyle(svg).color, button: getComputedStyle(el).color }
  })

/** The lids' animation and transform, and the can's transform beside them. */
const lidStyle = (trigger: Locator) =>
  lid(trigger).evaluate((el) => {
    const s = getComputedStyle(el)
    return { animation: s.animationName, transform: s.transform }
  })

/**
 * The lid's computed transform as the matrix it resolves to: `f` is how far it rose (negative is up)
 * and `b` is its rotation, so a lift and a swing are both visible here, or `null` while it is shut.
 */
const lidMatrix = (trigger: Locator) =>
  lid(trigger).evaluate((el) => {
    const matrix = getComputedStyle(el).transform.match(/^matrix\(([^)]+)\)$/)
    if (!matrix) return null
    const [a, b, c, d, e, f] = matrix[1]!.split(',').map(Number)
    return { a: a!, b: b!, c: c!, d: d!, e: e!, f: f! }
  })

/** It opens: the lid lifts off the rim and swings from its hinge, rather than tilting in place. */
async function expectLidOpen(trigger: Locator) {
  await expect.poll(() => lidMatrix(trigger).then((m) => m?.f ?? 0)).toBeLessThanOrEqual(-2)
  await expect.poll(() => lidMatrix(trigger).then((m) => Math.abs(m?.b ?? 0))).toBeGreaterThan(0.3)
}

const buttonChrome = (trigger: Locator) =>
  trigger.evaluate((el) => {
    const s = getComputedStyle(el)
    return { shadow: s.boxShadow, overflow: s.overflow }
  })

/** Its box in the page, whatever the page has scrolled to (hovering may scroll it into view). */
const docBox = (target: Locator) =>
  target.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height }
  })

/**
 * The button's icon at rest: the button's own colour (its neighbours' too), never the theme's
 * destructive red, and its lid shut.
 */
async function expectNeutral(page: Page, trigger: Locator) {
  await page.mouse.move(0, 0)
  await expect(icon(trigger)).toHaveCount(1)
  const destructive = await themeColor(page, '--destructive')
  await expect
    .poll(async () => {
      const colours = await iconAndButtonColour(trigger)
      return colours.icon === colours.button && colours.icon !== destructive
    })
    .toBe(true)
  await expect.poll(() => lidStyle(trigger).then((s) => s.transform)).toBe('none')
}

/** Hovering it: the red, a lifted lid, and neither the can nor the button move. */
async function expectHoverRed(trigger: Locator) {
  const page = trigger.page()
  const dest = await themeColor(page, '--destructive')
  await trigger.scrollIntoViewIfNeeded()
  const before = {
    button: await docBox(trigger),
    can: await docBox(trigger.locator('[data-trash-part="can"]')),
    lid: await docBox(lid(trigger)),
  }
  await trigger.hover()
  await expect.poll(() => iconStyle(trigger).then((s) => s.color)).toBe(dest)
  await expect.poll(() => lidStyle(trigger).then((s) => s.transform)).not.toBe('none')
  await expectLidOpen(trigger)
  const after = {
    button: await docBox(trigger),
    can: await docBox(trigger.locator('[data-trash-part="can"]')),
    lid: await docBox(lid(trigger)),
  }
  // The lid alone moves: no box shifts, so nothing below it reflows.
  expect(after.button).toEqual(before.button)
  expect(after.can).toEqual(before.can)
  // And it opened upward: its box sits higher than shut and is taller than a lid lying flat.
  expect(after.lid.y).toBeLessThan(before.lid.y)
  expect(after.lid.height).toBeGreaterThan(before.lid.height)
  // And back to rest when the pointer leaves.
  await page.mouse.move(0, 0)
  await expect.poll(() => lidStyle(trigger).then((s) => s.transform)).toBe('none')
  await expect.poll(() => docBox(lid(trigger))).toEqual(before.lid)
}

const expectTrashButton = async (page: Page, trigger: Locator) => {
  await expectNeutral(page, trigger)
  await expectHoverRed(trigger)
}

test('post and ticket trash buttons turn red on hover in either theme, and their tooltip holds', async ({
  page,
  api,
  agent,
}) => {
  const t = await api.ticket({ title: 'Hover the trash' })
  await ok(agent.post(`/api/tickets/${t.id}/updates`, { data: { body: 'Ready to go.', progress: false } }))
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)

  const post = page.locator('article:not([aria-label="Summary"])')
  await post.hover()
  const removePost = post.getByRole('button', { name: 'delete', exact: true })
  // Its tooltip still shows, and stays while the lid moves.
  await expectTooltip(removePost, 'Delete')
  await page.waitForTimeout(400)
  await expect(tooltip(page)).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(tooltip(page)).toBeHidden()

  const removeTicket = page.locator('header').locator('button:has(svg.trash-icon)')
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    if (colorScheme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
    await post.hover()
    await expectTrashButton(page, removePost)
    await expectTrashButton(page, removeTicket)
  }

  // Hovering moves no box and adds no scrollbar.
  const pageBox = () =>
    page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }))
  const before = await pageBox()
  await removeTicket.hover()
  await page.waitForTimeout(250)
  expect(await pageBox()).toEqual(before)
  await page.mouse.move(0, 0)
})

test('every other delete button gets the same red icon and lid', async ({ page, project, human }) => {
  const repoId = project.repos[0]!.id
  const run = await addRun(human, repoId, { name: 'Nightly preview' })
  const stages = await ok<{ id: number; name: string }[]>(human.get(`/api/projects/${project.id}/stages`))
  await ok(
    human.post(`/api/projects/${project.id}/agents`, {
      data: { name: 'builder', instructions: 'Builds the change.' },
    }),
  )
  const ticket = await ok<{ id: number }>(
    human.post(`/api/projects/${project.id}/tickets`, { data: { title: 'Drop me' } }),
  )

  // Project delete, in the switcher's Manage projects dialog.
  await page.goto(`/projects/${project.id}`)
  await page.getByRole('button', { name: 'Project' }).click()
  await page.getByRole('button', { name: /Manage projects/ }).click()
  const dialog = page.getByRole('dialog')
  await expectTrashButton(page, dialog.getByRole('button', { name: `Delete ${project.name}` }))
  await page.keyboard.press('Escape')

  // Run delete and stage delete, in the project's settings.
  await page.goto(`/projects/${project.id}/settings`)
  await expectTrashButton(page, page.getByRole('button', { name: `Delete ${run.name}` }))
  await expectTrashButton(page, page.getByRole('button', { name: `Delete ${stages[0]!.name}` }))

  // Agent remove.
  await page.goto(`/projects/${project.id}/agents`)
  await expectTrashButton(page, page.getByRole('button', { name: 'Remove builder' }))

  // Ticket delete, in the ticket's header.
  await page.goto(`/projects/${project.id}/features/${ticket.id}`)
  await expectTrashButton(page, page.locator('header').locator('button:has(svg.trash-icon)'))
})

test('the cleanup bulk delete gets it too', async ({ page, project, human }) => {
  // A closed ticket whose branch landed in its base: the one the sweep offers.
  const prefix = `e2e-trash-${project.id}`
  const done = commitFile('main', `trash-${project.id}.txt`, 'done\n', 'done work')
  git('update-ref', `refs/heads/${prefix}-base`, done)
  git('update-ref', `refs/heads/${prefix}-branch`, done)
  await ok(
    human.post(`/api/projects/${project.id}/tickets`, {
      data: { title: 'Landed', status: 'done', branch: `${prefix}-branch`, baseBranch: `${prefix}-base` },
    }),
  )

  await page.goto(`/projects/${project.id}/cleanup`)
  const bulk = page.getByRole('button', { name: /^Delete every eligible local branch/ })
  await expect(bulk).toBeVisible()
  await expectTrashButton(page, bulk)
})

test('without motion the lid stays shut but the red stays; keyboard focus is as clear as hover', async ({
  page,
  api,
}) => {
  const t = await api.ticket({ title: 'Motion and keys' })
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  const trigger = page.locator('header').locator('button:has(svg.trash-icon)')
  const destructive = await themeColor(page, '--destructive')

  // Reduced motion: the colour still changes, the lid neither moves nor lifts.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.mouse.move(0, 0)
  const shut = await docBox(lid(trigger))
  await trigger.hover()
  await expect.poll(() => iconStyle(trigger).then((s) => s.color)).toBe(destructive)
  const still = await lidStyle(trigger)
  expect(still).toEqual({ animation: 'none', transform: 'none' })
  expect(await lidMatrix(trigger)).toBeNull()
  expect(await docBox(lid(trigger))).toEqual(shut)
  await page.mouse.move(0, 0)

  // Keyboard focus: the red, the open lid and the button's ring, unclipped.
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  let reached = false
  for (let i = 0; i < 80 && !reached; i++) {
    await page.keyboard.press('Tab')
    reached = await trigger.evaluate((el) => el === document.activeElement)
  }
  expect(reached, 'the ticket trash button is reachable by Tab').toBe(true)
  await expect.poll(() => iconStyle(trigger).then((s) => s.color)).toBe(destructive)
  await expect.poll(() => lidStyle(trigger).then((s) => s.transform)).not.toBe('none')
  // Keyboard parity is the same opening lid, not just the colour.
  await expectLidOpen(trigger)
  const chrome = await buttonChrome(trigger)
  expect(chrome.shadow).not.toBe('none')
  expect(chrome.shadow).toContain('3px')
  expect(chrome.overflow).toBe('visible')
})

test('a disabled delete button, the only stage, neither turns red nor moves its lid', async ({
  page,
  project,
  human,
}) => {
  const stages = await ok<{ id: number; name: string }[]>(human.get(`/api/projects/${project.id}/stages`))
  // Leave one stage: its delete button is the disabled one.
  for (const s of stages.slice(1)) await ok(human.delete(`/api/projects/${project.id}/stages/${s.id}`))
  await page.goto(`/projects/${project.id}/settings`)

  const trigger = page.getByRole('button', { name: `Delete ${stages[0]!.name}` })
  await expect(trigger).toBeDisabled()
  const destructive = await themeColor(page, '--destructive')
  const rest = await iconStyle(trigger).then((s) => s.color)
  expect(rest).not.toBe(destructive)
  const at = (await trigger.boundingBox())!
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2)
  await page.waitForTimeout(250)
  expect(await iconStyle(trigger).then((s) => s.color)).toBe(rest)
  expect(await lidStyle(trigger).then((s) => s.transform)).toBe('none')
})
