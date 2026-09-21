/** Follow the system colour scheme by toggling `dark` on <html>. */
export function followSystemTheme(): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const apply = () => document.documentElement.classList.toggle('dark', mq.matches)
  apply()
  mq.addEventListener('change', apply)
  return () => mq.removeEventListener('change', apply)
}
