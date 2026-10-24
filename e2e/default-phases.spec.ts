import type { Locator } from '@playwright/test'

import type { Project, TicketFull } from '#/lib/api'
import { expect, ok, test } from './fixtures'

const BUILT_IN = ['Implementation', 'Pushed', 'PR', 'CI', 'Preview', 'Merged', 'Hand-off post']

/** The phases listed in the section, in order. */
const listed = (section: Locator) =>
  section.getByRole('list', { name: 'Default phases' }).getByRole('listitem')

test('the human sets the default phases on the Settings page, and new tickets start with them', async ({
  page,
  project,
  human,
}) => {
  const phases = async () => (await ok<Project>(human.get(`/api/projects/${project.id}`))).defaultPhases
  /** A new top-level ticket's tasks, in order. */
  const seeded = async (title: string) => {
    const t = await ok<TicketFull>(human.post(`/api/projects/${project.id}/tickets`, { data: { title } }))
    return (await ok<TicketFull>(human.get(`/api/tickets/${t.id}`))).tasks.map((x) => x.text)
  }

  await page.goto(`/projects/${project.id}/settings`)
  const section = page.getByRole('region', { name: 'Default phases' })
  await expect(section.getByRole('heading', { name: 'Default phases' })).toBeVisible()
  const field = section.getByRole('textbox', { name: 'New phase' })
  const save = section.getByRole('button', { name: 'Save' })
  const status = section.getByText(/^(No changes|Unsaved changes)\.$/)
  // The list in effect: the built-in one, until it is changed.
  await expect(listed(section)).toHaveText(BUILT_IN)
  await expect(field).toHaveAttribute('placeholder', 'Add a phase')
  await expect(save).toBeDisabled()
  await expect(status).toHaveText('No changes.')
  await section.screenshot({ path: test.info().outputPath('default-phases.png') })

  // Removed with ×, every one but Implementation and PR.
  for (const name of ['Pushed', 'CI', 'Preview', 'Merged', 'Hand-off post']) {
    await section.getByRole('button', { name: `Remove ${name}` }).click()
  }
  await expect(listed(section)).toHaveText(['Implementation', 'PR'])
  await expect(status).toHaveText('Unsaved changes.')
  // Added with Enter (trimmed) and with +.
  await field.fill('  Design  ')
  await field.press('Enter')
  await expect(field).toHaveValue('')
  await field.fill('Ship')
  await section.getByRole('button', { name: 'Add phase' }).click()
  await expect(field).toBeFocused()
  await expect(listed(section)).toHaveText(['Implementation', 'PR', 'Design', 'Ship'])

  // Reordered from the keyboard: Design up twice, to the top, the focus following it.
  await section.getByRole('button', { name: 'Move Design up' }).focus()
  await page.keyboard.press('Enter')
  await expect(listed(section)).toHaveText(['Implementation', 'Design', 'PR', 'Ship'])
  await expect(section.getByRole('button', { name: 'Move Design up' })).toBeFocused()
  await page.keyboard.press('Space')
  await expect(listed(section)).toHaveText(['Design', 'Implementation', 'PR', 'Ship'])
  // At the top its up button is off, so the focus moves to its down button.
  await expect(section.getByRole('button', { name: 'Move Design up' })).toBeDisabled()
  await expect(section.getByRole('button', { name: 'Move Design down' })).toBeFocused()
  // PR down once, to the end, where its down button is off.
  await section.getByRole('button', { name: 'Move PR down' }).focus()
  await page.keyboard.press('Enter')
  await expect(listed(section)).toHaveText(['Design', 'Implementation', 'Ship', 'PR'])
  await expect(section.getByRole('button', { name: 'Move PR down' })).toBeDisabled()
  await expect(section.getByRole('button', { name: 'Move PR up' })).toBeFocused()

  await save.click()
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Saved' })).toBeVisible()
  await expect(save).toBeDisabled()
  await expect(status).toHaveText('No changes.')
  const order = ['Design', 'Implementation', 'Ship', 'PR']
  expect(await phases()).toEqual(order)
  await page.reload()
  await expect(listed(section)).toHaveText(order)
  expect(await seeded('custom')).toEqual(order)

  // What is typed and not yet added is saved too.
  await field.fill('Review')
  await expect(status).toHaveText('Unsaved changes.')
  await save.click()
  await expect.poll(phases).toEqual([...order, 'Review'])
  await expect(listed(section)).toHaveText([...order, 'Review'])
  await expect(field).toHaveValue('')

  // Back to as saved: no changes again.
  await section.getByRole('button', { name: 'Remove Review' }).click()
  await expect(status).toHaveText('Unsaved changes.')
  await field.fill('Review')
  await field.press('Enter')
  await expect(status).toHaveText('No changes.')
  await expect(save).toBeDisabled()

  // Emptied, it seeds nothing.
  for (const name of [...order, 'Review']) {
    await section.getByRole('button', { name: `Remove ${name}` }).click()
  }
  await expect(section.getByText('No phases: new tickets start with no tasks.')).toBeVisible()
  await save.click()
  await expect(save).toBeDisabled()
  expect(await phases()).toEqual([])
  await page.reload()
  await expect(listed(section)).toHaveCount(0)
  await expect(section.getByText('No phases: new tickets start with no tasks.')).toBeVisible()
  expect(await seeded('none')).toEqual([])

  // Back to the built-in list.
  await section.getByRole('button', { name: 'Use the built-in list' }).click()
  await expect(listed(section)).toHaveText(BUILT_IN)
  expect(await phases()).toEqual(BUILT_IN)
  await page.reload()
  await expect(listed(section)).toHaveText(BUILT_IN)
  expect(await seeded('built-in')).toEqual(BUILT_IN)
})

