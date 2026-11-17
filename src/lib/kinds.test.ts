import { describe, expect, it } from 'vitest'

import {
  cleanKinds,
  DEFAULT_KINDS,
  GIT_SIDE_PAGES,
  hasGitSide,
  isKind,
  KINDS,
  NON_SOFTWARE_PHASES,
  presetPhases,
  toggleKind,
  visibleNavPages,
} from './kinds'

describe('isKind', () => {
  it('accepts the ten kinds and nothing else', () => {
    expect(KINDS).toEqual([
      'software',
      'music',
      'art',
      'writing',
      'video',
      'research',
      'lawyer',
      'accountant',
      'cybersecurity',
      'life',
    ])
    for (const k of KINDS) expect(isKind(k)).toBe(true)
    expect(isKind('Music')).toBe(false)
    expect(isKind('game')).toBe(false)
    expect(isKind('Lawyer')).toBe(false)
    expect(isKind(undefined)).toBe(false)
  })
})

describe('cleanKinds', () => {
  it('keeps the valid kinds once, in the order KINDS gives them', () => {
    expect(cleanKinds(['art', 'music', 'art'])).toEqual(['music', 'art'])
  })
  it('is null when no kind is valid', () => {
    expect(cleanKinds([])).toBeNull()
    expect(cleanKinds(['game'])).toBeNull()
  })
})

describe('hasGitSide', () => {
  it('is true only when software is among the kinds', () => {
    expect(hasGitSide(['software'])).toBe(true)
    expect(hasGitSide(['music', 'software'])).toBe(true)
    expect(hasGitSide(['music'])).toBe(false)
    expect(hasGitSide(['art', 'video'])).toBe(false)
    // The professional kinds keep no git side either; a team whose work includes code adds software.
    expect(hasGitSide(['lawyer', 'accountant', 'cybersecurity', 'life'])).toBe(false)
    expect(hasGitSide(['cybersecurity', 'software'])).toBe(true)
  })
  it('treats a project with no kinds given as software', () => {
    expect(hasGitSide(undefined)).toBe(true)
    expect(hasGitSide(null)).toBe(true)
    expect(DEFAULT_KINDS).toEqual(['software'])
  })
})

describe('presetPhases', () => {
  it('keeps the built-in list (null) for a project with software', () => {
    expect(presetPhases(['software'])).toBeNull()
    expect(presetPhases(['software', 'music'])).toBeNull()
  })
  it('gives a project with no software its own preset', () => {
    expect(presetPhases(['music'])).toEqual(NON_SOFTWARE_PHASES)
    expect(presetPhases(['writing', 'research'])).toEqual(['Implementation', 'Summary'])
  })
})

describe('visibleNavPages', () => {
  const pages = ['nav.overview', 'nav.prs', 'nav.features', 'nav.previews', 'nav.cleanup', 'nav.repositories']
  it('keeps every page of a software project', () => {
    expect(visibleNavPages(pages, ['software'])).toEqual(pages)
  })
  it('drops the git-side pages of a project with no software kind, and keeps the rest in order', () => {
    expect(visibleNavPages(pages, ['music'])).toEqual(['nav.overview', 'nav.features'])
  })
  it('names the git-side pages it hides', () => {
    expect([...GIT_SIDE_PAGES].sort()).toEqual(['nav.cleanup', 'nav.previews', 'nav.prs', 'nav.repositories'])
  })
})

describe('toggleKind', () => {
  it('adds a kind in KINDS order and removes one, but never the last', () => {
    expect(toggleKind(['software'], 'music')).toEqual(['software', 'music'])
    expect(toggleKind(['music'], 'software')).toEqual(['software', 'music'])
    expect(toggleKind(['software', 'music'], 'software')).toEqual(['music'])
    expect(toggleKind(['music'], 'music')).toEqual(['music'])
  })
})
