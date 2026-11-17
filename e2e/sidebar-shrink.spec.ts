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
/**
 * Records every sidebar slide that starts from now on (a transition lasts 200 ms and can start and end between two
 * polls, so a poll for a running one can miss it).
 */
const recordSlides = (page: Page) =>
  page.evaluate((slides) => {
    const seen: string[] = []
    ;(window as unknown as { slidesSeen: string[] }).slidesSeen = seen
    document.addEventListener(
      'transitionrun',
      (event) => {
        if (slides.includes((event as TransitionEvent).propertyName))
          seen.push((event as TransitionEvent).propertyName)
      },
      true,
    )
  }, SLIDES)
const slidesSeen = (page: Page) =>
  page.evaluate(() => (window as unknown as { slidesSeen: string[] }).slidesSeen)
/** Out of the window on the left: where a hidden sidebar, and the toggle inside it, rest. */
const isOffscreen = async (locator: Locator) => {
  const box = await rect(locator)
  return box.x + box.width <= 0
}
/** Brings the pointer to the left edge, where a hidden sidebar slides in, and waits until it has settled there. */
async function peek(page: Page) {
  await page.mouse.move(640, 400)
  await page.mouse.move(20, 400)
  await expect(sidebar(page).getByRole('link', { name: 'Overview' })).toBeVisible()
  await settled(page)
}
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
  // The toggle is inside the sidebar: it went out of the window with it.
  await settled(page)
  expect(await isOffscreen(page.getByRole('button', { name: 'Show sidebar' }))).toBe(true)

  // Back where the sidebar comes from, the sidebar shows with its toggle in it.
  await peek(page)
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeInViewport()
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

