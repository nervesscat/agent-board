import type { i18n as I18n } from 'i18next'
import { useSyncExternalStore } from 'react'

import type { Language } from './languages'

/** The language an instance is in now, re-read when it changes (outside the provider, which the shell is). */
export function useLanguageOf(instance: I18n): Language {
  return useSyncExternalStore(
    (notify) => {
      instance.on('languageChanged', notify)
      return () => instance.off('languageChanged', notify)
    },
    () => instance.language as Language,
    () => instance.language as Language,
  )
}
