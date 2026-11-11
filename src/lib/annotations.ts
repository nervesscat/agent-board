import { z } from 'zod'

/**
 * What the annotation canvas drew on a picture, stored beside the flattened PNG it uploaded: the
 * attachment's own file is the picture as it reads, this document is what it means. Every coordinate
 * is in the image's own pixels, so the notes line up whatever size the board shows the picture at.
 */
export const ANNOTATION_KINDS = ['pen', 'line', 'arrow', 'rect', 'ellipse', 'text'] as const

export type AnnotationKind = (typeof ANNOTATION_KINDS)[number]

export interface Annotation {
  id: string
  kind: AnnotationKind
  /** The stroke and the text: any CSS colour. */
  color: string
  /** The stroke width, in image pixels; text draws at four times it. */
  width: number
  /** A freehand stroke, in the order it was drawn. */
  points?: [number, number][]
  /** A line or an arrow: where it starts and where it points. */
  from?: [number, number]
  to?: [number, number]
  /** A box or an ellipse, as its bounding box. */
  rect?: { x: number; y: number; w: number; h: number }
  text?: string
  /** What the human wrote about this shape, shown numbered next to it. */
  note?: string
}

export interface AnnotationDoc {
  version: 1
  width: number
  height: number
  /** In draw order: the numbering of the notes follows it. */
  items: Annotation[]
}

const point = z.tuple([z.number(), z.number()])
const rect = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })

/**
 * The document `POST /api/uploads` takes in its `annotations` field: what the canvas wrote, and
 * nothing else. Bounds are generous but finite, so a broken client cannot fill the database.
 */
export const annotationDocSchema = z.object({
  version: z.literal(1),
  width: z.number().int().positive().max(50_000),
  height: z.number().int().positive().max(50_000),
  items: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        kind: z.enum(ANNOTATION_KINDS),
        color: z.string().min(1).max(32),
        width: z.number().positive().max(200),
        points: z.array(point).max(20_000).optional(),
        from: point.optional(),
        to: point.optional(),
        rect: rect.optional(),
        text: z.string().max(2_000).optional(),
        note: z.string().max(2_000).optional(),
      }),
    )
    .max(2_000),
})

/**
 * The notes an attachment carries, in the order the picture numbers them: one per shape that has
 * one, blank notes left out. The board lists them under the picture, and so does `get_attachment`.
 */
export function annotationNotes(doc: AnnotationDoc | null | undefined): string[] {
  return (doc?.items ?? []).flatMap((item) => {
    const note = item.note?.trim()
    return note ? [note] : []
  })
}

/**
 * The files the canvas takes: pictures the browser decodes. SVG is left out, the canvas cannot draw
 * it reliably; video, PDF and text are attached as they are.
 */
export function annotatable(file: File) {
  return file.type.startsWith('image/') && file.type !== 'image/svg+xml'
}

/** What was drawn on a file the canvas flattened, kept until the file is uploaded with it. */
const documents = new WeakMap<File, AnnotationDoc>()

export function keepAnnotations(file: File, doc: AnnotationDoc) {
  documents.set(file, doc)
}

export function annotationsOf(file: File): AnnotationDoc | undefined {
  return documents.get(file)
}