test('hidden takes no width; the left edge brings the normal sidebar back and the page makes room; leaving gives the width back', async ({
  page,
  project,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  const aside = sidebar(page)
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()
  await settled(page)
  const column = page.locator('section.min-w-0')
  const expanded = (await column.boundingBox())!
  const wrapper = asideEl(page).locator('xpath=..')
  await page.getByRole('button', { name: 'Shrink sidebar' }).click()
  await page.getByRole('button', { name: 'Hide sidebar' }).click()
  await expect(aside).toBeHidden()
  await settled(page)

  // Hidden: the sidebar's place has no width and the page uses the whole width.
  expect((await rect(wrapper)).width).toBe(0)
  const hidden = (await column.boundingBox())!
  expect(hidden.x).toBeLessThan(expanded.x - 100)
  expect(hidden.width).toBeGreaterThan(expanded.width + 100)

  // Near the left edge: the sidebar is back in its normal place with its normal width, and the page has moved
  // right to make room (it is not drawn over the page).
  await page.mouse.move(640, 400)
  await page.mouse.move(2, 400)
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()
  await settled(page)
  const peeked = (await column.boundingBox())!
  expect(peeked.x).toBeCloseTo(expanded.x, 0)
  expect(peeked.width).toBeCloseTo(expanded.width, 0)
  expect((await rect(wrapper)).width).toBeCloseTo(208, 0)
  const sidebarBox = await rect(asideEl(page))
  expect(sidebarBox.x + sidebarBox.width).toBeLessThanOrEqual(peeked.x)

  // Leaving it: the sidebar slides away and the page takes the whole width again.
  await page.mouse.move(640, 400)
  await expect(aside).toBeHidden()
  await settled(page)
  const after = (await column.boundingBox())!
  expect(after.x).toBeCloseTo(hidden.x, 0)
  expect(after.width).toBeCloseTo(hidden.width, 0)
  expect((await rect(wrapper)).width).toBe(0)
})

test('a pointer resting near the edge below the sidebar keeps it open and does not make it flicker', async ({
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
  // Near the edge but lower than the sidebar's last link: over the empty space it leaves below it.
  await page.mouse.move(30, 760)
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()
  await settled(page)
  expect((await rect(asideEl(page))).y + (await rect(asideEl(page))).height).toBeLessThan(760)
  await recordSlides(page)
  await page.waitForTimeout(1500)
  // Resting there it stays open: nothing slides in or out.
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()
  expect(await slidesSeen(page)).toEqual([])
  // Nothing lies over the page at the left edge: what is there is the page's own.
  await page.mouse.move(640, 400)
  await expect(aside).toBeHidden()
  await settled(page)
  const over = await page.evaluate(
    () => document.elementFromPoint(20, 400)?.closest('[aria-hidden="true"]') != null,
  )
  expect(over).toBe(false)
})

test('a pointer resting on the edge while the sidebar slides in under it keeps it open', async ({
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
  // 30px from the edge: near it, and where the sidebar will be once it has slid in (its place starts at 16px).
  await page.mouse.move(30, 400)
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()
  await page.waitForTimeout(1000)
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()
  // The sidebar's links take the clicks: nothing lies over it.
  await aside.getByRole('link', { name: 'Roadmap' }).click()
  await expect(page).toHaveURL(/\/roadmap$/)
})

test('a peeked hidden sidebar that closes after a click keeps focus on the toggle in it, not the page body', async ({
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
  // The link the click focused is gone with the sidebar: focus goes to the toggle inside it, which shows it again.
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeFocused()
})

test('a click in a peeked sidebar that leaves focus on the body still closes it with focus on the toggle in it', async ({
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

  await recordSlides(page)
  await page.mouse.move(640, 400)
  await page.mouse.move(20, 400)
  // It slides: a translate transition runs (it is not there at once), and ends where the sidebar was.
  await expect.poll(() => slidesSeen(page)).toContain('translate')
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()
  await settled(page)
  const shown = await rect(asideEl(page))
  expect(shown.x).toBeCloseTo(expanded.x, 0)
  expect(shown.width).toBeCloseTo(expanded.width, 0)
  expect(await aside.getByRole('link').allInnerTexts()).toEqual(links)
  // The sidebar itself, not a card: no shadow, border, background or rounded corners, in the page's flow position
  // (not pinned), and no layer over the page.
  const look = await asideEl(page).evaluate((el) => {
    const style = getComputedStyle(el)
    const place = getComputedStyle(el.parentElement!)
    return {
      shadow: style.boxShadow,
      radius: style.borderRadius,
      position: style.position,
      border: style.borderRightWidth,
      background: style.backgroundColor,
      layer: place.zIndex,
    }
  })
  expect(look).toEqual({
    shadow: 'none',
    radius: '0px',
    position: 'static',
    border: '0px',
    background: 'rgba(0, 0, 0, 0)',
    layer: 'auto',
  })

  // Leaving slides it back out to the left, and then it is out of reach.
  await page.evaluate(() => ((window as unknown as { slidesSeen: string[] }).slidesSeen.length = 0))
  await page.mouse.move(640, 400)
  await expect(aside).toBeHidden()
  expect(await slidesSeen(page)).toContain('translate')
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

  // Back to expanded: the sidebar slides in (the page moves right with it), and pressing Show in it keeps it
  // where it is: the same sidebar, now staying, and the page does not jump.
  await peek(page)
  expect(await pageX()).toBeCloseTo(expandedX, 0)
  await page.getByRole('button', { name: 'Show sidebar' }).click()
  await page.mouse.move(640, 400)
  await page.waitForTimeout(600)
  await settled(page)
  await expect(page.getByRole('button', { name: 'Shrink sidebar' })).toBeVisible()
  expect((await rect(asideEl(page))).width).toBeCloseTo(expandedWidth, 0)
  expect(await pageX()).toBeCloseTo(expandedX, 0)
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
  await expect(sidebar(page)).toBeHidden()
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toHaveCount(1)
  expect(await isOffscreen(page.getByRole('button', { name: 'Show sidebar' }))).toBe(true)
  await page.waitForTimeout(500)
  const slid = await page.evaluate(() => (window as unknown as { slid: string[] }).slid)
  expect(slid.filter((property) => ['width', 'translate', 'margin-right'].includes(property))).toEqual([])
})

test('the toggle is inside the sidebar: out of the window with it while hidden, back with it', async ({
  page,
  project,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  await page.getByRole('button', { name: 'Shrink sidebar' }).click()
  await page.getByRole('button', { name: 'Hide sidebar' }).click()
  const aside = sidebar(page)
  await expect(aside).toBeHidden()
  await settled(page)
  const show = page.getByRole('button', { name: 'Show sidebar' })
  // No toggle on the screen, and the only one there is lives inside the sidebar.
  expect(await isOffscreen(show)).toBe(true)
  expect(await page.locator('button[aria-label$=" sidebar"]').count()).toBe(1)
  expect(await asideEl(page).locator('button[aria-label$=" sidebar"]').count()).toBe(1)

  await peek(page)
  // The toggle is in the sidebar's first row, above Overview, inside its box.
  const asideBox = await rect(asideEl(page))
  const toggleBox = await rect(show)
  const overviewBox = (await aside.getByRole('link', { name: 'Overview' }).boundingBox())!
  expect(toggleBox.x).toBeGreaterThanOrEqual(asideBox.x)
  expect(toggleBox.x + toggleBox.width).toBeLessThanOrEqual(asideBox.x + asideBox.width)
  expect(toggleBox.y + toggleBox.height).toBeLessThanOrEqual(overviewBox.y)
  // Resting the pointer on it keeps the sidebar open, well past the close delay.
  await page.mouse.move(toggleBox.x + toggleBox.width / 2, toggleBox.y + toggleBox.height / 2, { steps: 4 })
  await page.waitForTimeout(800)
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()

  // Leaving it for the page closes the sidebar, and the toggle goes with it.
  await page.mouse.move(640, 400)
  await expect(aside).toBeHidden()
  await settled(page)
  expect(await isOffscreen(show)).toBe(true)
})

test('pressing Hide with the mouse leaves the sidebar hidden, not reopened under the pointer', async ({
  page,
  project,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  await page.getByRole('button', { name: 'Shrink sidebar' }).click()
  await page.getByRole('button', { name: 'Hide sidebar' }).click()
  // The pointer rests where the toggle was; the sidebar slides out and stays out.
  await page.waitForTimeout(800)
  await expect(sidebar(page)).toBeHidden()
  expect(await isOffscreen(asideEl(page))).toBe(true)
})

test('a hidden sidebar is reached by keyboard: Tab to its toggle shows it, Enter expands it', async ({
  page,
  project,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  await page.getByRole('button', { name: 'Shrink sidebar' }).click()
  await page.getByRole('button', { name: 'Hide sidebar' }).click()
  const aside = sidebar(page)
  await expect(aside).toBeHidden()
  // Focus left the toggle (the press that hid the sidebar kept it there). The sidebar's links are out of the
  // tab order; its toggle is the one thing the keyboard can reach, and reaching it shows the sidebar.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.getByRole('button', { name: 'Show sidebar' }).focus()
  await expect(aside.getByRole('link', { name: 'Overview' })).toBeVisible()
  await settled(page)
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeInViewport()
  await page.keyboard.press('Tab')
  await expect(aside.getByRole('link', { name: 'Overview' })).toBeFocused()
  await page.getByRole('button', { name: 'Show sidebar' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Shrink sidebar' })).toBeFocused()
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()
})

test('clicking blank space inside a peeked sidebar keeps it open under the pointer', async ({
  page,
  project,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  await page.getByRole('button', { name: 'Shrink sidebar' }).click()
  await page.getByRole('button', { name: 'Hide sidebar' }).click()
  const aside = sidebar(page)
  await expect(aside).toBeHidden()
  await peek(page)
  // Focus is on the toggle in the sidebar; a click on the sidebar's empty space (left of the toggle, in its
  // first row) moves it to the body.
  const show = page.getByRole('button', { name: 'Show sidebar' })
  await show.focus()
  const toggleBox = (await show.boundingBox())!
  const blank = { x: toggleBox.x - 20, y: toggleBox.y + toggleBox.height / 2 }
  await page.mouse.move(blank.x, blank.y)
  await page.mouse.click(blank.x, blank.y)
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
  await page.waitForTimeout(800)
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()
})

test('pressing Hide with the keyboard keeps the sidebar shown around the focused toggle until focus leaves', async ({
  page,
  project,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  const aside = sidebar(page)
  await page.getByRole('button', { name: 'Shrink sidebar' }).focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  const show = page.getByRole('button', { name: 'Show sidebar' })
  await expect(show).toBeFocused()
  await settled(page)
  // Focus is on a toggle the user can see: the sidebar is still there, while the page has taken its room.
  await expect(show).toBeInViewport()
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()
  // Focus moves on to the page: the sidebar slides out.
  await page.locator('section.min-w-0 a, section.min-w-0 button').first().focus()
  await expect(aside).toBeHidden()
})

test('on a wide window a pointer travelling slowly from the left edge to the sidebar keeps it open', async ({
  page,
  project,
}) => {
  await page.setViewportSize({ width: 1920, height: 900 })
  await page.goto(`/projects/${project.id}/prs`)
  await page.getByRole('button', { name: 'Shrink sidebar' }).click()
  await page.getByRole('button', { name: 'Hide sidebar' }).click()
  const aside = sidebar(page)
  await expect(aside).toBeHidden()
  await page.mouse.move(960, 400)
  await page.mouse.move(20, 400)
  await expect(aside.getByRole('link', { name: 'Overview' })).toBeVisible()
  await settled(page)
  // The sidebar rests well right of the 40px edge strip here: stop between them for longer than the close delay.
  const box = (await rect(asideEl(page)))!
  expect(box.x).toBeGreaterThan(100)
  await page.mouse.move(box.x / 2, 400)
  await page.waitForTimeout(800)
  await expect(aside.getByRole('link', { name: 'Overview' })).toBeVisible()
  await page.mouse.move(box.x + 20, 400)
  await page.waitForTimeout(500)
  await expect(aside.getByRole('link', { name: 'Overview' })).toBeVisible()
})

test('a click on Hide that does not come from the keyboard or a pointer leaves the sidebar hidden', async ({
  page,
  project,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  await page.getByRole('button', { name: 'Shrink sidebar' }).click()
  await page.mouse.move(900, 400)
  // A script's click (assistive tech, an extension): no focus on the toggle, no pointer in the sidebar.
  await page.evaluate(() => {
    ;(document.activeElement as HTMLElement | null)?.blur()
    document.querySelector<HTMLButtonElement>('aside button')?.click()
  })
  await page.waitForTimeout(1000)
  await expect(sidebar(page)).toBeHidden()
  expect(await isOffscreen(asideEl(page))).toBe(true)
})