test('the Settings page shows the refusal of a list the server will not take, and keeps it to fix', async ({
  page,
  project,
  human,
}) => {
  await page.goto(`/projects/${project.id}/settings`)
  const section = page.getByRole('region', { name: 'Default phases' })
  const field = section.getByRole('textbox', { name: 'New phase' })
  // Pasted lines add one phase each: 7 built in and 14 more, over the 20 allowed.
  const more = Array.from({ length: 14 }, (_, i) => `Phase ${i + 1}`)
  await field.focus()
  await field.evaluate((el, text) => {
    const data = new DataTransfer()
    data.setData('text/plain', text)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, more.join('\n'))
  await expect(listed(section)).toHaveCount(21)
  await section.getByRole('button', { name: 'Save' }).click()
  await expect(page.locator('[data-sonner-toast]').first()).toBeVisible()
  await expect(listed(section)).toHaveText([...BUILT_IN, ...more])
  expect((await ok<Project>(human.get(`/api/projects/${project.id}`))).defaultPhases).toEqual(BUILT_IN)
})

test.describe('at 390px', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('the phases and tags lists fit without a sideways scroll, in light and dark', async ({
    page,
    project,
  }) => {
    await page.goto(`/projects/${project.id}/settings`)
    const phases = page.getByRole('region', { name: 'Default phases' })
    const field = phases.getByRole('textbox', { name: 'New phase' })
    await field.fill('A phase with a rather long name that has to wrap at this width')
    await field.press('Enter')
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      for (const name of ['Default phases', 'Tag suggestions']) {
        const section = page.getByRole('region', { name })
        await section.scrollIntoViewIfNeeded()
        await section.screenshot({ path: test.info().outputPath(`${name}-390-${scheme}.png`) })
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        ),
      ).toBe(false)
    }
    const remove = phases.getByRole('button', { name: /^Remove A phase with/ })
    await remove.scrollIntoViewIfNeeded()
    await expect(remove).toBeInViewport()
    await remove.tap()
    await expect(listed(phases)).toHaveText(BUILT_IN)
  })
})
