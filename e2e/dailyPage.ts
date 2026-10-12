import type { APIRequestContext, Locator, Page } from '@playwright/test'

import type { Project, ReportDueList, TicketFull } from '#/lib/api'
import { localDate, shiftDate } from '#/lib/format'
import { inDatabase } from './db'
import { expect, ok, seedProject, test } from './fixtures'
import { look, ownRepo } from './repos'

/*
 * A project's Daily page with every part of it showing at once: today's report in two versions,
 * yesterday's done and the days before missing on the calendar, a shift ending in a few minutes, a
 * commit pushed today on a ticket's branch, a prompt an agent changed, and the day's activity. Beside
 * it a second project whose report is due, so the banner shows on every page.
 */

const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

/**
 * The shift runs from midnight to a few minutes from now: a few minutes before and after midnight it
 * cannot, so the test waits those out (and is given the time to).
 */
async function awayFromMidnight() {
  const now = new Date()
  const minutes = now.getHours() * 60 + now.getMinutes()
  if (minutes >= 3 && minutes < 23 * 60 + 45) return
  const until = new Date(now)
  if (minutes >= 3) until.setDate(until.getDate() + 1)
  until.setHours(0, 4, 0, 0)
  const wait = until.getTime() - now.getTime()
  test.setTimeout(test.info().timeout + wait)
  await new Promise((r) => setTimeout(r, wait))
}

/** Every day a workday, the shift ending 10 minutes from now, the reminder open all shift. */
const shift = () => ({
  cadence: 'daily',
  shiftStart: '00:00',
  shiftEnd: hhmm(new Date(Date.now() + 10 * 60_000)),
  workdays: [1, 2, 3, 4, 5, 6, 7],
  alertMinutes: 720,
})

const report = (done: string, next: string) =>
  `## Done\n\n- ${done}\n\n## In progress\n\n- Checkout totals\n\n## Blocked / needs you\n\n- Nothing\n\n## Pushed today\n\n- 1 commit on feat/checkout-totals\n\n## Next\n\n- ${next}\n`

export const today = localDate()
export const yesterday = shiftDate(today, -1)
/** The first of last month: tracking began then, so the calendar has missing days in any month. */
const lastMonth = `${shiftDate(`${today.slice(0, 7)}-01`, -1).slice(0, 7)}-01`

/** "October 6", as the calendar names a day. */
export const named = (day: string) =>
  new Date(`${day}T00:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })

export async function seedDailyPage(
  human: APIRequestContext,
  agent: APIRequestContext,
  name: string,
  { agentPrompt = 'What shipped, two lines a section.' }: { agentPrompt?: string } = {},
) {
  await awayFromMidnight()
  const repo = await ownRepo(human, name)
  const { project } = repo
  const ticket = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, {
      data: {
        title: 'Checkout totals, with a title long enough to wrap on a phone screen',
        status: 'in_progress',
        branch: 'feat/checkout-totals',
      },
    }),
  )
  repo.push('feat/checkout-totals')
  await look(human, project)

  await ok(
    human.patch(`/api/projects/${project.id}/report-settings`, {
      data: { ...shift(), prompt: 'What shipped today, for the team.' },
    }),
  )
  inDatabase((db) =>
    db.prepare('update report_settings set since = ? where project_id = ?').run(lastMonth, project.id),
  )
  const post = (period: string, body: string) =>
    ok(human.post(`/api/projects/${project.id}/reports`, { data: { period, body } }))
  await post(yesterday, report('The parser', 'Checkout totals'))
  await post(today, report('Checkout totals, first pass', 'Tests'))
  await post(today, report('Checkout totals, with a link https://example.com/a/very/long/path', 'Ship it'))
  // An agent changed the prompt: the page asks the human to accept or revert it.
  await ok(agent.patch(`/api/projects/${project.id}/report-settings`, { data: { prompt: agentPrompt } }))

  const due = await seedProject(human, `${name}, due`)
  await ok(human.patch(`/api/projects/${due.id}/report-settings`, { data: shift() }))
  const listed = await ok<ReportDueList>(human.get('/api/report-due'))
  expect(listed.items.find((d) => d.projectId === due.id)).toMatchObject({ state: 'due' })

  return {
    project,
    due,
    ticket,
    /** Reports off again, so no other test's page carries this banner. */
    quiet: async () => {
      for (const p of [project, due])
        await ok(human.patch(`/api/projects/${p.id}/report-settings`, { data: { cadence: 'off' } }))
    },
  }
}

/** The banner's line for `project`. */
export const reminder = (page: Page, project: Project) =>
  page.getByRole('region', { name: 'Reports due' }).getByRole('link', { name: project.name })

/** The pushed-today pill in the Daily page's header (not the compact one under the project's name). */
export const pushedPill = (page: Page) =>
  page.locator('aside + section').getByRole('button', { name: /^Pushed today/ })

/** Whether the page itself scrolls sideways (a board's own column scroller does not count). */
export const scrollsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)

/**
 * How much what `el` paints stands out from what is behind it, as the WCAG contrast ratio (1 to 21):
 * its text (`color`), its stroke or fill (an SVG mark), its own background (a dot) or its border (a
 * ring), against the backgrounds of it and its ancestors laid over each other, as the browser composes
 * them. An SVG mark drawn on a shape of its SVG (a clock's face) names that shape in `surface`.
 */
export const contrast = (
  el: Locator,
  what: 'color' | 'stroke' | 'fill' | 'backgroundColor' | 'borderTopColor' = 'color',
  surface?: string,
) =>
  el.evaluate(
    (e, [what, surface]) => {
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
      const paint = (colors: string[]) => {
        ctx.clearRect(0, 0, 1, 1)
        for (const c of ['#fff', ...colors]) {
          ctx.fillStyle = c
          ctx.fillRect(0, 0, 1, 1)
        }
        return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3))
      }
      const layers: string[] = []
      for (
        let n = what === 'backgroundColor' || what === 'borderTopColor' ? e.parentElement : e;
        n;
        n = n.parentElement
      )
        layers.unshift(getComputedStyle(n).backgroundColor)
      const under = surface && (e as SVGElement).ownerSVGElement?.querySelector(surface)
      if (under) layers.push(getComputedStyle(under).fill)
      const fg = getComputedStyle(e)[what]
      const luminance = (rgb: number[]) => {
        const [r, g, b] = rgb.map((v) => {
          const c = v / 255
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
        })
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
      }
      const [a, b] = [luminance(paint([...layers, fg])), luminance(paint(layers))]
      return { ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), fg, behind: layers.at(-1) }
    },
    [what, surface] as const,
  )

/** At least `min` contrast, the colours in the message when not. */
export async function standsOut(
  el: Locator,
  min: number,
  what: Parameters<typeof contrast>[1] = 'color',
  surface?: string,
) {
  const c = await contrast(el, what, surface)
  expect(
    c.ratio,
    `${await el.evaluate((e) => e.outerHTML.slice(0, 120))}: ${c.fg} on ${c.behind}`,
  ).toBeGreaterThanOrEqual(min)
}
