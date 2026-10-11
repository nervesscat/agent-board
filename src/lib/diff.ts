// A line diff of two texts, for showing what a change of the report prompt or template did.

export interface DiffLine {
  op: 'same' | 'add' | 'del'
  text: string
}

/** The lines of `b` against those of `a`: every line of `a` removed, then every line of `b` added. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const lines = (s: string) => (s ? s.split(/\r?\n/) : [])
  return [
    ...lines(a).map((text) => ({ op: 'del' as const, text })),
    ...lines(b).map((text) => ({ op: 'add' as const, text })),
  ]
}
