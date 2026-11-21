import { describe, expect, it } from 'vitest'

import {
  checkComponents,
  checkLocales,
  compareLocales,
  findHardcoded,
  flatten,
  readLocales,
} from './i18n-check.mjs'

describe('every language has every text', () => {
  const en = { a: 'A', b: { c: 'Hello {{name}}', d_one: '{{count}} item', d_other: '{{count}} items' } }

  it('flattens the nested file into dotted keys', () => {
    expect(Object.keys(flatten(en))).toEqual(['a', 'b.c', 'b.d_one', 'b.d_other'])
  })

  it('accepts a language that has the same keys', () => {
    const es = { a: 'A', b: { c: 'Hola {{name}}', d_one: '{{count}} cosa', d_other: '{{count}} cosas' } }
    expect(compareLocales(en, es, 'es')).toEqual([])
  })

  it('names a key a language is missing, one it has too many of, and an empty text', () => {
    const es = { b: { c: '', d_one: '{{count}} cosa', d_other: '{{count}} cosas' }, z: 'Z' }
    expect(compareLocales(en, es, 'es')).toEqual([
      'es: missing key a',
      'es: key z is not in the English file',
      'es: b.c is empty',
    ])
  })

  it('catches a placeholder or a tag that does not match, and a plural with no _other', () => {
    const es = { a: 'A <b>x</b>', b: { c: 'Hola {{nombre}}', d_one: '{{count}} cosa' } }
    expect(compareLocales(en, es, 'es')).toEqual([
      'es: b.d has no _other form',
      'es: a uses other <tags> than the English text',
      'es: b.c uses other {{placeholders}} than the English text',
    ])
  })

  it("passes on the app's own translation files", () => {
    expect(Object.keys(readLocales()).sort()).toEqual(['en', 'es'])
    expect(checkLocales()).toEqual([])
  })
})

describe('no English left in a component', () => {
  const found = (source) => findHardcoded(source).map((f) => f.text)

  it('finds text between tags, text attributes, and a toast message', () => {
    expect(found(`const a = <p title="Close it">Hello there</p>`)).toEqual(['Close it', 'Hello there'])
    expect(found(`const a = <input placeholder="Search…" aria-label={'Find'} />`)).toEqual([
      'Search…',
      'Find',
    ])
    expect(found(`toast.error('Could not save')`)).toEqual(['Could not save'])
    expect(found('const a = <p>{`Saved ${n} items`}</p>')).toEqual(['Saved items'])
  })

  it('leaves translated text, code, symbols, brand names and marked lines alone', () => {
    expect(found(`const a = <p title={t('x.y')}>{t('x.z')}</p>`)).toEqual([])
    expect(found(`const a = <p className="flex gap-2">·</p>`)).toEqual([])
    expect(found(`const a = <meta content="#0a0a0a" /> `)).toEqual([])
    expect(found(`const a = <span>CrossBoard</span>`)).toEqual([])
    expect(found(`toast.success(t('common.saved'))`)).toEqual([])
    expect(found(`// i18n-ignore: a file name\nconst a = <code>package.json</code>`)).toEqual([])
    expect(found(`const a = <code>{name}</code>`)).toEqual([])
  })

  it('passes on the app: only the pending files hold English, and none is listed that is clean', () => {
    expect(checkComponents()).toEqual([])
  })
})
