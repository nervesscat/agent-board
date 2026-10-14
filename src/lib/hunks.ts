/** A line diff of two texts, as git shows it: hunks of changed lines with a few unchanged ones around. */

/** One line of a hunk: unchanged, removed from the old text, or added in the new one. */
export interface DiffLine {
  kind: 'context' | 'del' | 'add'
  text: string
  /** 1-based, in the old text: context and removed lines. */
  oldNo?: number
  /** 1-based, in the new text: context and added lines. */
  newNo?: number
  /** The text ends on this line with no newline after it (git's "\ No newline at end of file"). */
  noNewline?: boolean
}

export interface DiffHunk {
  /** `@@ -oldStart,oldLines +newStart,newLines @@`, a count of 1 left out as git does. */
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

type Line = { text: string; noNewline: boolean }
type Op = '=' | '-' | '+'

/** The lines of `text`; a last line without a newline after it is marked, so adding one is a change. */
export function splitLines(text: string): Line[] {
  if (!text) return []
  const parts = text.split('\n')
  const lines = parts.map((t) => ({ text: t, noNewline: false }))
  if (parts.at(-1) === '') lines.pop()
  else lines.at(-1)!.noNewline = true
  return lines
}

/**
 * Past this many removed and added lines, the part between the common start and end is shown as all
 * removed then all added: still a true diff, at a bounded cost for a file replaced by another.
 */
const MAX_EDITS = 1000

/** The shortest edit script from `a` to `b` (Myers), or null when it takes more than `limit` edits. */
function myers(a: string[], b: string[], limit: number): Op[] | null {
  const n = a.length
  const m = b.length
  const max = Math.min(n + m, limit)
  const off = max + 1
  const v = new Int32Array(2 * off + 1)
  // trace[d]: the furthest x on each diagonal k in [-d, d] before step d, at trace[d][k + d].
  const trace: Int32Array[] = []
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d, off + d + 1))
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= n && y >= m) return backtrack(trace, n, m)
    }
  }
  return null
}

function backtrack(trace: Int32Array[], n: number, m: number): Op[] {
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d > 0; d--) {
    const at = (k: number) => trace[d]![k + d]!
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push('=')
      x--
      y--
    }
    if (prevK === k + 1) {
      ops.push('+')
      y--
    } else {
      ops.push('-')
      x--
    }
  }
  while (x > 0 && y > 0) {
    ops.push('=')
    x--
    y--
  }
  return ops.reverse()
}

/** The edit script from `a` to `b`: the common start and end kept, the rest by Myers. */
function editScript(a: string[], b: string[]): Op[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end])
    end++
  const midA = a.slice(start, a.length - end)
  const midB = b.slice(start, b.length - end)
  const mid = myers(midA, midB, MAX_EDITS) ?? [...midA.map((): Op => '-'), ...midB.map((): Op => '+')]
  return [...Array<Op>(start).fill('='), ...mid, ...Array<Op>(end).fill('=')]
}

const range = (start: number, count: number) => (count === 1 ? `${start}` : `${start},${count}`)

/**
 * The hunks that turn `oldText` into `newText`, line by line, with `context` unchanged lines around each
 * change and changes that close merged into one hunk, as `git diff` shows them. No hunks: the same text.
 */
export function diffLines(oldText: string, newText: string, context = 3): DiffHunk[] {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  const key = (l: Line) => (l.noNewline ? '\\' : ' ') + l.text
  const ops = editScript(a.map(key), b.map(key))

  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  for (const op of ops) {
    if (op === '=') {
      lines.push({ kind: 'context', text: b[j]!.text, oldNo: i + 1, newNo: j + 1 })
      if (b[j]!.noNewline) lines.at(-1)!.noNewline = true
      i++
      j++
    } else if (op === '-') {
      lines.push({ kind: 'del', text: a[i]!.text, oldNo: i + 1, ...(a[i]!.noNewline && { noNewline: true }) })
      i++
    } else {
      lines.push({ kind: 'add', text: b[j]!.text, newNo: j + 1, ...(b[j]!.noNewline && { noNewline: true }) })
      j++
    }
  }

  const changed = lines.flatMap((l, at) => (l.kind === 'context' ? [] : [at]))
  const hunks: DiffHunk[] = []
  let g = 0
  while (g < changed.length) {
    // Changes with at most 2 * context unchanged lines between them share a hunk.
    let last = g
    while (last + 1 < changed.length && changed[last + 1]! - changed[last]! <= 2 * context + 1) last++
    const from = Math.max(0, changed[g]! - context)
    const to = Math.min(lines.length, changed[last]! + context + 1)
    const slice = lines.slice(from, to)
    const oldBefore = lines.slice(0, from).filter((l) => l.kind !== 'add').length
    const newBefore = lines.slice(0, from).filter((l) => l.kind !== 'del').length
    const oldLines = slice.filter((l) => l.kind !== 'add').length
    const newLines = slice.filter((l) => l.kind !== 'del').length
    const oldStart = oldLines ? oldBefore + 1 : oldBefore
    const newStart = newLines ? newBefore + 1 : newBefore
    hunks.push({
      header: `@@ -${range(oldStart, oldLines)} +${range(newStart, newLines)} @@`,
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines: slice,
    })
    g = last + 1
  }
  return hunks
}
