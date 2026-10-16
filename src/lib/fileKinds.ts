/**
 * What kind of file an upload is, from its type and its name: how the lightbox shows it
 * (`viewKind`), and which of the project gallery's filters it falls under (`fileKind`). The server
 * filters the gallery with the same rules in SQL (src/server/gallery.ts), so both agree.
 */

// Text is fetched and shown in the lightbox's own panel: in an iframe, a dark-mode browser draws plain
// text light on a transparent page, which vanishes against a white frame.
export const TEXT_MIMES = [
  'text/',
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
]
// Browsers give some text files no type at all (.md, .log), so the name decides for those.
export const TEXT_EXTENSIONS = [
  'txt',
  'md',
  'markdown',
  'log',
  'json',
  'jsonl',
  'csv',
  'tsv',
  'yml',
  'yaml',
  'xml',
  'toml',
  'ini',
  'env',
  'diff',
  'patch',
  'sh',
  'sql',
  ...['', 'c', 'm'].flatMap((p) => ['js', 'jsx', 'ts', 'tsx'].map((e) => `${p}${e}`)),
  'py',
  'go',
  'rs',
  'java',
  'css',
  'htm',
  'html',
]
// Office and other documents: no preview in the lightbox, but filed with the text in the gallery.
export const DOCUMENT_MIMES = [
  'application/msword',
  'application/rtf',
  'application/vnd.ms-',
  'application/vnd.openxmlformats-officedocument.',
  'application/vnd.oasis.opendocument.',
]
export const DOCUMENT_EXTENSIONS = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf']

/** The gallery's filters, in the order they are offered. */
export const FILE_KINDS = ['image', 'video', 'pdf', 'docs', 'other'] as const
export type FileKind = (typeof FILE_KINDS)[number]

export const FILE_KIND_LABEL: Record<FileKind, string> = {
  image: 'Images',
  video: 'Videos',
  pdf: 'PDFs',
  docs: 'Documents and text',
  other: 'Other',
}

export interface FileLike {
  mime: string
  name: string
}

const extension = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

const isText = ({ mime, name }: FileLike) =>
  TEXT_MIMES.some((p) => mime.startsWith(p)) || TEXT_EXTENSIONS.includes(extension(name))

/** How the lightbox shows a file: `file` is a Download panel. */
export function viewKind(f: FileLike): 'image' | 'video' | 'pdf' | 'text' | 'file' {
  if (f.mime.startsWith('image/')) return 'image'
  if (f.mime.startsWith('video/')) return 'video'
  if (f.mime === 'application/pdf') return 'pdf'
  if (isText(f)) return 'text'
  return 'file'
}

/** Which of the gallery's filters a file falls under. */
export function fileKind(f: FileLike): FileKind {
  const view = viewKind(f)
  if (view === 'text') return 'docs'
  if (view !== 'file') return view
  if (DOCUMENT_MIMES.some((p) => f.mime.startsWith(p)) || DOCUMENT_EXTENSIONS.includes(extension(f.name)))
    return 'docs'
  return 'other'
}

/** The kinds named in a comma-separated list (`image,pdf`), unknown names left out. */
export function parseKinds(value: unknown): FileKind[] {
  if (typeof value !== 'string') return []
  const named = new Set(value.split(','))
  return FILE_KINDS.filter((k) => named.has(k))
}
