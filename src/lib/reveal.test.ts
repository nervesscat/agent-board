import { describe, expect, it } from 'vitest'

import { anchorId, parseAnchor } from './reveal'

describe('parseAnchor', () => {
  it('names an element by its id', () => {
    expect(parseAnchor('post-12')).toEqual({ hash: 'post-12', target: 'post-12', holder: null })
    expect(parseAnchor('handoff')).toEqual({ hash: 'handoff', target: 'handoff', holder: null })
    expect(parseAnchor('reply-40')).toEqual({ hash: 'reply-40', target: 'reply-40', holder: null })
  })

  it('names a reply with the element whose thread holds it', () => {
    expect(parseAnchor('post-12-reply-40')).toEqual({
      hash: 'post-12-reply-40',
      target: 'reply-40',
      holder: 'post-12',
    })
    expect(parseAnchor('pr-3-reply-7')).toEqual({ hash: 'pr-3-reply-7', target: 'reply-7', holder: 'pr-3' })
  })

  it('has nothing without a hash, and takes anything else as an id as it is', () => {
    expect(parseAnchor('')).toBeNull()
    expect(parseAnchor('post-x-reply-4')).toEqual({
      hash: 'post-x-reply-4',
      target: 'post-x-reply-4',
      holder: null,
    })
  })
})

describe('anchorId', () => {
  it('reads the number of an id of the kind asked for', () => {
    expect(anchorId('post-12', 'post')).toBe(12)
    expect(anchorId('pr-3', 'pr')).toBe(3)
  })

  it('is null for another kind, a malformed id or none', () => {
    expect(anchorId('pr-3', 'post')).toBeNull()
    expect(anchorId('post-12-reply-4', 'post')).toBeNull()
    expect(anchorId('post-', 'post')).toBeNull()
    expect(anchorId(null, 'post')).toBeNull()
    expect(anchorId(undefined, 'post')).toBeNull()
  })
})
