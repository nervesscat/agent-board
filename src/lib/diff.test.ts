import { describe, expect, it } from 'vitest'

import { lineDiff } from './diff'

const show = (a: string, b: string) =>
  lineDiff(a, b).map((l) => `${{ same: ' ', add: '+', del: '-' }[l.op]}${l.text}`)

describe('lineDiff', () => {
  it('keeps the lines both share and marks the ones removed and added', () => {
    expect(show('## Done\n## In progress\n## Next', '## Done\n## Doing\n## Next\n## Notes')).toEqual([
      ' ## Done',
      '-## In progress',
      '+## Doing',
      ' ## Next',
      '+## Notes',
    ])
  })

  it('aligns a moved block on what it keeps', () => {
    expect(show('a\nb\nc\nd', 'a\nc\nd\nb')).toEqual([' a', '-b', ' c', ' d', '+b'])
  })

  it('is all added from nothing, all removed to nothing, all kept when equal', () => {
    expect(show('', 'one\ntwo')).toEqual(['+one', '+two'])
    expect(show('one\ntwo', '')).toEqual(['-one', '-two'])
    expect(show('one\r\ntwo', 'one\ntwo')).toEqual([' one', ' two'])
  })

  it('stays quick on long texts', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n')
    const b = a.replace('line 1500', 'changed')
    const diff = lineDiff(a, b)
    expect(diff.filter((l) => l.op !== 'same')).toEqual([
      { op: 'del', text: 'line 1500' },
      { op: 'add', text: 'changed' },
    ])
  })
})
