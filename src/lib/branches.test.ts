import { describe, expect, it } from 'vitest'

import { type StepTask, stepCounts, timeline } from './branches'

let next = 1
const task = (text: string, more: Partial<StepTask> = {}): StepTask => ({
  id: next++,
  parentId: null,
  text,
  done: false,
  blocked: false,
  blockedReason: '',
  ...more,
})
const states = (tasks: StepTask[]) =>
  timeline(tasks).map((g) => [g.caption, g.steps.map((s) => `${s.text}:${s.state}`)])

describe('timeline', () => {
  it('groups subtasks under their task and marks done, now, next and later', () => {
    const impl = task('Implementation')
    const tasks = [
      impl,
      task('Read', { parentId: impl.id, done: true }),
      task('Build', { parentId: impl.id }),
      task('Test', { parentId: impl.id }),
      task('Pushed'),
      task('PR'),
    ]
    expect(states(tasks)).toEqual([
      ['Implementation', ['Read:done', 'Build:now', 'Test:next']],
      [null, ['Pushed:later']],
      [null, ['PR:later']],
    ])
    expect(stepCounts(timeline(tasks))).toEqual({ done: 1, total: 5 })
  })

  it('a blocked first open step takes the pointer; the next open one is next', () => {
    const tasks = [task('A', { done: true }), task('B', { blocked: true }), task('C'), task('D')]
    expect(states(tasks)).toEqual([
      [null, ['A:done']],
      [null, ['B:blocked']],
      [null, ['C:next']],
      [null, ['D:later']],
    ])
  })

  it('a blocked step after the pointer stays blocked', () => {
    const tasks = [task('A'), task('B', { blocked: true }), task('C')]
    expect(states(tasks).flatMap(([, s]) => s)).toEqual(['A:now', 'B:blocked', 'C:next'])
  })

  it('leaves no now when every task is done, and nothing for no tasks', () => {
    expect(states([task('A', { done: true })])).toEqual([[null, ['A:done']]])
    expect(timeline([])).toEqual([])
  })
})
