import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider, Trans } from 'react-i18next'
import { describe, expect, it } from 'vitest'

import { createI18n } from '.'

/** A sentence with a link inside, drawn the way a component draws it, in a language. */
const sentence = (language: 'en' | 'es') =>
  renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n: createI18n(language) },
      createElement(Trans, {
        i18nKey: 'settings.board.defaultAgent.text',
        components: { goto: createElement('a', { href: '/agents' }) },
      }),
    ),
  )

describe('a sentence with a link in it', () => {
  it('keeps the link text and its target in English', () => {
    expect(sentence('en')).toBe(
      'The one <a href="/agents">Connect an agent</a> opens on, showing only its commands.',
    )
  })

  it('keeps them in Spanish, where the sentence orders its words its own way', () => {
    expect(sentence('es')).toBe(
      'El que <a href="/agents">Conectar un agente</a> abre al entrar, mostrando solo sus comandos.',
    )
  })
})

describe('plurals', () => {
  it('pick the form of the count in each language', () => {
    const en = createI18n('en')
    const es = createI18n('es')
    expect(en.t('time.hoursAgoLong', { count: 1 })).toBe('1 hour ago')
    expect(en.t('time.hoursAgoLong', { count: 3 })).toBe('3 hours ago')
    expect(es.t('time.hoursAgoLong', { count: 1 })).toBe('hace 1 hora')
    expect(es.t('time.hoursAgoLong', { count: 3 })).toBe('hace 3 horas')
    expect(es.t('layoutEditor.hiddenCount', { count: 1 })).toBe('1 oculta.')
    expect(es.t('layoutEditor.hiddenCount', { count: 2 })).toBe('2 ocultas.')
  })
})
