import { describe, expect, it } from 'vitest'

import { nameParts, parentName, shortName, truncateName } from './actorName'

describe('actor names', () => {
  it('splits a sub-identity into the name it works as and the one it works under', () => {
    expect(nameParts('opencode/builder-832')).toEqual({ parent: 'opencode', leaf: 'builder-832' })
    expect(nameParts('orch/team/builder-1')).toEqual({ parent: 'orch/team', leaf: 'builder-1' })
    expect(nameParts('opencode')).toEqual({ parent: null, leaf: 'opencode' })
    expect(nameParts('')).toEqual({ parent: null, leaf: '' })
    // A trailing slash names no leaf: it is one plain name, not a broken split.
    expect(nameParts('opencode/')).toEqual({ parent: null, leaf: 'opencode/' })
  })

  it('leaves a name that fits alone', () => {
    expect(truncateName('builder-832')).toBe('builder-832')
    expect(truncateName('12345678901234567890', 20)).toBe('12345678901234567890')
  })

  it('cuts at a word boundary, not mid-word, when there is one', () => {
    expect(truncateName('a-very-long-agent-name-that-goes-on')).toBe('a-very-long-agent…')
    expect(truncateName('builder-who-takes-the-long-way')).toBe('builder-who-takes…')
    expect(truncateName('review_env_with_a_long_suffix', 20)).toBe('review_env_with_a…')
    expect(truncateName('orch/builder-with-a-long-sub-identity', 24)).toBe('orch/builder-with-a…')
  })

  it('cuts inside the only word when the name has no boundary to cut at', () => {
    expect(truncateName('abcdefghijklmnopqrstuvwxyz', 20)).toBe('abcdefghijklmnopqrs…')
  })

  it('labels a row by the name it works as, and its parent quietly before it', () => {
    expect(shortName('opencode/builder-832')).toBe('builder-832')
    expect(parentName(nameParts('opencode/builder-832').parent)).toBe('opencode')
    expect(parentName(nameParts('orch/team/builder-1').parent)).toBe('team')
    expect(parentName(null)).toBe('')
    expect(shortName('a-very-long-agent-name-that-goes-on')).toBe('a-very-long-agent…')
    expect(shortName('')).toBe('unnamed')
  })
})
