import { describe, expect, it, vi } from 'vitest'

import { copyImage } from './clipboardImage'

/** A clipboard that records what was written to it. */
function fakeClipboard() {
  const write = vi.fn(async (_items: ClipboardItem[]) => {})
  return { clipboard: { write }, write }
}

/** A ClipboardItem that keeps the data it was built with, as a browser would hand it to the clipboard. */
function fakeItems() {
  const made: Record<string, Blob>[] = []
  class FakeClipboardItem {
    constructor(data: Record<string, Blob>) {
      made.push(data)
    }
  }
  return { ClipboardItem: FakeClipboardItem as unknown as typeof ClipboardItem, made }
}

const fetched = (blob: Blob, ok = true) =>
  vi.fn(async () => ({ ok, blob: async () => blob }) as Response) as unknown as typeof fetch

const png = (type = 'image/png') => new Blob([new Uint8Array([1, 2, 3])], { type })

describe('copyImage', () => {
  it('fetches the image and writes its bytes to the clipboard', async () => {
    const blob = png()
    const { clipboard, write } = fakeClipboard()
    const { ClipboardItem, made } = fakeItems()
    const fetch = fetched(blob)

    expect(await copyImage('/api/uploads/1/shot.png', 'image/png', { fetch, clipboard, ClipboardItem })).toBe(
      'copied',
    )
    expect(fetch).toHaveBeenCalledWith('/api/uploads/1/shot.png')
    expect(write).toHaveBeenCalledTimes(1)
    expect(made).toEqual([{ 'image/png': blob }])
  })

  it('turns another image into a PNG first, the only type the clipboard takes', async () => {
    const jpeg = png('image/jpeg')
    const converted = png()
    const toPng = vi.fn(async () => converted)
    const { clipboard } = fakeClipboard()
    const { ClipboardItem, made } = fakeItems()

    const result = await copyImage('/shot.jpg', 'image/jpeg', {
      fetch: fetched(jpeg),
      clipboard,
      ClipboardItem,
      toPng,
    })
    expect(result).toBe('copied')
    expect(toPng).toHaveBeenCalledWith(jpeg)
    expect(made).toEqual([{ 'image/png': converted }])
  })

  it('takes the type from the upload when the response gives none', async () => {
    const blob = png('')
    const { clipboard } = fakeClipboard()
    const { ClipboardItem, made } = fakeItems()
    await copyImage('/no-type', 'image/png', { fetch: fetched(blob), clipboard, ClipboardItem })
    expect(made).toEqual([{ 'image/png': blob }])
  })

  it('says so when the browser has no clipboard to write to', async () => {
    const fetch = fetched(png())
    const { ClipboardItem } = fakeItems()
    expect(await copyImage('/shot.png', 'image/png', { fetch, clipboard: null, ClipboardItem })).toBe(
      'unsupported',
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('says so when the browser has no ClipboardItem', async () => {
    const { clipboard } = fakeClipboard()
    expect(
      await copyImage('/shot.png', 'image/png', {
        fetch: fetched(png()),
        clipboard,
        ClipboardItem: null,
      }),
    ).toBe('unsupported')
    expect(clipboard.write).not.toHaveBeenCalled()
  })

  it('says an SVG is not supported rather than writing it', async () => {
    const { clipboard, write } = fakeClipboard()
    const { ClipboardItem } = fakeItems()
    const svg = new Blob(['<svg/>'], { type: 'image/svg+xml' })
    expect(
      await copyImage('/logo.svg', 'image/svg+xml', { fetch: fetched(svg), clipboard, ClipboardItem }),
    ).toBe('unsupported')
    expect(write).not.toHaveBeenCalled()
  })

  it('fails when the image cannot be read', async () => {
    const { clipboard, write } = fakeClipboard()
    const { ClipboardItem } = fakeItems()
    expect(
      await copyImage('/missing.png', 'image/png', {
        fetch: fetched(png(), false),
        clipboard,
        ClipboardItem,
      }),
    ).toBe('failed')
    const rejects = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await copyImage('/missing.png', 'image/png', { fetch: rejects, clipboard, ClipboardItem })).toBe(
      'failed',
    )
    expect(write).not.toHaveBeenCalled()
  })

  it('fails when the browser refuses the write', async () => {
    const { clipboard } = fakeClipboard()
    clipboard.write.mockRejectedValueOnce(new Error('NotAllowedError'))
    const { ClipboardItem } = fakeItems()
    expect(
      await copyImage('/shot.png', 'image/png', { fetch: fetched(png()), clipboard, ClipboardItem }),
    ).toBe('failed')
  })

  it('says a file that is not an image is not supported', async () => {
    const { clipboard, write } = fakeClipboard()
    const { ClipboardItem } = fakeItems()
    const text = new Blob(['hello'], { type: 'text/plain' })
    expect(
      await copyImage('/notes.txt', 'text/plain', { fetch: fetched(text), clipboard, ClipboardItem }),
    ).toBe('unsupported')
    expect(write).not.toHaveBeenCalled()
  })
})
