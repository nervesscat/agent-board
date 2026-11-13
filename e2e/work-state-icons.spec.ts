import type { APIRequestContext, Page } from '@playwright/test'

import type { Project } from '#/lib/api'
import { expect, test, tooltip } from './fixtures'
import { age, create, workedTicket } from './workTimeline'

/**
 * The work-state line as an icon, and the State filter on Ongoing features: the icon's name and tooltip
 * on the ticket page (a keyboard focus and a touch tap), and the State filter on the Board and the List,
 * kept in the URL and combined with the Tags filter.
 */

const card = (page: Page, id: number, title: string) =>
  page.getByRole('link', { name: new RegExp(`#${id} ${title}`) })
const stateBox = (page: Page, name: string) => page.getByRole('checkbox', { name })
const stateParam = (page: Page) => new URL(page.url()).searchParams.get('state')

/** The four tickets the filter tests read: each in one state, and one with no line at all. */
async function fixtures(human: APIRequestContext, agent: APIRequestContext, project: Project) {
  const lost = await workedTicket(human, agent, project)
  const review = await create(human, project, { title: 'Review the copy', status: 'review', tags: ['UI'] })
  age(review.id, 48 * 60)
  const stuck = await create(human, project, { title: 'Stuck on a key', status: 'blocked' })
  const open = await create(human, project, { title: 'Not started yet', status: 'todo' })
  return { lost: lost.t, review, stuck, open }
}

test('the State filter keeps the Board to the states picked, counts them, and keeps the choice in the URL', async ({
  page,
  project,
  human,
  agent,
}) => {
  const { lost, review, stuck, open } = await fixtures(human, agent, project)

  await page.goto(`/projects/${project.id}/features?view=board`)
  await expect(card(page, review.id, 'Review the copy')).toBeVisible()
  await expect(card(page, open.id, 'Not started yet')).toBeVisible()

  await page.getByRole('button', { name: /^State/ }).click()
  await expect(stateBox(page, 'Your turn').locator('..')).toContainText('1')
  await stateBox(page, 'Your turn').click()
  expect(stateParam(page)).toBe('your-turn')
  await expect(card(page, review.id, 'Review the copy')).toBeVisible()
  await expect(card(page, lost.id, 'Ship the importer')).toHaveCount(0)
  await expect(card(page, stuck.id, 'Stuck on a key')).toHaveCount(0)
  // A ticket with no line matches no state: it is hidden under any choice.
  await expect(card(page, open.id, 'Not started yet')).toHaveCount(0)

  await stateBox(page, 'Waiting on you').click()
  expect(stateParam(page)).toBe('waiting,your-turn')
  await expect(card(page, stuck.id, 'Stuck on a key')).toBeVisible()
  await expect(card(page, lost.id, 'Ship the importer')).toHaveCount(0)

  // Reloaded, the same states are picked and the same rows shown.
  await page.reload()
  await page.getByRole('button', { name: /^State/ }).click()
  await expect(stateBox(page, 'Waiting on you')).toBeChecked()
  await expect(stateBox(page, 'Your turn')).toBeChecked()
  await expect(card(page, review.id, 'Review the copy')).toBeVisible()
  await expect(card(page, lost.id, 'Ship the importer')).toHaveCount(0)

  await page.getByRole('button', { name: 'Clear the state filter' }).click()
  expect(stateParam(page)).toBeNull()
  await expect(card(page, lost.id, 'Ship the importer')).toBeVisible()
  await expect(card(page, open.id, 'Not started yet')).toBeVisible()
})

test('the State filter combines with the Tags filter, and the List keeps the choice', async ({
  page,
  project,
  human,
  agent,
}) => {
  const { lost, review, open } = await fixtures(human, agent, project)
  // Another review ticket with no tag: in the same state, not in the tag.
  const untagged = await create(human, project, { title: 'Review the layout', status: 'review' })
  age(untagged.id, 48 * 60)

  await page.goto(`/projects/${project.id}/features?view=board&tag=UI&state=your-turn`)
  await expect(card(page, review.id, 'Review the copy')).toBeVisible()
  await expect(card(page, untagged.id, 'Review the layout')).toHaveCount(0)
  await expect(card(page, lost.id, 'Ship the importer')).toHaveCount(0)

  // Switching to the List keeps both filters.
  await page.getByRole('tab', { name: 'List' }).click()
  await expect(page).toHaveURL(/state=your-turn/)
  await expect(page).toHaveURL(/tag=UI/)
  await expect(page.getByRole('link', { name: new RegExp(`#${review.id} Review the copy`) })).toBeVisible()
  await expect(page.getByRole('link', { name: new RegExp(`#${untagged.id} Review the layout`) })).toHaveCount(
    0,
  )
  await expect(page.getByRole('link', { name: new RegExp(`#${open.id} Not started yet`) })).toHaveCount(0)
})

test('the work-state icon on the ticket page is named by its line and its tooltip opens on focus', async ({
  page,
  project,
  human,
  agent,
}) => {
  const { t } = await workedTicket(human, agent, project)
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const line = page.getByRole('region', { name: 'Timeline' }).getByTestId('work-line')
  await expect(line).toHaveAttribute('data-state', 'lost')
  await expect(line).toHaveAccessibleName(/Lost contact · \d+m/)
  await expect(line.locator('svg')).toHaveCount(1)

  await line.focus()
  await expect(tooltip(page)).toBeVisible()
  await expect(tooltip(page)).toContainText(/Lost contact · \d+m/)
  await expect(tooltip(page)).toContainText(/claude · build · \d+ min/)
})

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true })

  test('a tap on the work-state icon opens its tooltip', async ({ page, project, human, agent }) => {
    const { t } = await workedTicket(human, agent, project)
    await page.goto(`/projects/${project.id}/features/${t.id}`)
    const line = page.getByRole('region', { name: 'Timeline' }).getByTestId('work-line')
    await line.tap()
    await expect(tooltip(page)).toBeVisible()
    await expect(tooltip(page)).toContainText(/Lost contact · \d+m/)
  })
})
