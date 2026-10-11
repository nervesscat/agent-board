import type { Page } from '@playwright/test'

import type { ReportSettingsChange, ReportSettingsView } from '#/lib/api'
import { DEFAULT_REPORT_TEMPLATE } from '#/lib/reportTemplate'
import { expect, ok, test } from './fixtures'

const scrollsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)

const openSettings = async (page: Page) => {
  const settings = page.getByRole('region', { name: 'Report settings' })
  await settings.getByRole('button', { name: /^Report settings/ }).click()
  return settings
}

test('the human edits the prompt and the template on the Daily page; both stay after a reload', async ({
  page,
  project,
  human,
}) => {
  await page.goto(`/projects/${project.id}/daily`)
  let settings = await openSettings(page)

  const prompt = settings.getByRole('group', { name: 'Prompt' })
  await prompt.getByRole('button', { name: /^No report prompt yet/ }).click()
  await prompt.getByRole('textbox', { name: 'Report prompt' }).fill('Plain words, for the client.')
  await prompt.getByRole('button', { name: 'Save' }).click()
  await expect(prompt).toContainText('Plain words, for the client.')

  const template = settings.getByRole('group', { name: 'Template', exact: true })
  await expect(template).toContainText('the default')
  await expect(template).toContainText('Done · In progress · Blocked / needs you · Pushed today · Next')
  await template.getByRole('button', { name: 'edit' }).click()
  await template
    .getByRole('textbox', { name: 'Report template' })
    .fill('## Shipped\n\n## Risks\n\n## Next week\n')
  await expect(template).toContainText('Shipped · Risks · Next week')
  await template.getByRole('button', { name: 'Save' }).click()
  await expect(template.getByRole('textbox', { name: 'Report template' })).toBeHidden()

  await page.reload()
  settings = await openSettings(page)
  await expect(settings.getByRole('group', { name: 'Prompt' })).toContainText('Plain words, for the client.')
  await expect(settings.getByRole('group', { name: 'Template', exact: true })).toContainText('## Risks')
  await expect(settings.getByRole('group', { name: 'Template', exact: true })).not.toContainText(
    'the default',
  )
  const saved = await ok<ReportSettingsView>(human.get(`/api/projects/${project.id}/report-settings`))
  expect(saved).toMatchObject({
    prompt: 'Plain words, for the client.',
    template: '## Shipped\n\n## Risks\n\n## Next week\n',
  })

  // Back to the default.
  await settings
    .getByRole('group', { name: 'Template', exact: true })
    .getByRole('button', { name: 'edit' })
    .click()
  await settings.getByRole('button', { name: 'Use the default' }).click()
  await settings
    .getByRole('group', { name: 'Template', exact: true })
    .getByRole('button', { name: 'Save' })
    .click()
  await expect(settings.getByRole('group', { name: 'Template', exact: true })).toContainText('the default')
  expect(
    (await ok<ReportSettingsView>(human.get(`/api/projects/${project.id}/report-settings`)))
      .templateIsDefault,
  ).toBe(true)
})

test('an agent’s change of the prompt is flagged until the human accepts it; the human’s own is not', async ({
  page,
  project,
  human,
  agent,
}) => {
  await ok(human.patch(`/api/projects/${project.id}/report-settings`, { data: { prompt: 'Mine.' } }))
  await page.goto(`/projects/${project.id}/daily`)
  const notices = page.getByRole('region', { name: 'Changes by agents to review' })
  await expect(page.getByText('Report settings', { exact: true })).toBeVisible()
  await expect(notices).toHaveCount(0)

  await ok(agent.patch(`/api/projects/${project.id}/report-settings`, { data: { prompt: 'Theirs.' } }))
  await page.reload()
  const notice = notices.getByRole('article')
  await expect(notice).toHaveCount(1)
  await expect(notice).toContainText('The report prompt was changed by claude, revert?')
  const { pending } = await ok<ReportSettingsView>(human.get(`/api/projects/${project.id}/report-settings`))
  expect(pending).toMatchObject([{ field: 'prompt', changedBy: 'claude', byAgent: true, state: 'pending' }])

  await notice.getByRole('button', { name: 'Accept' }).click()
  await expect(notices).toHaveCount(0)
  const after = await ok<ReportSettingsView>(human.get(`/api/projects/${project.id}/report-settings`))
  expect(after).toMatchObject({ prompt: 'Theirs.', pending: [] })
  const [change] = await ok<ReportSettingsChange[]>(
    human.get(`/api/projects/${project.id}/report-settings/changes?field=prompt`),
  )
  expect(change).toMatchObject({ newValue: 'Theirs.', state: 'accepted', resolvedBy: 'enrique' })
})

