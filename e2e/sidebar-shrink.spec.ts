import type { Locator, Page } from '@playwright/test'

import { expect, expectTooltip, test } from './fixtures'

const sidebar = (page: Page) => page.locator('aside').filter({ has: page.getByRole('navigation') })
/** The sidebar element itself: found even while it is hidden (its links are not in the accessibility tree then). */
const asideEl = (page: Page) => page.locator('aside:has(nav)')
const toggle = (page: Page) => page.getByRole('button', { name: /sidebar$/ })
/** The sidebar slides: wait until every slide on the page has finished before measuring it. */
const rect = (locator: Locator) => locator.evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect)
const settled = (page: Page) =>
  page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)))
/** The properties the sidebar is sliding right now (its running CSS transitions; a button's hover colour is not one). */
const SLIDES = ['width', 'margin-right', 'translate', 'padding-left', 'max-width']
const sliding = (page: Page) =>
  page.evaluate(
    (slides) =>
      document
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        .map((animation) => (animation as CSSTransition).transitionProperty)
        .filter((property) => slides.includes(property)),
    SLIDES,
  )
/** A shrunk link is icon-only: its label is screen-reader text, so the link is narrow. */
async function linkIsIconOnly(page: Page, name: string) {
  const box = (await sidebar(page).getByRole('link', { name }).boundingBox())!
  return box.width < 60
}

