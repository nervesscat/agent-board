import type { APIRequestContext, Locator, Page } from '@playwright/test'

import type { Project, ReportSettingsView } from '#/lib/api'
import { expect, ok, test } from './fixtures'

// A daily report left missing shows its reminder on every later test's pages once its shift has ended,
// so each test here turns its project's reports off when it is done (as `quiet()` does in dailyPage.ts).
test.afterEach(async ({ human, project }) => {
  await ok(human.patch(`/api/projects/${project.id}/report-settings`, { data: { cadence: 'off' } }))
})

/** The project's Daily page with its report settings open: the schedule group, where the clocks are. */
async function openSchedule(page: Page, project: Project) {
  await page.goto(`/projects/${project.id}/daily`)
  const settings = page.getByRole('region', { name: 'Report settings' })
  await settings.getByRole('button', { name: /^Report settings/ }).click()
  return settings.getByRole('group', { name: 'Schedule' })
}

/** Where on a clock's face a time sits: `minutes` round the dial (0 to 60), `r` out of the face's 100. */
async function onFace(slider: Locator, minutes: number, r = 80) {
  await slider.scrollIntoViewIfNeeded()
  const box = (await slider.boundingBox())!
  const rad = (minutes / 60) * 2 * Math.PI
  const scale = box.width / 200
  return {
    x: box.x + box.width / 2 + r * scale * Math.sin(rad),
    y: box.y + box.height / 2 - r * scale * Math.cos(rad),
  }
}

const daily = (human: APIRequestContext, project: Project) =>
  ok(human.patch(`/api/projects/${project.id}/report-settings`, { data: { cadence: 'daily' } }))

