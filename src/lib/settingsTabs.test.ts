import { describe, expect, it } from 'vitest'

import {
  SETTINGS_SECTIONS,
  projectTabSearch,
  resolveSettings,
  tabOwning,
  validateSettingsSearch,
} from './settingsTabs'

describe('validateSettingsSearch', () => {
  it('keeps a known tab and a whole-number project, from a number or its text', () => {
    expect(validateSettingsSearch({ tab: 'project', project: 12 })).toEqual({ tab: 'project', project: 12 })
    expect(validateSettingsSearch({ tab: 'board', project: '7' })).toEqual({ tab: 'board', project: 7 })
  })

  it('drops anything else', () => {
    expect(validateSettingsSearch({ tab: 'other', project: 'x' })).toEqual({})
    expect(validateSettingsSearch({ tab: ['project'], project: 0 })).toEqual({})
    expect(validateSettingsSearch({ project: -3 })).toEqual({})
    expect(validateSettingsSearch({ project: 1.5 })).toEqual({})
    expect(validateSettingsSearch({ project: '1e3' })).toEqual({})
    expect(validateSettingsSearch({})).toEqual({})
  })
})

describe('tabOwning', () => {
  it('names the tab each section is on, and none for another id', () => {
    for (const id of SETTINGS_SECTIONS.board) expect(tabOwning(id)).toBe('board')
    for (const id of SETTINGS_SECTIONS.project) expect(tabOwning(id)).toBe('project')
    expect(tabOwning('')).toBeUndefined()
    expect(tabOwning('post-12')).toBeUndefined()
  })

  it('places the waiting-too-long setting on the project tab, so its link opens there', () => {
    expect(tabOwning('waiting-too-long')).toBe('project')
  })

  it('has no section on both tabs', () => {
    const all = [...SETTINGS_SECTIONS.board, ...SETTINGS_SECTIONS.project]
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('resolveSettings', () => {
  const ids = [1, 2, 3]

  it('opens the board tab by default, without a correction', () => {
    expect(resolveSettings({}, '', undefined, ids)).toEqual({ tab: 'board', project: null, correct: null })
    expect(resolveSettings({ tab: 'board' }, 'theme', undefined, ids).correct).toBeNull()
  })

  it('offers the remembered project, when it is still one', () => {
    expect(resolveSettings({}, '', 2, ids)).toMatchObject({ tab: 'board', project: 2, correct: null })
    expect(resolveSettings({}, '', 9, ids).project).toBeNull()
  })

  it("opens the project tab of the address's project, which wins over the remembered one", () => {
    expect(resolveSettings(projectTabSearch(3), '', 1, ids)).toEqual({
      tab: 'project',
      project: 3,
      correct: null,
    })
  })

  it('puts the remembered project in the address of the project tab', () => {
    expect(resolveSettings({ tab: 'project' }, '', 2, ids)).toEqual({
      tab: 'project',
      project: 2,
      correct: { tab: 'project', project: 2 },
    })
  })

  it('falls back to the board tab with no usable project', () => {
    expect(resolveSettings({ tab: 'project' }, '', undefined, ids)).toEqual({
      tab: 'board',
      project: null,
      correct: {},
    })
    expect(resolveSettings(projectTabSearch(9), '', 2, ids)).toEqual({
      tab: 'board',
      project: null,
      correct: {},
    })
    expect(resolveSettings({ tab: 'project' }, '', 1, [])).toMatchObject({ tab: 'board', correct: {} })
  })

  it("switches to the tab that owns the hash's section when that tab is there", () => {
    expect(resolveSettings({}, 'stages', 2, ids)).toEqual({
      tab: 'project',
      project: 2,
      correct: { tab: 'project', project: 2 },
    })
    expect(resolveSettings(projectTabSearch(1), 'theme', undefined, ids)).toEqual({
      tab: 'board',
      project: 1,
      correct: {},
    })
  })

  it('stays on the board tab for a project section when there is no project', () => {
    expect(resolveSettings({}, 'stages', undefined, ids)).toMatchObject({ tab: 'board', correct: null })
  })

  it('drops the project from the address of the board tab', () => {
    expect(resolveSettings({ tab: 'board', project: 1 }, '', undefined, ids).correct).toEqual({
      tab: 'board',
    })
  })

  it('never opens another project for an address that names a project that is not there', () => {
    const first = resolveSettings(projectTabSearch(999), 'stages', 2, ids)
    expect(first).toEqual({ tab: 'board', project: null, correct: {}, dropHash: true })
    expect(resolveSettings({ tab: 'project', project: 999 }, 'stages', 2, ids).dropHash).toBe(true)
    // The corrected address (no project, no hash) stays on the board tab, a remembered project or not.
    expect(resolveSettings(first.correct!, '', 2, ids)).toMatchObject({ tab: 'board', correct: null })
    // A board section keeps its hash; a project section with no project in the address still opens the
    // remembered project's tab.
    expect(resolveSettings(projectTabSearch(999), 'theme', 2, ids).dropHash).toBeUndefined()
    expect(resolveSettings({}, 'stages', 2, ids)).toMatchObject({ tab: 'project', project: 2 })
  })
})