test('one toggle cycles the sidebar through expanded, shrunk and hidden, with a name for each next press', async ({
  page,
  project,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  const aside = sidebar(page)
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()

  await expect(page.getByRole('button', { name: 'Shrink sidebar' })).toBeVisible()
  await page.getByRole('button', { name: 'Shrink sidebar' }).click()

  // Shrunk: the labels are for screen readers only, the links keep their names.
  await expect(page.getByRole('button', { name: 'Hide sidebar' })).toBeVisible()
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()
  await settled(page)
  expect(await linkIsIconOnly(page, 'PR queue')).toBe(true)
  const width = (await aside.boundingBox())!.width
  expect(width).toBeLessThan(100)

  await page.getByRole('button', { name: 'Hide sidebar' }).click()
  await expect(aside).toBeHidden()
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeVisible()

  await page.getByRole('button', { name: 'Show sidebar' }).click()
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Shrink sidebar' })).toBeVisible()
  expect(await toggle(page).count()).toBe(1)
})

test('a shrunk sidebar shows each page as an icon with its label in a tooltip', async ({ page, project }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  await page.getByRole('button', { name: 'Shrink sidebar' }).click()
  const link = sidebar(page).getByRole('link', { name: 'Roadmap' })
  await expectTooltip(link, 'Roadmap')
})

test('a hidden sidebar shows while the mouse is on the left border, and closes once it leaves', async ({
  page,
  project,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  await page.getByRole('button', { name: 'Shrink sidebar' }).click()
  await page.getByRole('button', { name: 'Hide sidebar' }).click()
  const aside = sidebar(page)
  await expect(aside).toBeHidden()

  await page.mouse.move(640, 400)
  await page.mouse.move(2, 400)
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()
  // The page does not move while the sidebar is over it.
  await settled(page)
  const pageBox = (await page.locator('section.min-w-0').boundingBox())!
  expect(pageBox.x).toBeLessThan(100)

  await page.mouse.move(640, 400)
  await expect(aside).toBeHidden()
})

test('a peeked hidden sidebar that closes after a click keeps focus on the toggle, not the page body', async ({
  page,
  project,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  await page.getByRole('button', { name: 'Shrink sidebar' }).click()
  await page.getByRole('button', { name: 'Hide sidebar' }).click()
  const aside = sidebar(page)
  await expect(aside).toBeHidden()

  await page.mouse.move(640, 400)
  await page.mouse.move(2, 400)
  await aside.getByRole('link', { name: 'Roadmap' }).click()
  await page.mouse.move(640, 400)
  await expect(aside).toBeHidden()
  // The link the click focused is gone with the sidebar: focus goes to the toggle that shows it again.
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeFocused()
})

test('a click in a peeked sidebar that leaves focus on the body still closes it with focus on the toggle', async ({
  page,
  project,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  await page.getByRole('button', { name: 'Shrink sidebar' }).click()
  await page.getByRole('button', { name: 'Hide sidebar' }).click()
  const aside = sidebar(page)
  await expect(aside).toBeHidden()

  await page.mouse.move(640, 400)
  await page.mouse.move(2, 400)
  await aside.getByRole('link', { name: 'Roadmap' }).click()
  // Some browsers (Safari) do not focus a link on a mouse click: the focus is on the page body here.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
  await page.mouse.move(640, 400)
  await expect(aside).toBeHidden()
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeFocused()
})

test('the chosen mode is remembered per browser across a reload', async ({ page, project }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  await page.getByRole('button', { name: 'Shrink sidebar' }).click()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Hide sidebar' })).toBeVisible()
  await settled(page)
  expect(await linkIsIconOnly(page, 'PR queue')).toBe(true)
})

test('an unknown stored value shows the sidebar expanded', async ({ page, project }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  await page.evaluate(() => localStorage.setItem('agent-board.sidebar', 'folded'))
  await page.reload()
  await expect(page.getByRole('button', { name: 'Shrink sidebar' })).toBeVisible()
  await expect(sidebar(page).getByRole('link', { name: 'PR queue' })).toBeVisible()
})

test('the toggle takes the keyboard: it is reached by Tab and Enter cycles it', async ({ page, project }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  const button = page.getByRole('button', { name: 'Shrink sidebar' })
  await button.focus()
  await expect(button).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Hide sidebar' })).toBeFocused()
  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeFocused()
})

test('on a phone there is no toggle and the page picker is unchanged', async ({ page, project }) => {
  await page.setViewportSize({ width: 390, height: 700 })
  await page.goto(`/projects/${project.id}/prs`)
  await expect(page.getByRole('combobox', { name: 'Project page' })).toBeVisible()
  await expect(page.getByRole('button', { name: /sidebar$/ })).toHaveCount(0)
  expect(
    await page
      .locator('aside')
      .first()
      .evaluate((el) => getComputedStyle(el).position),
  ).toBe('static')
})

test('the toggle sits at the top of the Overview module in expanded and in shrunk', async ({
  page,
  project,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  const aside = sidebar(page)
  for (const label of ['Shrink sidebar', 'Hide sidebar']) {
    const button = page.getByRole('button', { name: label })
    await expect(button).toBeVisible()
    await settled(page)
    const toggleBox = (await button.boundingBox())!
    const overviewBox = (await aside.getByRole('link', { name: 'Overview' }).boundingBox())!
    const asideBox = (await aside.boundingBox())!
    // Inside the sidebar, as its first row: above the Overview link, which is above every other link.
    expect(toggleBox.x).toBeGreaterThanOrEqual(asideBox.x)
    expect(toggleBox.x + toggleBox.width).toBeLessThanOrEqual(asideBox.x + asideBox.width)
    expect(toggleBox.y + toggleBox.height).toBeLessThanOrEqual(overviewBox.y)
    expect(toggleBox.y).toBeGreaterThanOrEqual(asideBox.y)
    if (label === 'Shrink sidebar') await button.click()
  }
})

test('a hidden sidebar shows when the mouse comes near where it was, not only at the screen edge', async ({
  page,
  project,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  await page.getByRole('button', { name: 'Shrink sidebar' }).click()
  await page.getByRole('button', { name: 'Hide sidebar' }).click()
  const aside = sidebar(page)
  await expect(aside).toBeHidden()

  // Inside the 40px strip, away from the very edge.
  await page.mouse.move(640, 400)
  await page.mouse.move(20, 400)
  await expect(aside.getByRole('link', { name: 'Overview' })).toBeVisible()

  await page.mouse.move(640, 400)
  await expect(aside).toBeHidden()
})

test('a hidden sidebar is the real sidebar, same width and links, with no box of its own, sliding in from the left', async ({
  page,
  project,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  const aside = sidebar(page)
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()
  await settled(page)
  const expanded = await rect(asideEl(page))
  const links = await aside.getByRole('link').allInnerTexts()
  await page.getByRole('button', { name: 'Shrink sidebar' }).click()
  await page.getByRole('button', { name: 'Hide sidebar' }).click()
  await expect(aside).toBeHidden()
  // Resting outside the window on the left.
  const resting = await rect(asideEl(page))
  expect(resting.x + resting.width).toBeLessThanOrEqual(0)

  await page.mouse.move(640, 400)
  await page.mouse.move(20, 400)
  // It slides: a translate transition runs (it is not there at once), and ends where the sidebar was.
  await expect.poll(() => sliding(page)).toContain('translate')
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()
  await settled(page)
  const shown = await rect(asideEl(page))
  expect(shown.x).toBeCloseTo(expanded.x, 0)
  expect(shown.width).toBeCloseTo(expanded.width, 0)
  expect(await aside.getByRole('link').allInnerTexts()).toEqual(links)
  // The sidebar itself, not a card: no shadow, no rounded corners, in the page's flow position (not pinned).
  const look = await asideEl(page).evaluate((el) => {
    const style = getComputedStyle(el)
    return { shadow: style.boxShadow, radius: style.borderRadius, position: style.position }
  })
  expect(look).toEqual({ shadow: 'none', radius: '0px', position: 'static' })

  // Leaving slides it back out to the left, and then it is out of reach.
  await page.mouse.move(640, 400)
  await expect.poll(() => sliding(page), { timeout: 3000 }).toContain('translate')
  await expect(aside).toBeHidden()
  const gone = await rect(asideEl(page))
  expect(gone.x + gone.width).toBeLessThanOrEqual(0)
})

test('a hidden sidebar slides in from the left edge on a wide window too', async ({ page, project }) => {
  await page.setViewportSize({ width: 1920, height: 900 })
  await page.goto(`/projects/${project.id}/prs`)
  await page.getByRole('button', { name: 'Shrink sidebar' }).click()
  await page.getByRole('button', { name: 'Hide sidebar' }).click()
  const aside = sidebar(page)
  await expect(aside).toBeHidden()
  const resting = await rect(asideEl(page))
  expect(resting.x + resting.width).toBeLessThanOrEqual(0)
  await page.mouse.move(960, 400)
  await page.mouse.move(20, 400)
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()
  await settled(page)
  expect((await rect(asideEl(page))).x).toBeGreaterThan(0)
})

test('shrinking and expanding slide the sidebar and the page follows', async ({ page, project }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  const aside = sidebar(page)
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()
  await settled(page)
  const expandedWidth = (await rect(asideEl(page))).width
  const pageX = async () => (await page.locator('section.min-w-0').boundingBox())!.x
  const expandedX = await pageX()
  // The first moment the toggle can slide: the slides are switched on after the first frames.
  await expect(async () => {
    await page.getByRole('button', { name: 'Shrink sidebar' }).click()
    expect(await sliding(page)).toContain('width')
  }).toPass({ timeout: 3000 })
  await settled(page)
  const shrunkWidth = (await rect(asideEl(page))).width
  expect(shrunkWidth).toBeLessThan(expandedWidth)
  expect(await pageX()).toBeLessThan(expandedX)

  await page.getByRole('button', { name: 'Hide sidebar' }).click()
  expect(await sliding(page)).toContain('translate')
  await settled(page)
  await expect(aside).toBeHidden()

  // Back to expanded: the width slides open again.
  await page.getByRole('button', { name: 'Show sidebar' }).click()
  expect(await sliding(page)).toContain('width')
  await settled(page)
  expect((await rect(asideEl(page))).width).toBeCloseTo(expandedWidth, 0)
})

test('with reduced motion the sidebar changes at once, with no slide', async ({ page, project }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  const aside = sidebar(page)
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()
  await page.waitForTimeout(500) // past the frames after which slides would be on

  await page.getByRole('button', { name: 'Shrink sidebar' }).click()
  expect(await sliding(page)).toEqual([])
  expect((await rect(asideEl(page))).width).toBeLessThan(100)

  await page.getByRole('button', { name: 'Hide sidebar' }).click()
  expect(await sliding(page)).toEqual([])
  await expect(aside).toBeHidden()

  await page.mouse.move(640, 400)
  await page.mouse.move(20, 400)
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()
  expect(await sliding(page)).toEqual([])
  expect((await rect(asideEl(page))).x).toBeGreaterThanOrEqual(0)

  await page.mouse.move(640, 400)
  await expect(aside).toBeHidden()
  expect(await sliding(page)).toEqual([])
})

test('a remembered hidden sidebar is hidden on load, not sliding away', async ({ page, project }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.addInitScript(() => {
    localStorage.setItem('agent-board.sidebar', 'hidden')
    ;(window as unknown as { slid: string[] }).slid = []
    document.addEventListener(
      'transitionrun',
      (event) => (window as unknown as { slid: string[] }).slid.push((event as TransitionEvent).propertyName),
      true,
    )
  })
  await page.goto(`/projects/${project.id}/prs`)
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeVisible()
  await expect(sidebar(page)).toBeHidden()
  await page.waitForTimeout(500)
  const slid = await page.evaluate(() => (window as unknown as { slid: string[] }).slid)
  expect(slid.filter((property) => ['width', 'translate', 'margin-right'].includes(property))).toEqual([])
})

test('the pointer resting on the toggle keeps a peeked hidden sidebar open', async ({ page, project }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  await page.getByRole('button', { name: 'Shrink sidebar' }).click()
  await page.getByRole('button', { name: 'Hide sidebar' }).click()
  const aside = sidebar(page)
  await expect(aside).toBeHidden()

  await page.mouse.move(640, 400)
  await page.mouse.move(20, 400)
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()
  await settled(page)
  // Onto the toggle, which sits over the sidebar's first row, and rest there well past the close delay.
  const box = (await page.getByRole('button', { name: 'Show sidebar' }).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 })
  await page.waitForTimeout(800)
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()

  // Leaving it for the page closes the sidebar.
  await page.mouse.move(640, 400)
  await expect(aside).toBeHidden()
})