test.describe('on a 12-hour locale', () => {
  test.use({ locale: 'en-US' })

  test('the clock sets the hour, then the minute, by tapping or dragging the face, in 5 minute steps', async ({
    page,
    project,
    human,
  }) => {
    await daily(human, project)
    const schedule = await openSchedule(page, project)
    const start = schedule.getByRole('slider', { name: 'Shift start' })
    await expect(start).toHaveAttribute('aria-valuetext', '9:00 AM')

    // The hour first: a tap at the 3, in the morning as before. The minute is next.
    let at = await onFace(start, 15)
    await page.mouse.click(at.x, at.y)
    await expect(start).toHaveAttribute('aria-valuetext', '3:00 AM')
    await expect(start).toHaveAttribute('data-mode', 'minute')

    // A tap at the 3 is a quarter past.
    at = await onFace(start, 15)
    await page.mouse.click(at.x, at.y)
    await expect(start).toHaveAttribute('aria-valuetext', '3:15 AM')

    // A drag of the hand from the 12 to :17 lands on :15, and through :39 to :38 on :40.
    for (const [to, want] of [
      [17, '3:15 AM'],
      [38, '3:40 AM'],
    ] as const) {
      const from = await onFace(start, 0)
      const end = await onFace(start, to)
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move((from.x + end.x) / 2 + 20, (from.y + end.y) / 2, { steps: 5 })
      await page.mouse.move(end.x, end.y, { steps: 5 })
      await page.mouse.up()
      await expect(start).toHaveAttribute('aria-valuetext', want)
    }
    await expect(schedule.getByRole('textbox', { name: 'Shift start (type a time)' })).toHaveValue('3:40 AM')
  })

  test('the clock shows AM and PM, and switches between them', async ({ page, project, human }) => {
    await daily(human, project)
    const schedule = await openSchedule(page, project)
    const end = schedule.getByRole('group', { name: 'Shift end', exact: true })
    await expect(end.getByRole('textbox', { name: 'Shift end (type a time)' })).toHaveValue('5:00 PM')
    await expect(end.getByRole('button', { name: 'PM' })).toHaveAttribute('aria-pressed', 'true')
    await end.getByRole('button', { name: 'AM' }).click()
    await expect(end.getByRole('slider', { name: 'Shift end' })).toHaveAttribute('aria-valuetext', '5:00 AM')
    await end.getByRole('button', { name: 'PM' }).click()
    await expect(end.getByRole('slider', { name: 'Shift end' })).toHaveAttribute('aria-valuetext', '5:00 PM')
  })

  test('the time is typed as text too; a time that is not one is marked and not taken', async ({
    page,
    project,
    human,
  }) => {
    await daily(human, project)
    const schedule = await openSchedule(page, project)
    const slider = schedule.getByRole('slider', { name: 'Shift start' })
    const text = schedule.getByRole('textbox', { name: 'Shift start (type a time)' })
    const hand = slider.locator('[data-part="hand"]')
    const before = await hand.getAttribute('x2')

    await text.fill('08:45')
    await expect(slider).toHaveAttribute('aria-valuetext', '8:45 AM')
    await expect(slider).toHaveAttribute('aria-valuenow', String(8 * 60 + 45))
    // The hand moved with it.
    expect(await hand.getAttribute('x2')).not.toBe(before)
    await expect(text).not.toHaveAttribute('aria-invalid')

    await text.fill('25:99')
    await expect(text).toHaveAttribute('aria-invalid', 'true')
    await expect(slider).toHaveAttribute('aria-valuetext', '8:45 AM')
    await text.blur()
    await expect(text).toHaveAttribute('aria-invalid', 'true')

    await text.fill('6:30 pm')
    await expect(slider).toHaveAttribute('aria-valuetext', '6:30 PM')
    await expect(text).not.toHaveAttribute('aria-invalid')
  })

  test('the clock is a slider for the keyboard: arrows move it by 5 minutes, Page keys by the hour', async ({
    page,
    project,
    human,
  }) => {
    await daily(human, project)
    const schedule = await openSchedule(page, project)
    const slider = schedule.getByRole('slider', { name: 'Shift start' })
    await slider.focus()
    await expect(slider).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(slider).toHaveAttribute('aria-valuetext', '9:05 AM')
    await page.keyboard.press('ArrowRight')
    await expect(slider).toHaveAttribute('aria-valuetext', '9:10 AM')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await expect(slider).toHaveAttribute('aria-valuetext', '8:55 AM')
    await page.keyboard.press('PageUp')
    await expect(slider).toHaveAttribute('aria-valuetext', '9:55 AM')
    await page.keyboard.press('Home')
    await expect(slider).toHaveAttribute('aria-valuetext', '12:00 AM')
    // It stops at midnight rather than going round.
    await page.keyboard.press('ArrowDown')
    await expect(slider).toHaveAttribute('aria-valuenow', '0')
  })

  test('the shift is set with the clocks with its workdays and reminder, and kept after a reload', async ({
    page,
    project,
    human,
  }) => {
    await daily(human, project)
    let schedule = await openSchedule(page, project)
    const start = schedule.getByRole('slider', { name: 'Shift start' })
    const end = schedule.getByRole('slider', { name: 'Shift end' })
    // Start at 8:30: the 8, then the 6 for :30.
    for (const m of [40, 30]) {
      const at = await onFace(start, m)
      await page.mouse.click(at.x, at.y)
    }
    await expect(start).toHaveAttribute('aria-valuetext', '8:30 AM')
    // End at 6:15 PM: the 6 (still afternoon), then :15 by keyboard.
    const at = await onFace(end, 30)
    await page.mouse.click(at.x, at.y)
    await end.focus()
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp')
    await expect(end).toHaveAttribute('aria-valuetext', '6:15 PM')

    await schedule.getByRole('checkbox', { name: 'Friday' }).click()
    await expect(schedule.getByRole('checkbox', { name: 'Friday' })).not.toBeChecked()
    await schedule.getByLabel('Remind from (minutes before the end)').fill('45')

    // An end before the start cannot be saved.
    await schedule.getByRole('textbox', { name: 'Shift end (type a time)' }).fill('7:00 AM')
    await expect(schedule.getByRole('alert')).toHaveText('The shift must end after it starts.')
    await expect(schedule.getByRole('button', { name: 'Save' })).toBeDisabled()
    await schedule.getByRole('textbox', { name: 'Shift end (type a time)' }).fill('6:15 PM')

    await schedule.getByRole('button', { name: 'Save' }).click()
    await expect(schedule.getByRole('button', { name: 'Save' })).toBeDisabled()
    const saved = await ok<ReportSettingsView>(human.get(`/api/projects/${project.id}/report-settings`))
    expect(saved).toMatchObject({
      shiftStart: '08:30',
      shiftEnd: '18:15',
      workdays: [1, 2, 3, 4],
      alertMinutes: 45,
    })

    await page.reload()
    schedule = await openSchedule(page, project)
    await expect(schedule.getByRole('slider', { name: 'Shift start' })).toHaveAttribute(
      'aria-valuetext',
      '8:30 AM',
    )
    await expect(schedule.getByRole('slider', { name: 'Shift end' })).toHaveAttribute(
      'aria-valuetext',
      '6:15 PM',
    )
    await expect(schedule.getByRole('checkbox', { name: 'Friday' })).not.toBeChecked()
    await expect(schedule.getByRole('checkbox', { name: 'Thursday' })).toBeChecked()
    await expect(schedule.getByLabel('Remind from (minutes before the end)')).toHaveValue('45')
  })
})

