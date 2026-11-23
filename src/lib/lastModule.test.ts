import { describe, expect, it } from 'vitest'

import { backTarget, encodeModule, moduleOf } from './lastModule'

const saved = (pathname: string, search: Record<string, unknown> = {}, hash = '') =>
  encodeModule({ pathname, search, hash })

describe('moduleOf', () => {
  it('names the project and the page of a project address', () => {
    expect(moduleOf('/projects/3')).toEqual({ project: '3', page: 'nav.overview' })
    expect(moduleOf('/projects/3/prs')).toEqual({ project: '3', page: 'nav.prs' })
    expect(moduleOf('/projects/12/features/58')).toEqual({ project: '12', page: 'nav.features' })
  })

  it('knows no page for the board-wide pages, the old settings address or a page it does not list', () => {
    expect(moduleOf('/settings')).toBeUndefined()
    expect(moduleOf('/agents')).toBeUndefined()
    expect(moduleOf('/')).toBeUndefined()
    expect(moduleOf('/projects/3/settings')).toBeUndefined()
    expect(moduleOf('/projects/3/nowhere')).toBeUndefined()
    expect(moduleOf('/projects/3/run-reports')).toBeUndefined()
    expect(moduleOf('/projects/abc/prs')).toBeUndefined()
  })
})

describe('encodeModule', () => {
  it('keeps only the pages of a project', () => {
    expect(encodeModule({ pathname: '/settings', search: {}, hash: '' })).toBeUndefined()
    expect(encodeModule({ pathname: '/projects/3/settings', search: {}, hash: '' })).toBeUndefined()
    expect(saved('/projects/3/prs')).toBeDefined()
  })
})

describe('backTarget', () => {
  it('goes back to the last page of the selected project, with its search and #hash', () => {
    expect(backTarget('3', saved('/projects/3/features', { view: 'list', q: 'login' }))).toEqual({
      to: '/projects/3/features',
      search: { view: 'list', q: 'login' },
      hash: undefined,
      label: 'Ongoing features',
    })
    expect(backTarget('3', saved('/projects/3/features/58', {}, 'tasks'))).toEqual({
      to: '/projects/3/features/58',
      search: {},
      hash: 'tasks',
      label: 'Ongoing features',
    })
    expect(backTarget('3', saved('/projects/3/prs'))?.label).toBe('PR queue')
    expect(backTarget('3', saved('/projects/3/roadmap'))?.label).toBe('Roadmap')
  })

  it("goes to the new project's Overview when the project was changed since", () => {
    expect(backTarget('4', saved('/projects/3/features/58'))).toEqual({
      to: '/projects/$id',
      params: { id: '4' },
      label: 'Overview',
    })
  })

  it("goes to the project's Overview when no page was kept, or what was kept is unreadable", () => {
    for (const bad of [
      null,
      undefined,
      '',
      'not json',
      '[]',
      '{"pathname":3}',
      '{"pathname":"/x","hash":""}',
    ])
      expect(backTarget('4', bad), String(bad)).toEqual({
        to: '/projects/$id',
        params: { id: '4' },
        label: 'Overview',
      })
  })

  it('goes to Home, the board start page, with no project selected', () => {
    expect(backTarget(undefined, saved('/projects/3/prs'))).toEqual({ to: '/', label: 'Home' })
    expect(backTarget(undefined, null)).toEqual({ to: '/', label: 'Home' })
  })
})
