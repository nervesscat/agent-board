import { describe, expect, it } from 'vitest'

import { tagClass, tagTextClass } from './Tag'

describe('tagTextClass', () => {
  it("keeps a severity tag's text colour, light and dark, in any casing, and drops its tint", () => {
    expect(tagTextClass('high')).toBe('text-red-700 dark:text-red-400')
    expect(tagTextClass('Critical')).toBe('text-red-700 dark:text-red-300')
    expect(tagTextClass('nit')).toBe('text-zinc-600 dark:text-zinc-400')
  })

  it("is the text half of any other tag's chip colour", () => {
    for (const tag of ['UI', 'Bug', 'Module 50', 'a rather long module name']) {
      const text = tagTextClass(tag).split(' ')
      expect(text).toHaveLength(2)
      expect(text[0]).toMatch(/^text-[a-z]+-700$/)
      expect(text[1]).toMatch(/^dark:text-[a-z]+-400$/)
      expect(tagClass(tag).split(' ')).toEqual(expect.arrayContaining(text))
      expect(tagClass(tag)).toMatch(/^bg-/)
      expect(tagTextClass(tag)).not.toMatch(/bg-/)
    }
  })
})
