/**
 * Copies an image to the clipboard, from the bytes at its URL. Browsers take images on the clipboard
 * only as PNG (Chromium refuses the others), so anything else is redrawn on a canvas first. Where the
 * Clipboard API is missing the call says so, so the caller can tell the human why nothing happened.
 */

/** How an image copy ended: on the clipboard, a browser without the API, or a failed attempt. */
export type ImageCopyResult = 'copied' | 'unsupported' | 'failed'

export interface ImageCopyOptions {
  /** Reads the image; the global `fetch` by default. */
  fetch?: typeof fetch
  /** Where the image goes; `navigator.clipboard` by default, `null` when there is none. */
  clipboard?: Pick<Clipboard, 'write'> | null
  /** The `ClipboardItem` class the browser provides; the global one by default. */
  ClipboardItem?: typeof ClipboardItem | null
  /** Turns another image into a PNG; a canvas by default. */
  toPng?: (blob: Blob) => Promise<Blob>
}

export async function copyImage(
  src: string,
  mime = '',
  options: ImageCopyOptions = {},
): Promise<ImageCopyResult> {
  const clipboard = 'clipboard' in options ? options.clipboard : browserClipboard()
  const Item = 'ClipboardItem' in options ? options.ClipboardItem : browserClipboardItem()
  if (!clipboard?.write || !Item) return 'unsupported'

  const get = options.fetch ?? globalThis.fetch
  let blob: Blob
  try {
    const res = await get(src)
    if (!res.ok) return 'failed'
    blob = await res.blob()
  } catch {
    return 'failed'
  }

  const type = imageType(blob.type, mime)
  // SVG is an image the clipboard cannot hold either: the canvas API cannot turn it into pixels either.
  if (!type || type === 'image/svg+xml') return 'unsupported'

  try {
    const copy = type === 'image/png' ? blob : await (options.toPng ?? pngFrom)(blob)
    await clipboard.write([new Item({ [copy.type || type]: copy })])
    return 'copied'
  } catch {
    return 'failed'
  }
}

/** The image's type, from the bytes or else from the name it was uploaded under; none for other files. */
function imageType(actual: string, given: string): string {
  for (const type of [actual, given]) {
    const lower = type.toLowerCase()
    if (lower.startsWith('image/')) return lower
  }
  return ''
}

function browserClipboard(): Pick<Clipboard, 'write'> | null {
  return typeof navigator === 'undefined' ? null : (navigator.clipboard ?? null)
}

function browserClipboardItem(): typeof ClipboardItem | null {
  return typeof ClipboardItem === 'undefined' ? null : ClipboardItem
}

/** The image redrawn as a PNG, the one image type the clipboard takes. */
async function pngFrom(blob: Blob): Promise<Blob> {
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return blob
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) return blob
    context.drawImage(bitmap, 0, 0)
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('no image'))), 'image/png'),
    )
  } finally {
    bitmap.close()
  }
}
