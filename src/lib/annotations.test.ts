import { describe, expect, it } from 'vitest'

import { annotationDocSchema } from './annotations'

const doc = (item: Record<string, unknown>) => ({
  version: 1,
  width: 300,
  height: 200,
  items: [{ id: 'm1', kind: 'rect', color: '#e11d48', width: 4, rect: { x: 1, y: 2, w: 3, h: 4 }, ...item }],
})

describe('annotationDocSchema', () => {
  it('keeps the rotation of a mark, as radians', () => {
    const parsed = annotationDocSchema.parse(doc({ rotation: 0.75, note: 'turned' }))
    expect(parsed.items[0]).toMatchObject({ rotation: 0.75, note: 'turned' })
  })

  it('keeps a negative rotation, and zero', () => {
    expect(annotationDocSchema.parse(doc({ rotation: -2.5 })).items[0]!.rotation).toBe(-2.5)
    expect(annotationDocSchema.parse(doc({ rotation: 0 })).items[0]!.rotation).toBe(0)
  })

  it('parses a document written before rotation existed unchanged, with no rotation key', () => {
    const old = doc({ note: 'plain' })
    const parsed = annotationDocSchema.parse(old)
    expect(parsed).toEqual(old)
    expect('rotation' in parsed.items[0]!).toBe(false)
  })

  it('rejects a rotation that is not a finite number', () => {
    for (const rotation of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '0.5', null]) {
      expect(annotationDocSchema.safeParse(doc({ rotation })).success, String(rotation)).toBe(false)
    }
  })

  it('keeps the version at 1', () => {
    expect(annotationDocSchema.safeParse({ ...doc({}), version: 2 }).success).toBe(false)
  })
})
