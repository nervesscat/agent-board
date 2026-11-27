import { createIsomorphicFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'

import { browserLanguage } from './browser'
import { languageOfRequest, type Language } from './languages'

/**
 * The language the first render is in. On the server: the request's (its cookie, else its
 * Accept-Language). In the browser: see `browserLanguage`.
 */
export const initialLanguage = createIsomorphicFn()
  .server((): Language => languageOfRequest(getRequest().headers))
  .client((): Language => browserLanguage())
