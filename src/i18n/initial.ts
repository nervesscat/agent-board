import { createIsomorphicFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'

import {
  DEFAULT_LANGUAGE,
  LANGUAGE_COOKIE,
  isLanguage,
  languageFromCookie,
  matchLanguage,
  languageOfRequest,
  type Language,
} from './languages'

/**
 * The language the first render is in. On the server: the request's (its cookie, else its
 * Accept-Language). In the browser: the one the server drew the page in (`<html lang>`), so hydration
 * matches it; failing that this browser's own copy of the choice, else its preferred languages.
 */
export const initialLanguage = createIsomorphicFn()
  .server((): Language => languageOfRequest(getRequest().headers))
  .client((): Language => {
    const drawn = document.documentElement.lang
    if (isLanguage(drawn)) return drawn
    return (
      languageFromCookie(document.cookie) ??
      storedLanguage() ??
      matchLanguage(navigator.languages) ??
      DEFAULT_LANGUAGE
    )
  })

function storedLanguage(): Language | undefined {
  try {
    const value = localStorage.getItem(LANGUAGE_COOKIE)
    return isLanguage(value) ? value : undefined
  } catch {
    return undefined
  }
}