test('an agent’s change of the template is shown as a diff and reverted, as a change of its own', async ({
  page,
  project,
  human,
  agent,
}) => {
  await ok(
    agent.patch(`/api/projects/${project.id}/report-settings`, {
      data: { template: '## Done\n\n## Wins\n' },
    }),
  )
  await page.goto(`/projects/${project.id}/daily`)
  const notice = page.getByRole('region', { name: 'Changes by agents to review' }).getByRole('article')
  await expect(notice).toContainText('The report template was changed by claude, revert?')

  await notice.getByRole('button', { name: 'Show the change' }).click()
  const diff = notice.getByRole('group', { name: 'What changed in the report template' })
  await expect(diff.locator('del', { hasText: '## In progress' })).toBeVisible()
  await expect(diff.locator('ins', { hasText: '## Wins' })).toBeVisible()
  await expect(diff.locator('del', { hasText: '## Done' })).toHaveCount(0)

  // An agent cannot settle it.
  const id = (await ok<ReportSettingsView>(human.get(`/api/projects/${project.id}/report-settings`)))
    .pending[0]!.id
  expect((await agent.post(`/api/report-settings/changes/${id}/revert`)).status()).toBe(403)
  expect((await agent.post(`/api/report-settings/changes/${id}/accept`)).status()).toBe(403)

  await notice.getByRole('button', { name: 'Revert' }).click()
  await expect(notice).toHaveCount(0)
  const settings = await ok<ReportSettingsView>(human.get(`/api/projects/${project.id}/report-settings`))
  expect(settings).toMatchObject({ template: DEFAULT_REPORT_TEMPLATE, templateIsDefault: true, pending: [] })
  const [revert, reverted] = await ok<ReportSettingsChange[]>(
    human.get(`/api/projects/${project.id}/report-settings/changes`),
  )
  expect(revert).toMatchObject({ changedBy: 'enrique', byAgent: false, newValue: DEFAULT_REPORT_TEMPLATE })
  expect(reverted).toMatchObject({ id, state: 'reverted', resolvedBy: 'enrique' })

  // Both are lines of the day's activity.
  const activity = page.getByRole('region', { name: 'Activity' })
  await activity.getByRole('button', { name: 'Open all' }).click()
  await expect(activity.getByRole('button', { name: 'changed the report template' })).toBeVisible()
  await expect(
    activity.getByRole('button', { name: "reverted claude's change of the report template" }),
  ).toBeVisible()
})

test('an activity line of a change opens its diff', async ({ page, project, human }) => {
  await ok(
    human.patch(`/api/projects/${project.id}/report-settings`, {
      data: { prompt: 'One line.\nKeep it short.' },
    }),
  )
  await ok(
    human.patch(`/api/projects/${project.id}/report-settings`, {
      data: { prompt: 'Two lines.\nKeep it short.' },
    }),
  )
  await page.goto(`/projects/${project.id}/daily`)

  const activity = page.getByRole('region', { name: 'Activity' })
  await activity.getByRole('button', { name: 'Open all' }).click()
  const lines = activity.getByRole('button', { name: 'changed the report prompt' })
  await expect(lines).toHaveCount(2)
  await lines.last().click()
  const dialog = page.getByRole('dialog', { name: 'Change of the report prompt' })
  await expect(dialog).toContainText('by enrique')
  await expect(dialog.locator('del')).toHaveText(['−One line.'])
  await expect(dialog.locator('ins')).toHaveText(['+Two lines.'])
  await expect(dialog.getByText('Keep it short.')).toBeVisible()
})

test.describe('at 390px, light and dark', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('the notice, its diff, the template settings and the change dialog fit and read', async ({
    page,
    project,
    agent,
  }) => {
    const long = `## A heading long enough to wrap on a phone: ${'word '.repeat(30)}\n\n## https://example.com/a/very/long/path/that/goes/on/and/on/without/a/break\n`
    await ok(agent.patch(`/api/projects/${project.id}/report-settings`, { data: { template: long } }))
    await page.goto(`/projects/${project.id}/daily`)
    const notice = page.getByRole('region', { name: 'Changes by agents to review' }).getByRole('article')
    await notice.getByRole('button', { name: 'Show the change' }).tap()
    await expect(notice.locator('ins').first()).toBeVisible()
    const settings = await openSettings(page)
    await expect(settings.getByRole('group', { name: 'Template', exact: true })).toContainText(
      'A heading long enough',
    )

    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      if (colorScheme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/)
      expect(await scrollsSideways(page), colorScheme).toBe(false)
      // Text and marks stand out from what they sit on.
      for (const el of [
        notice.locator('p').first(),
        notice.locator('ins').first(),
        notice.locator('del').first(),
      ]) {
        const [color, back] = await el.evaluate((e) => {
          let bg = 'rgba(0, 0, 0, 0)'
          for (let n: Element | null = e; n && /rgba\(0, 0, 0, 0\)|transparent/.test(bg); n = n.parentElement)
            bg = getComputedStyle(n).backgroundColor
          return [getComputedStyle(e).color, bg]
        })
        expect(color, colorScheme).not.toBe(back)
      }
      await notice.screenshot({ path: test.info().outputPath(`change-notice-${colorScheme}.png`) })
      await settings.screenshot({ path: test.info().outputPath(`template-settings-${colorScheme}.png`) })
    }

    const activity = page.getByRole('region', { name: 'Activity' })
    await activity.getByRole('button', { name: 'Open all' }).tap()
    await activity.getByRole('button', { name: 'changed the report template' }).tap()
    const dialog = page.getByRole('dialog', { name: 'Change of the report template' })
    await expect(dialog.locator('ins').first()).toBeVisible()
    expect(await scrollsSideways(page)).toBe(false)
    const box = (await dialog.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    await dialog.screenshot({ path: test.info().outputPath('change-dialog-dark.png') })
  })
})
