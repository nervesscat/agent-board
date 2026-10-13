import { describe, expect, it } from 'vitest'

import { DEFAULT_STAGES } from './constants'
import {
  ALL_STAGES,
  countByStage,
  defaultStageFilter,
  inStageFilter,
  isStageFilter,
  resolveStageFilter,
  stageInSearch,
} from './stageFilter'
import type { StageLike } from './stages'

const stages: StageLike[] = DEFAULT_STAGES
// The review stage renamed and moved after Done: still the one the filter starts on, by its kind.
const renamed: StageLike[] = [
  ...DEFAULT_STAGES.filter((s) => s.kind !== 'review'),
  { key: 'review', name: 'Waiting for me', kind: 'review', color: 'violet' },
  { key: 'qa', name: 'QA', kind: 'review', color: 'pink' },
]
const noReview: StageLike[] = DEFAULT_STAGES.filter((s) => s.kind !== 'review')

describe('the stage filter', () => {
  it("starts on the project's first review stage, chosen by kind, else on every stage", () => {
    expect(defaultStageFilter(stages)).toBe('review')
    expect(defaultStageFilter(renamed)).toBe('review')
    expect(defaultStageFilter([{ key: 'qa', name: 'QA', kind: 'review', color: 'pink' }])).toBe('qa')
    expect(defaultStageFilter(noReview)).toBe(ALL_STAGES)
    expect(defaultStageFilter([])).toBe(ALL_STAGES)
  })

  it("offers every stage and each of the project's stages, nothing else", () => {
    expect(isStageFilter(stages, ALL_STAGES)).toBe(true)
    expect(isStageFilter(stages, 'done')).toBe(true)
    expect(isStageFilter(stages, 'all')).toBe(false)
    expect(isStageFilter(stages, 'nope')).toBe(false)
    expect(isStageFilter(stages, '')).toBe(false)
    expect(isStageFilter(stages, undefined)).toBe(false)
    expect(isStageFilter(stages, null)).toBe(false)
    expect(isStageFilter(noReview, 'review')).toBe(false)
  })

  it('shows the one in the URL, else the one remembered, else the default', () => {
    expect(resolveStageFilter(stages, 'done', 'todo')).toBe('done')
    expect(resolveStageFilter(stages, ALL_STAGES, 'todo')).toBe(ALL_STAGES)
    expect(resolveStageFilter(stages, undefined, 'todo')).toBe('todo')
    expect(resolveStageFilter(stages, undefined, ALL_STAGES)).toBe(ALL_STAGES)
    expect(resolveStageFilter(stages, undefined, undefined)).toBe('review')
    expect(resolveStageFilter(stages, undefined, null)).toBe('review')
    expect(resolveStageFilter(noReview, undefined, undefined)).toBe(ALL_STAGES)
  })

  it('takes a stage the project no longer has, in the URL or remembered, as none', () => {
    expect(resolveStageFilter(stages, 'nope', 'done')).toBe('done')
    expect(resolveStageFilter(stages, 'nope', undefined)).toBe('review')
    expect(resolveStageFilter(noReview, 'review', undefined)).toBe(ALL_STAGES)
    expect(resolveStageFilter(noReview, undefined, 'review')).toBe(ALL_STAGES)
    expect(resolveStageFilter(noReview, 'review', 'done')).toBe('done')
  })

  it("keeps a stage's rows, or every row under every stage", () => {
    expect(inStageFilter('review', 'review')).toBe(true)
    expect(inStageFilter('review', 'done')).toBe(false)
    expect(inStageFilter(ALL_STAGES, 'done')).toBe(true)
    // A ticket left in a stage since removed shows under every stage only.
    expect(inStageFilter(ALL_STAGES, 'gone')).toBe(true)
    expect(stages.some((s) => inStageFilter(s.key, 'gone'))).toBe(false)
  })

  it('counts the rows of each stage, and all of them under every stage', () => {
    const counts = countByStage(['review', 'done', 'review', 'gone', 'in_progress'])
    expect(Object.fromEntries(counts)).toEqual({
      [ALL_STAGES]: 5,
      review: 2,
      done: 1,
      in_progress: 1,
      gone: 1,
    })
    expect(Object.fromEntries(countByStage([]))).toEqual({ [ALL_STAGES]: 0 })
  })

  it("counts a stage whose key is a name an object's prototype has, and nothing for it while empty", () => {
    const keys = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']
    const counts = countByStage([...keys, 'constructor'])
    expect(counts.get('constructor')).toBe(2)
    for (const k of keys.slice(1)) expect(counts.get(k)).toBe(1)
    expect(counts.get(ALL_STAGES)).toBe(6)
    const empty = countByStage(['review'])
    for (const k of keys) expect(empty.get(k)).toBeUndefined()
    const odd = keys.map(named)
    for (const k of keys) {
      expect(isStageFilter(odd, k)).toBe(true)
      expect(isStageFilter(stages, k)).toBe(false)
      expect(resolveStageFilter(stages, k, k)).toBe('review')
      expect(inStageFilter(k, k)).toBe(true)
      expect(inStageFilter(k, 'review')).toBe(false)
    }
  })

  it('reads the stage key in ?stage= the router JSON-parsed: a number, a boolean or null names the key that parses to it', () => {
    const odd = [
      ...stages,
      ...['2026', 'true', 'false', 'null', '1e3', '007', '12345678901234567890'].map(named),
    ]
    expect(stageInSearch(odd, undefined)).toBeUndefined()
    expect(stageInSearch(odd, 'done')).toBe('done')
    // The quoted form the app writes arrives as the key itself.
    expect(stageInSearch(odd, '2026')).toBe('2026')
    expect(stageInSearch(odd, '007')).toBe('007')
    expect(stageInSearch(odd, 2026)).toBe('2026')
    expect(stageInSearch(odd, true)).toBe('true')
    expect(stageInSearch(odd, false)).toBe('false')
    expect(stageInSearch(odd, null)).toBe('null')
    expect(stageInSearch(odd, 1000)).toBe('1e3')
    expect(stageInSearch(odd, JSON.parse('12345678901234567890'))).toBe('12345678901234567890')
    // No stage parses to it: the value as a string, which the project has no stage for.
    expect(stageInSearch(stages, 2026)).toBe('2026')
    expect(stageInSearch(stages, true)).toBe('true')
    expect(isStageFilter(stages, stageInSearch(stages, 2026))).toBe(false)
    expect(resolveStageFilter(odd, stageInSearch(odd, 2026), 'done')).toBe('2026')
  })
})

function named(key: string): StageLike {
  return { key, name: key, kind: 'active', color: 'gray' }
}
