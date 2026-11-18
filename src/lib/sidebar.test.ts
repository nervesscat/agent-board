import { describe, expect, it } from 'vitest'

import { SIDEBAR_TOGGLE_LABEL, nextSidebarMode, parseSidebarMode } from './sidebar'

describe('the sidebar toggle', () => {
  it('cycles expanded, shrunk, hidden, and back to expanded', () => {
    expect(nextSidebarMode('expanded')).toBe('shrunk')
    expect(nextSidebarMode('shrunk')).toBe('hidden')
    expect(nextSidebarMode('hidden')).toBe('expanded')
  })

  it('names each state by what its next press does', () => {
    expect(SIDEBAR_TOGGLE_LABEL).toEqual({
      expanded: 'Shrink sidebar',
      shrunk: 'Hide sidebar',
      hidden: 'Show sidebar',
    })
  })
})

describe('the remembered sidebar mode', () => {
  it('reads each mode it wrote', () => {
    expect(parseSidebarMode('expanded')).toBe('expanded')
    expect(parseSidebarMode('shrunk')).toBe('shrunk')
    expect(parseSidebarMode('hidden')).toBe('hidden')
  })

  it('means expanded for a missing or unknown value', () => {
    expect(parseSidebarMode(null)).toBe('expanded')
    expect(parseSidebarMode(undefined)).toBe('expanded')
    expect(parseSidebarMode('')).toBe('expanded')
    expect(parseSidebarMode('collapsed')).toBe('expanded')
    expect(parseSidebarMode('Hidden')).toBe('expanded')
  })
})
