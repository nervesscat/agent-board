import { useCallback, useEffect, useState } from 'react'

/**
 * How the project sidebar shows on desktop: in full, shrunk to its icons, or hidden (a hover on the left
 * border shows it for a moment). The toggle cycles through them in this order.
 */
export const SIDEBAR_MODES = ['expanded', 'shrunk', 'hidden'] as const
export type SidebarMode = (typeof SIDEBAR_MODES)[number]

/** Per browser, not per project or per account. */
export const SIDEBAR_STORAGE_KEY = 'agent-board.sidebar'

export function nextSidebarMode(mode: SidebarMode): SidebarMode {
  return SIDEBAR_MODES[(SIDEBAR_MODES.indexOf(mode) + 1) % SIDEBAR_MODES.length]
}

/** The toggle's name: what its next press does. */
export const SIDEBAR_TOGGLE_LABEL: Record<SidebarMode, string> = {
  expanded: 'Shrink sidebar',
  shrunk: 'Hide sidebar',
  hidden: 'Show sidebar',
}

/** A stored value that is not a mode (or no value at all) means the sidebar as it always was. */
export function parseSidebarMode(value: unknown): SidebarMode {
  return (SIDEBAR_MODES as readonly unknown[]).includes(value) ? (value as SidebarMode) : 'expanded'
}

/**
 * The remembered mode, a setter that remembers the choice, and whether the remembered mode is showing yet. The stored value is read after mount, not in
 * the first render: the server has none, so the first render must match its HTML (a returning visitor who
 * hid the sidebar sees it expanded for a moment, then hidden).
 */
export function useSidebarMode() {
  const [mode, setMode] = useState<SidebarMode>('expanded')
  // True from the render that shows the remembered mode (or the default, when there is none to read).
  const [ready, setReady] = useState(false)
  useEffect(() => {
    try {
      setMode(parseSidebarMode(localStorage.getItem(SIDEBAR_STORAGE_KEY)))
    } catch {
      // Storage can be blocked (private modes, a disabled cookie setting): the sidebar then starts expanded.
    }
    setReady(true)
  }, [])
  const choose = useCallback((next: SidebarMode) => {
    setMode(next)
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, next)
    } catch {
      // The choice still holds for this visit; it is only not remembered.
    }
  }, [])
  return [mode, choose, ready] as const
}
