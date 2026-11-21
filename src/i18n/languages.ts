/**
 * The interface's languages and how one is chosen. No React and no browser here: the server (the sign-in
 * pages, the first render), the browser and the tests all read it.
 *
 * Adding a language: a file in `locales/`, its code in `LANGUAGES` and its own name in `LANGUAGE_NAME`.
 */
export const LANGUAGES = ['en', 'es'] as const
export type Language = (typeof LANGUAGES)[number]

/** English is today's text: what shows when nothing says otherwise. */
export const DEFAULT_LANGUAGE: Language = 'en'

/** Each language in its own words: never translated, so it can be found whatever the page is in. */
export const LANGUAGE_NAME: Record<Language, string> = {
  en: 'English',
  es: 'Español',
}

/** The cookie that carries the choice to the server's first render and to the sign-in pages. */
export const LANGUAGE_COOKIE = 'lang'

export const isLanguage = (value: unknown): value is Language =>
  typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value)

/** The supported language a language tag asks for (`es-MX` and `es` are Spanish), if there is one. */
export function languageOfTag(tag: string): Language | undefined {
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0]
  return LANGUAGES.find((l) => l === primary)
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
