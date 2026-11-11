import zlib from 'node:zlib'

import { expect, type Page } from '@playwright/test'

/** A real PNG of one color, `size` pixels square: a browser decodes it, so a thumbnail of it is not broken. */
export function png(size = 8, [r, g, b] = [220, 40, 40]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 2, 0, 0, 0], 8) // 8 bits, RGB
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat()),
  ])
  const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', pixels),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** A one-page PDF a browser can open. */
export function pdf(text = 'Report'): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    (() => {
      const s = `BT /F1 18 Tf 20 50 Td (${text}) Tj ET`
      return `<< /Length ${s.length} >>\nstream\n${s}\nendstream`
    })(),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/**
 * Pastes or drops a file on the element `selector` matches, the way a browser does: a paste or a drop
 * event carrying it in a DataTransfer (Playwright has no clipboard or OS drag for files).
 */
export async function sendFile(
  page: Page,
  selector: string,
  how: 'paste' | 'drop',
  file: { name: string; mime: string; data: Buffer },
) {
  await page.locator(selector).evaluate(
    (el, { how, name, mime, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], name, { type: mime }))
      const init = { bubbles: true, cancelable: true }
      if (how === 'paste') {
        el.dispatchEvent(new ClipboardEvent('paste', { ...init, clipboardData: dt }))
        return
      }
      for (const type of ['dragenter', 'dragover', 'drop'])
        el.dispatchEvent(new DragEvent(type, { ...init, dataTransfer: dt }))
    },
    { how, name: file.name, mime: file.mime, base64: file.data.toString('base64') },
  )
}

/** The canvas a picture opens on its way into a form. */
export const canvasOf = (page: Page) => page.getByRole('dialog', { name: 'Annotate image' })

/**
 * Waits for the annotation canvas a picture opens and hands the file over as it was picked, the way a
 * test that only cares about the attach point gets past it. With more pictures queued behind it the
 * canvas stays open on the next one; it closes after the last.
 */
export async function attachOriginal(page: Page) {
  const canvas = canvasOf(page)
  await canvas.waitFor()
  // The picture on the canvas, by the name in its description; '' when it has none (on its way out).
  const name = async () => {
    if (!(await canvas.count())) return null
    const text = await canvas
      .locator('[data-slot="dialog-description"]')
      .innerText()
      .catch(() => '')
    const at = text.indexOf(':')
    return at > 0 ? text.slice(0, at + 1) : ''
  }
  const was = await name()
  // A canvas on its way out shows no name, which is not the next picture: that reads as unchanged
  // until it has left the page, so the next step never runs against a dialog still fading out.
  const shown = async () => {
    const now = await name()
    if (now === null) return null
    return now || was
  }
  await canvas.getByRole('button', { name: 'Attach original', exact: true }).click()
  await expect.poll(shown).not.toBe(was)
}
