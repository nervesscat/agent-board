import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'

import { get, type Me } from '#/lib/api'

import { setLanguage } from '.'

/**
 * Puts the language the person picked (kept on the board, so it follows them to every device) on the page
 * once the board has said it. Until they pick one, the browser's own decides and this does nothing.
 */
export function LanguageSync() {
  const { data } = useQuery({ queryKey: ['me'], queryFn: () => get<Me>('/api/me'), staleTime: Infinity })
  const picked = data?.language ?? null
  useEffect(() => {
    if (picked) void setLanguage(picked)
  }, [picked])
  return null
}
