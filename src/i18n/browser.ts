import {
  DEFAULT_LANGUAGE,
  LANGUAGE_COOKIE,
  isLanguage,
  languageFromCookie,
  matchLanguage,
  type Language,
} from './languages'

/**
 * The language the browser starts in: the one the server drew the page in (`<html lang>`), so hydration
 * matches it; failing that this browser's own copy of the choice, else its preferred languages.
 */
export function browserLanguage(): Language {
  const drawn = document.documentElement.lang
  if (isLanguage(drawn)) return drawn
  return (
    languageFromCookie(document.cookie) ??
    storedLanguage() ??
    matchLanguage(navigator.languages) ??
    DEFAULT_LANGUAGE
  )
}

function storedLanguage(): Language | undefined {
  try {
    const value = localStorage.getItem(LANGUAGE_COOKIE)
    return isLanguage(value) ? value : undefined
  } catch {
    return undefined
  }
}
