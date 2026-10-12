import { describe, expect, it } from 'vitest'

import { type DiffHunk, diffLines, splitLines } from './hunks'

/** A hunk as `git diff` prints it, one string per line. */
const print = (hunks: DiffHunk[]) =>
  hunks.flatMap((h) => [
    h.header,
    ...h.lines.flatMap((l) => [
      `${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${l.text}`,
      ...(l.noNewline ? ['\\ No newline at end of file'] : []),
    ]),
  ])

const numbered = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `line ${from + i}\n`).join('')

describe('a line diff', () => {
  it('has no hunks for the same text', () => {
    expect(diffLines('', '')).toEqual([])
    expect(diffLines('a\nb\n', 'a\nb\n')).toEqual([])
  })

  it('removes a last line, with the lines before it as context', () => {
    const [hunk, ...rest] = diffLines('a\nb\nc\nX\n', 'a\nb\nc\n')
    expect(rest).toEqual([])
    expect(hunk).toMatchObject({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 3 })
    expect(print([hunk!])).toEqual(['@@ -1,4 +1,3 @@', ' a', ' b', ' c', '-X'])
    expect(hunk!.lines.at(-1)).toEqual({ kind: 'del', text: 'X', oldNo: 4 })
    expect(hunk!.lines[0]).toEqual({ kind: 'context', text: 'a', oldNo: 1, newNo: 1 })
  })

  it('keeps three lines of context and collapses the unchanged run between distant changes', () => {
    const old = numbered(30)
    const changed = old.replace('line 5\n', 'line five\n').replace('line 25\n', 'line twenty-five\n')
    expect(print(diffLines(old, changed))).toEqual([
      '@@ -2,7 +2,7 @@',
      ' line 2',
      ' line 3',
      ' line 4',
      '-line 5',
      '+line five',
      ' line 6',
      ' line 7',
      ' line 8',
      '@@ -22,7 +22,7 @@',
      ' line 22',
      ' line 23',
      ' line 24',
      '-line 25',
      '+line twenty-five',
      ' line 26',
      ' line 27',
      ' line 28',
    ])
  })

  it('joins changes close enough that their context would meet', () => {
    const old = numbered(20)
    const changed = old.replace('line 5\n', 'x\n').replace('line 12\n', 'y\n')
    const hunks = diffLines(old, changed)
    expect(hunks.map((h) => h.header)).toEqual(['@@ -2,14 +2,14 @@'])
    expect(diffLines(old, old.replace('line 5\n', 'x\n').replace('line 13\n', 'y\n'))).toHaveLength(2)
  })

  it('shows a new file as all added, after git: -0,0', () => {
    const hunks = diffLines('', 'one\ntwo\nthree\n')
    expect(print(hunks)).toEqual(['@@ -0,0 +1,3 @@', '+one', '+two', '+three'])
    expect(hunks[0]!.lines.map((l) => l.newNo)).toEqual([1, 2, 3])
  })

  it('leaves out a count of one, as git does', () => {
    expect(diffLines('a\n', 'b\n').map((h) => h.header)).toEqual(['@@ -1 +1 @@'])
  })

  it('counts a missing newline at the end as a change', () => {
    const hunks = diffLines('a\nb\nc', 'a\nb\nc\n')
    expect(print(hunks)).toEqual(['@@ -1,3 +1,3 @@', ' a', ' b', '-c', '\\ No newline at end of file', '+c'])
    expect(print(diffLines('a\n', 'a'))).toEqual(['@@ -1 +1 @@', '-a', '+a', '\\ No newline at end of file'])
  })

  it('finds the shortest change, not a whole-file replacement', () => {
    const old = 'a\nb\nc\nd\ne\nf\ng\n'
    const changed = 'a\nB\nc\nd\nE\nf\ng\nh\n'
    const lines = diffLines(old, changed, 100).flatMap((h) => h.lines)
    expect(lines.filter((l) => l.kind === 'del').map((l) => l.text)).toEqual(['b', 'e'])
    expect(lines.filter((l) => l.kind === 'add').map((l) => l.text)).toEqual(['B', 'E', 'h'])
    expect(lines.filter((l) => l.kind === 'context').map((l) => l.text)).toEqual(['a', 'c', 'd', 'f', 'g'])
  })

  it('rebuilds both texts from its lines, also for a file replaced by a long, different one', () => {
    const cases: [string, string][] = [
      ['x\ny\nz\n', 'y\nz\nx\n'],
      ['a\nb\na\nb\n', 'b\na\nb\na'],
      [numbered(50), numbered(3000, 7)],
      [numbered(1500).replace(/line (\d+)/g, 'old $1'), numbered(1500)],
    ]
    for (const [a, b] of cases) {
      const lines = diffLines(a, b, Infinity).flatMap((h) => h.lines)
      const side = (kind: 'del' | 'add') =>
        lines
          .filter((l) => l.kind !== kind)
          .map((l) => l.text + (l.noNewline ? '' : '\n'))
          .join('')
      expect(side('add')).toBe(a)
      expect(side('del')).toBe(b)
    }
  })

  it('splits lines with the last one marked when it has no newline', () => {
    expect(splitLines('')).toEqual([])
    expect(splitLines('a\n')).toEqual([{ text: 'a', noNewline: false }])
    expect(splitLines('a\nb')).toEqual([
      { text: 'a', noNewline: false },
      { text: 'b', noNewline: true },
    ])
    expect(splitLines('\n')).toEqual([{ text: '', noNewline: false }])
  })
})
