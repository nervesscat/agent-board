/** The colour scheme picked in Settings: the system's by default, or light or dark for this browser. */
export const THEMES = ['system', 'light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

export const THEME_LABEL: Record<Theme, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
}

/** Where the choice is kept: this browser's, like the layout's own pickers. */
const THEME_KEY = 'theme'

const prefersDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches

/** The theme this browser picked, or the system's when it picked none. */
export function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY)
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved
  } catch {}
  return 'system'
}

/** Puts a theme on the page: `dark` on <html> or not, following the system while it is the system's. */
export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && prefersDark()))
}

/** Picks a theme for this browser and applies it now. */
export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {}
  applyTheme(theme)
}

/**
 * Applies the picked theme now and follows the system's changes while the system's is picked. Returns
 * the listener's remover.
 */
export function followTheme(): () => void {
  const apply = () => applyTheme(readTheme())
  apply()
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  mq.addEventListener('change', apply)
  return () => mq.removeEventListener('change', apply)
}
