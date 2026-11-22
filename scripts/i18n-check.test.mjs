import { describe, expect, it } from 'vitest'

import {
  checkComponents,
  checkDesktopStrings,
  checkLocales,
  compareLocales,
  findHardcoded,
  flatten,
  pluralForms,
  readLocales,
} from './i18n-check.mjs'
import { LANGUAGES } from '../src/i18n/languages'

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
      'es: b.d has no _other form, which es needs',
      'es: a uses other <tags> than the English text',
      'es: b.c uses other {{placeholders}} than the English text',
    ])
  })

  it('refuses a tag that is an HTML void element, whose text the parser would drop', () => {
    const model = { a: 'Open <link>Connect</link>.' }
    expect(compareLocales(model, { a: 'Abre <link>Conectar</link>.' }, 'es')).toEqual([
      'en: a uses <link>, an HTML void element that loses its text: pick another tag name',
      'es: a uses <link>, an HTML void element that loses its text: pick another tag name',
    ])
    expect(
      compareLocales({ a: 'Open <goto>Connect</goto>.' }, { a: 'Abre <goto>Conectar</goto>.' }, 'es'),
    ).toEqual([])
  })

  it('asks each language for the plural forms it writes', () => {
    const enPlural = { n_one: '{{count}} item', n_other: '{{count}} items' }
    expect(pluralForms('en').required).toEqual(new Set(['one', 'other']))
    expect(pluralForms('ja').required).toEqual(new Set(['other']))
    expect(pluralForms('ru').required).toEqual(new Set(['one', 'few', 'many', 'other']))
    expect(pluralForms('pl').required).toEqual(new Set(['one', 'few', 'many', 'other']))
    expect(pluralForms('uk').required).toEqual(new Set(['one', 'few', 'many', 'other']))
    expect(pluralForms('fr').allowed.has('many')).toBe(true)
    const ru = {
      n_one: '{{count}} штука',
      n_few: '{{count}} штуки',
      n_many: '{{count}} штук',
      n_other: '{{count}} штуки',
    }
    expect(compareLocales(enPlural, ru, 'ru')).toEqual([])
    // Russian with only one and other: few and many are missing.
    expect(compareLocales(enPlural, { n_one: '{{count}} штука', n_other: '{{count}} штук' }, 'ru')).toEqual([
      'ru: n has no _few form, which ru needs',
      'ru: n has no _many form, which ru needs',
    ])
    // Japanese has one form: `_other`; a `_one` is a form it does not have.
    expect(compareLocales(enPlural, { n_other: '{{count}}個' }, 'ja')).toEqual([])
    expect(compareLocales(enPlural, { n_one: '{{count}}個', n_other: '{{count}}個' }, 'ja')).toEqual([
      'ja: n_one is a form ja does not have',
    ])
    // A plural key written as one text is not a plural.
    expect(compareLocales(enPlural, { n: '{{count}}' }, 'ru')).toEqual([
      'ru: n has no plural forms (it needs one, few, many, other)',
    ])
  })

  it('lets a language inflect a text English says the same for every count, and only then', () => {
    const en = { w: '{{count}} waiting', plain: 'Waiting' }
    const ru = {
      w_one: '{{count}} ждёт',
      w_few: '{{count}} ждут',
      w_many: '{{count}} ждут',
      w_other: '{{count}} ждут',
      plain: 'Ждёт',
    }
    expect(compareLocales(en, ru, 'ru')).toEqual([])
    expect(compareLocales(en, { w: '{{count}} ждут', plain: 'Ждёт' }, 'ru')).toEqual([])
    expect(
      compareLocales(
        en,
        {
          w: '{{count}} ждут',
          plain_one: 'Ждёт',
          plain_few: 'Ждёт',
          plain_many: 'Ждёт',
          plain_other: 'Ждёт',
        },
        'ru',
      ),
    ).toEqual(['ru: plain is plural here but has no {{count}} in the English file'])
  })

  it("has a file for each of the board's languages, and nothing else", () => {
    expect(Object.keys(readLocales()).sort()).toEqual([...LANGUAGES].sort())
  })

  it("passes on the app's own translation files: every language has exactly en.json's keys, placeholders, tags and plural forms", () => {
    expect(checkLocales()).toEqual([])
  })

  it('has a real translation in every language, not a copy of the English', () => {
    const { en, ...rest } = readLocales()
    const english = flatten(en)
    for (const [name, tree] of Object.entries(rest)) {
      const flat = flatten(tree)
      // A few texts are the same word in two languages (Menu, Team, brand names, kept product terms).
      const same = Object.keys(flat).filter((k) => flat[k] === english[k] && /\p{L}{4,}/u.test(flat[k]))
      expect(same.length / Object.keys(flat).length, `${name}: ${same.slice(0, 5).join(', ')}`).toBeLessThan(
        0.1,
      )
    }
  })

  it("passes on the desktop app's table", async () => {
    expect(await checkDesktopStrings()).toEqual([])
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
