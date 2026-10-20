import { describe, expect, it } from 'vitest'

import {
  addTags,
  cleanSuggestions,
  MAX_TAG_LENGTH,
  MAX_TAGS,
  normalizeTag,
  overTagLimits,
  tagChoices,
  tagTooLong,
  usedTags,
} from './tags'

describe('addTags', () => {
  it('adds each comma-separated part, trimmed, in order', () => {
    expect(addTags([], 'High, Forms')).toEqual(['High', 'Forms'])
    expect(addTags(['UI'], ' High ,Forms ')).toEqual(['UI', 'High', 'Forms'])
  })

  it('leaves out empty parts', () => {
    expect(addTags([], '')).toEqual([])
    expect(addTags([], ', ,')).toEqual([])
    expect(addTags(['High'], 'Forms,')).toEqual(['High', 'Forms'])
  })

  it('leaves out a tag already there in any casing, keeping the first casing', () => {
    expect(addTags(['High'], 'high')).toEqual(['High'])
    expect(addTags([], 'Forms, FORMS, forms')).toEqual(['Forms'])
    expect(addTags(['Login form'], 'login   FORM')).toEqual(['Login form'])
  })

  it('does not change the tags it is given', () => {
    const tags = ['High']
    addTags(tags, 'Forms')
    expect(tags).toEqual(['High'])
  })
})

describe('normalizeTag', () => {
  it('collapses whitespace and trims, as the server does', () => {
    expect(normalizeTag('  Login \t form\n')).toBe('Login form')
  })
})

describe('overTagLimits', () => {
  // Twenty tags, High among them.
  const twenty = ['High', ...Array.from({ length: 19 }, (_, i) => `t${i + 1}`)]
  const within = { tooMany: false, tooLong: false }

  it("takes the server's limits: 20 tags of at most 40 characters", () => {
    expect([MAX_TAGS, MAX_TAG_LENGTH]).toEqual([20, 40])
    expect(overTagLimits([])).toEqual(within)
    expect(overTagLimits(twenty)).toEqual(within)
    expect(overTagLimits(['x'.repeat(40)])).toEqual(within)
  })

  it('finds more than 20 tags, chips or typed', () => {
    expect(overTagLimits([...twenty, 't20'])).toEqual({ tooMany: true, tooLong: false })
    expect(overTagLimits(twenty, 'Forms')).toEqual({ tooMany: true, tooLong: false })
    expect(overTagLimits(twenty.slice(0, 19), 'Forms, UI')).toEqual({ tooMany: true, tooLong: false })
  })

  it('finds a tag longer than 40 characters, a chip or typed', () => {
    expect(overTagLimits(['High', 'x'.repeat(41)])).toEqual({ tooMany: false, tooLong: true })
    expect(overTagLimits(['High'], 'x'.repeat(41))).toEqual({ tooMany: false, tooLong: true })
    expect(overTagLimits([...twenty, 'x'.repeat(41)])).toEqual({ tooMany: true, tooLong: true })
  })

  it('counts what would be sent: a repeat in any casing is not one more', () => {
    expect(overTagLimits(twenty, 'HIGH')).toEqual(within)
    expect(overTagLimits(twenty, 'high, T1 ,')).toEqual(within)
  })

  it('measures a tag once its whitespace is normalized', () => {
    expect(overTagLimits([], 'x'.repeat(40) + '   ')).toEqual(within)
    expect(overTagLimits([], 'a  ' + 'x'.repeat(38))).toEqual(within)
    expect(overTagLimits([], '  a \t ' + 'x'.repeat(39))).toEqual({ tooMany: false, tooLong: true })
  })

  it('does not count the text that makes no tag', () => {
    expect(overTagLimits(twenty, ', ,')).toEqual(within)
    expect(overTagLimits(twenty, '   ')).toEqual(within)
  })
})

describe('tagTooLong', () => {
  it('is over 40 characters, by length', () => {
    expect(tagTooLong('x'.repeat(40))).toBe(false)
    expect(tagTooLong('x'.repeat(41))).toBe(true)
  })
})

describe('usedTags', () => {
  it('lists each tag once, most used first, in the casing used most', () => {
    expect(usedTags([['Forms', 'ui'], ['UI', 'Login'], ['UI'], ['forms']])).toEqual(['UI', 'Forms', 'Login'])
  })

  it('keeps the first casing seen on a tie, and the first tag seen on an equal count', () => {
    expect(usedTags([['api'], ['API'], ['Docs']])).toEqual(['api', 'Docs'])
    expect(usedTags([])).toEqual([])
  })
})

describe('tagChoices', () => {
  it('offers the suggestions, then the used tags, each once in any casing', () => {
    expect(tagChoices(['Bug', 'UI'], ['Forms', 'bug'], [])).toEqual(['bug', 'UI', 'Forms'])
  })

  it('offers a suggestion in the casing the tickets already use', () => {
    expect(tagChoices(['UI'], ['ui'], [])).toEqual(['ui'])
  })

  it('leaves out the tags already added, in any casing', () => {
    expect(tagChoices(['Bug', 'UI'], ['Forms'], ['ui', 'FORMS'])).toEqual(['Bug'])
  })
})

describe('cleanSuggestions', () => {
  it('trims, joins whitespace runs, and drops blanks and repeats in any casing', () => {
    expect(cleanSuggestions([' Bug ', 'login   form', '', ' ', 'BUG', 'UI'])).toEqual([
      'Bug',
      'login form',
      'UI',
    ])
  })

  it('keeps an empty list empty', () => {
    expect(cleanSuggestions([])).toEqual([])
  })
})
