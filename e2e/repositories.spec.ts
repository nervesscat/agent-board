import type { Project, Repo } from '#/lib/api'
import { expect, ok, seedProject, seededProject, test } from './fixtures'
import { backslashCheckout } from './repos'

/** The repositories page's card for the repo of that name. */
const card = (page: import('@playwright/test').Page, name: string) =>
  page.getByRole('button').filter({ has: page.locator('[data-slot="card-title"]', { hasText: name }) })

// A hydration mismatch: error #418 in production, "Hydration failed" or "did not match" in development.
const MISMATCH = /#418|Hydration failed|did not match the client/

// One load per test: two throttled loads in one test can use up its 30 s budget on a loaded machine.
for (let load = 1; load <= 3; load++) {
  test(`a project's repositories page hydrates without a mismatch, and its button works, when projects arrive during hydration, load ${load}`, async ({
    page,
  }) => {
    // A slow CPU stretches hydration across the header's projects request: the order that mismatched.
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 })
    const mismatches: string[] = []
    page.on('pageerror', (error) => {
      if (MISMATCH.test(error.message)) mismatches.push(error.message)
    })
    page.on('console', (message) => {
      if (message.type() === 'error' && MISMATCH.test(message.text())) mismatches.push(message.text())
    })
    // Registered before the navigation: the header's request can start, and be answered, before goto returns.
    const projectsAnswered = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/projects',
    )
    await page.goto(`/projects/${seededProject().id}/repositories`)
    // Only hydrated elements carry React's props. The test's own budget bounds this wait, not a fixed 10 s.
    await page.waitForFunction(() => {
      const heading = Array.from(document.querySelectorAll('h1')).find(
        (h) => h.textContent?.trim() === 'Repositories',
      )
      return heading !== undefined && Object.keys(heading).some((key) => key.startsWith('__reactProps$'))
    })
    // The mismatch, if any, happened while hydrating under the throttle. From here the page runs at full speed.
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    await projectsAnswered
    // The skeleton goes once the content is drawn: a click before that is lost, as the content is replaced.
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
    await page.getByRole('button', { name: 'New repository' }).click()
    const dialog = page.getByRole('dialog', { name: 'New repository' })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect(mismatches).toEqual([])
  })
}

test("a project's repositories page lists and manages only that project's repos", async ({
  page,
  human,
  project,
}, info) => {
  const other = await seedProject(human, `Other repos ${info.workerIndex}.${Date.now()}`)
  const theirs = `theirs-${info.workerIndex}-${Date.now()}`
  await ok<Repo>(
    human.post('/api/repos', {
      data: { projectId: other.id, repoPath: backslashCheckout('theirs'), name: theirs },
    }),
  )
  const mine = `mine-${info.workerIndex}-${Date.now()}`

  // Reached from the project's menu; the top bar has no Repositories link.
  await page.goto(`/projects/${project.id}`)
  await expect(page.getByRole('banner').getByRole('link', { name: 'Repositories' })).toHaveCount(0)
  await page.locator('aside nav').getByRole('link', { name: 'Repositories' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/repositories$`))
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
  await expect(card(page, 'repo')).toHaveCount(1)
  await expect(card(page, theirs)).toHaveCount(0)

  // Added here, it goes to this project.
  await page.getByRole('button', { name: 'New repository' }).click()
  const add = page.getByRole('dialog', { name: 'New repository' })
  await expect(add.getByLabel('Project')).toHaveText(project.name)
  await add.getByLabel('Repository path').fill(backslashCheckout('mine'))
  await add.getByLabel('Name').fill(mine)
  await add.getByRole('button', { name: 'Add repository' }).click()
  await expect(add).toHaveCount(0)
  await expect(card(page, mine)).toBeVisible()
  const added = await ok<Project>(human.get(`/api/projects/${project.id}`))
  expect(added.repos.map((r) => r.name).sort()).toEqual([mine, 'repo'].sort())

  // Moved to the other project from its edit dialog, it leaves this page and shows on that one's.
  await card(page, mine).click()
  const edit = page.getByRole('dialog', { name: `Edit ${mine}` })
  await edit.getByLabel('Project').click()
  await page.getByRole('option', { name: other.name }).click()
  await edit.getByRole('button', { name: 'Save' }).click()
  await expect(edit).toHaveCount(0)
  await expect(card(page, mine)).toHaveCount(0)
  await expect(card(page, 'repo')).toHaveCount(1)
  await page.goto(`/projects/${other.id}/repositories`)
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
  await expect(card(page, mine)).toBeVisible()
  await expect(card(page, theirs)).toBeVisible()
  const moved = await ok<Project>(human.get(`/api/projects/${other.id}`))
  expect(moved.repos.map((r) => r.name).sort()).toEqual([mine, 'repo', theirs].sort())

  // Removed from its edit dialog, it leaves the page and the project.
  await card(page, theirs).click()
  await page
    .getByRole('dialog', { name: `Edit ${theirs}` })
    .getByRole('button', { name: 'Remove repo' })
    .click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click()
  await expect(card(page, theirs)).toHaveCount(0)
  const left = await ok<Project>(human.get(`/api/projects/${other.id}`))
  expect(left.repos.map((r) => r.name).sort()).toEqual([mine, 'repo'].sort())
})

test('the old Repositories address lands on Home', async ({ page }) => {
  await page.goto('/repositories')
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
})
