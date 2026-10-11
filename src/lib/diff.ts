// A line diff of two texts, for showing what a change of the report prompt or template did.

export interface DiffLine {
  op: 'same' | 'add' | 'del'
  text: string
}

/** Past this many line pairs, the changed middle is shown as removed then added, not aligned. */
const MAX_CELLS = 4_000_000

/**
 * The lines of `b` against those of `a`, in order: the lines both keep (`same`), and the ones `a` had
 * and `b` lost (`del`) or `b` gained (`add`), with as many lines kept as possible.
 */
export function lineDiff(a: string, b: string): DiffLine[] {
  const lines = (s: string) => (s ? s.split(/\r?\n/) : [])
  const x = lines(a)
  const y = lines(b)

  // What both start and end with is kept as it is; only the middle is aligned.
  let start = 0
  while (start < x.length && start < y.length && x[start] === y[start]) start++
  let end = 0
  while (end < x.length - start && end < y.length - start && x[x.length - 1 - end] === y[y.length - 1 - end])
    end++
  const xs = x.slice(start, x.length - end)
  const ys = y.slice(start, y.length - end)
  const same = (text: string) => ({ op: 'same' as const, text })

  return [...x.slice(0, start).map(same), ...middle(xs, ys), ...x.slice(x.length - end).map(same)]
}

/** The longest common subsequence of two lists of lines, walked into a diff. */
function middle(x: string[], y: string[]): DiffLine[] {
  const del = (text: string) => ({ op: 'del' as const, text })
  const add = (text: string) => ({ op: 'add' as const, text })
  if (!x.length || !y.length || x.length * y.length > MAX_CELLS) return [...x.map(del), ...y.map(add)]

  // lcs[i][j]: how many lines x[i..] and y[j..] have in common, in order.
  const w = y.length + 1
  const lcs = new Uint32Array((x.length + 1) * w)
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      lcs[i * w + j] =
        x[i] === y[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!)

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      out.push({ op: 'same', text: x[i]! })
      i++
      j++
    } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) out.push(del(x[i++]!))
    else out.push(add(y[j++]!))
  }
  return [...out, ...x.slice(i).map(del), ...y.slice(j).map(add)]
}
