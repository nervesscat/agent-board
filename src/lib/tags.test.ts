import { describe, expect, it } from 'vitest'

import { addTags, normalizeTag } from './tags'

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