test.describe('on a 24-hour locale', () => {
  test.use({ locale: 'de-DE' })

  test('the clock reads 24 hours without AM/PM, the afternoon on the inner ring', async ({
    page,
    project,
    human,
  }) => {
    await daily(human, project)
    const schedule = await openSchedule(page, project)
    const end = schedule.getByRole('group', { name: 'Shift end', exact: true })
    const slider = end.getByRole('slider', { name: 'Shift end' })
    await expect(end.getByRole('textbox', { name: 'Shift end (type a time)' })).toHaveValue('17:00')
    await expect(slider).toHaveAttribute('aria-valuetext', '17:00')
    await expect(end.getByRole('button', { name: 'AM' })).toHaveCount(0)
    await expect(end.getByRole('button', { name: 'PM' })).toHaveCount(0)
    // Two rings of hours: 1 to 12 outside, 13 to 00 inside.
    await expect(slider.locator('[data-part="mark"]')).toHaveCount(24)
    await expect(slider.locator('[data-part="mark"]', { hasText: /^15$/ })).toHaveCount(1)

    // The 3 on the inner ring is 15:00, on the outer one 3:00.
    let at = await onFace(slider, 15, 54)
    await page.mouse.click(at.x, at.y)
    await expect(slider).toHaveAttribute('aria-valuetext', '15:00')
    await end.getByRole('button', { name: 'Hour' }).click()
    at = await onFace(slider, 15, 80)
    await page.mouse.click(at.x, at.y)
    await expect(slider).toHaveAttribute('aria-valuetext', '03:00')
  })
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'en-US' })

  test('a tap on the face sets the time, and the clocks fit without sideways scroll, light and dark', async ({
    page,
    project,
    human,
  }) => {
    await daily(human, project)
    const schedule = await openSchedule(page, project)
    const start = schedule.getByRole('slider', { name: 'Shift start' })
    await start.scrollIntoViewIfNeeded()
    const box = (await start.boundingBox())!
    // A tap at the 6 sets 6 AM; then a tap at the 9 is :45.
    await start.tap({ position: { x: box.width / 2, y: box.height / 2 + (80 * box.width) / 200 } })
    await expect(start).toHaveAttribute('aria-valuetext', '6:00 AM')
    await start.tap({ position: { x: box.width / 2 - (80 * box.width) / 200, y: box.height / 2 } })
    await expect(start).toHaveAttribute('aria-valuetext', '6:45 AM')
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
    ).toBe(false)
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)

    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      if (colorScheme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/)
      else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
      const colors = await start.evaluate((el) => {
        const css = (sel: string, prop: 'stroke' | 'fill') => getComputedStyle(el.querySelector(sel)!)[prop]
        return {
          hand: css('[data-part="hand"]', 'stroke'),
          face: css('[data-part="face"]', 'fill'),
          mark: css('[data-part="mark"]', 'fill'),
          page: getComputedStyle(document.body).backgroundColor,
        }
      })
      expect(colors.hand, colorScheme).not.toBe(colors.face)
      expect(colors.hand, colorScheme).not.toBe(colors.page)
      expect(colors.mark, colorScheme).not.toBe(colors.face)
      await schedule.screenshot({ path: test.info().outputPath(`analog-clock-${colorScheme}.png`) })
    }
  })
})
