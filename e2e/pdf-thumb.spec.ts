import { expect, ok, test } from './fixtures'
import { pdf } from './files'

/**
 * A PDF posted on a ticket shows its first page as a thumbnail, drawn in the browser by pdf.js (loaded
 * with its worker the first time a PDF scrolls into view), with its page count under it.
 */
test('a PDF on a post shows its first page, drawn by pdf.js, and its page count', async ({
  page,
  api,
  human,
}) => {
  const t = await api.ticket({ title: 'The spec as a PDF' })
  const doc = await ok<{ id: number }>(
    human.post('/api/uploads', { data: { name: 'spec.pdf', base64: pdf('Spec').toString('base64') } }),
  )
  await ok(
    human.post(`/api/tickets/${t.id}/updates`, { data: { body: 'The spec.', attachmentIds: [doc.id] } }),
  )
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))

  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  const card = page.getByRole('article').getByRole('link').filter({ hasText: 'spec.pdf' })
  // pdf.js starts once the thumbnail comes near the viewport.
  await card.scrollIntoViewIfNeeded()
  await expect(card).toContainText('1 page')
  // The canvas stays invisible until pdf.js has drawn the page into it.
  const canvas = card.locator('canvas')
  await expect(canvas).toBeVisible()
  const inked = await canvas.evaluate((c: HTMLCanvasElement) => {
    const { data } = c.getContext('2d')!.getImageData(0, 0, c.width, c.height)
    let dark = 0
    for (let i = 0; i < data.length; i += 4) if (data[i]! < 128 && data[i + 3]! > 0) dark++
    return { width: c.width, height: c.height, dark }
  })
  expect(inked.width).toBeGreaterThan(0)
  expect(inked.height).toBeGreaterThan(0)
  // The page's text ("Spec") is dark ink on the white page.
  expect(inked.dark).toBeGreaterThan(0)
  expect(errors).toEqual([])
})
