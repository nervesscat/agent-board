/**
 * The interface's languages and how one is chosen. No React and no browser here: the server (the sign-in
 * pages, the first render), the browser and the tests all read it.
 *
 * The twenty most spoken languages that read left to right, in the order of the dropdown. Adding a language: a
 * file in `locales/` with every key of `en.json`, its code in `LANGUAGES`, its own name in `LANGUAGE_NAME`, its
 * `Intl` locale in `LANGUAGE_LOCALE` and the desktop app's table (desktop/app/strings/).
 */
export const LANGUAGES = [
  'en',
  'zh',
  'hi',
  'es',
  'fr',
  'bn',
  'pt',
  'ru',
  'id',
  'de',
  'ja',
  'mr',
  'vi',
  'te',
  'tr',
  'ko',
  'ta',
  'it',
  'pl',
  'uk',
] as const
export type Language = (typeof LANGUAGES)[number]

/** English is today's text: what shows when nothing says otherwise. */
export const DEFAULT_LANGUAGE: Language = 'en'

/** Each language in its own words: never translated, so it can be found whatever the page is in. */
export const LANGUAGE_NAME: Record<Language, string> = {
  en: 'English',
  zh: '中文（简体）',
  hi: 'हिन्दी',
  es: 'Español',
  fr: 'Français',
  bn: 'বাংলা',
  pt: 'Português',
  ru: 'Русский',
  id: 'Bahasa Indonesia',
  de: 'Deutsch',
  ja: '日本語',
  mr: 'मराठी',
  vi: 'Tiếng Việt',
  te: 'తెలుగు',
  tr: 'Türkçe',
  ko: '한국어',
  ta: 'தமிழ்',
  it: 'Italiano',
  pl: 'Polski',
  uk: 'Українська',
}

/** Each language in English, so the dropdown's search finds "German" as well as "Deutsch". */
export const LANGUAGE_ENGLISH_NAME: Record<Language, string> = {
  en: 'English',
  zh: 'Chinese (Simplified)',
  hi: 'Hindi',
  es: 'Spanish',
  fr: 'French',
  bn: 'Bengali',
  pt: 'Portuguese',
  ru: 'Russian',
  id: 'Indonesian',
  de: 'German',
  ja: 'Japanese',
  mr: 'Marathi',
  vi: 'Vietnamese',
  te: 'Telugu',
  tr: 'Turkish',
  ko: 'Korean',
  ta: 'Tamil',
  it: 'Italian',
  pl: 'Polish',
  uk: 'Ukrainian',
}

/** The tag `Intl` takes when the browser's own locale is not one of the language: the language, and its script where one is needed. */
export const LANGUAGE_LOCALE: Record<Language, string> = {
  en: 'en',
  zh: 'zh-CN',
  hi: 'hi',
  es: 'es',
  fr: 'fr',
  bn: 'bn',
  pt: 'pt',
  ru: 'ru',
  id: 'id',
  de: 'de',
  ja: 'ja',
  mr: 'mr',
  vi: 'vi',
  te: 'te',
  tr: 'tr',
  ko: 'ko',
  ta: 'ta',
  it: 'it',
  pl: 'pl',
  uk: 'uk',
}

/** The cookie that carries the choice to the server's first render and to the sign-in pages. */
export const LANGUAGE_COOKIE = 'lang'

export const isLanguage = (value: unknown): value is Language =>
  typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value)

/** The supported language a language tag asks for (`es-MX` and `es` are Spanish, `zh-TW` Chinese), if there is one. */
export function languageOfTag(tag: string): Language | undefined {
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0]
  // The old code of Indonesian (`in`); every Chinese tag (zh-CN, zh-Hans, zh-TW) reads the Simplified text.
  return LANGUAGES.find((l) => l === (primary === 'in' ? 'id' : primary))
}

/** The first of the browser's preferred tags (most preferred first) that is a supported language. */
export function matchLanguage(tags: readonly string[] | null | undefined): Language | undefined {
  for (const tag of tags ?? []) {
    const found = languageOfTag(tag)
    if (found) return found
  }
  return undefined
}

/** The tags of an Accept-Language header, best first (`es-MX,es;q=0.9,en;q=0.8`); `q=0` is refused. */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return []
  return header
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';')
      const q = params.map((p) => /^\s*q\s*=\s*([\d.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined)
      return { tag: tag.trim(), q: q === undefined ? 1 : Number(q), index }
    })
    .filter((e) => e.tag && e.tag !== '*' && Number.isFinite(e.q) && e.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index)
    .map((e) => e.tag)
}

/** The language a Cookie header carries, if it carries a supported one. */
export function languageFromCookie(header: string | null | undefined): Language | undefined {
  for (const part of (header ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === LANGUAGE_COOKIE) {
      const value = rest.join('=')
      return isLanguage(value) ? value : undefined
    }
  }
  return undefined
}

/**
 * The language a request is in: the one this browser last showed (its cookie), else the browser's own
 * preference, else English.
 */
export function languageOfRequest(headers: { get(name: string): string | null }): Language {
  return (
    languageFromCookie(headers.get('cookie')) ??
    matchLanguage(parseAcceptLanguage(headers.get('accept-language'))) ??
    DEFAULT_LANGUAGE
  )
}

/** The Set-Cookie value that keeps a language for a year (the page reads it with no script: not HttpOnly). */
export const languageCookie = (language: Language) =>
  `${LANGUAGE_COOKIE}=${language}; Path=/; Max-Age=31536000; SameSite=Lax`
