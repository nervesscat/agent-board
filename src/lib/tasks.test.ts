import { describe, expect, it } from 'vitest'

import { addTasks } from './tasks'

describe('addTasks', () => {
  it('adds the text at the end, trimmed', () => {
    expect(addTasks([], '  Write tests  ')).toEqual(['Write tests'])
    expect(addTasks(['A', 'B'], 'C')).toEqual(['A', 'B', 'C'])
  })

  it('adds one task per line, in order, without the blank ones', () => {
    expect(addTasks(['A'], 'Reproduce it\n\n  Fix it \r\n   \nShip it')).toEqual([
      'A',
      'Reproduce it',
      'Fix it',
      'Ship it',
    ])
  })

  it('adds nothing for blank text, and gives back the same list', () => {
    const tasks = ['A']
    expect(addTasks(tasks, '')).toBe(tasks)
    expect(addTasks(tasks, '   ')).toBe(tasks)
    expect(addTasks(tasks, '\n \n')).toBe(tasks)
  })

  it('keeps repeats', () => {
    expect(addTasks(['Check'], 'Check')).toEqual(['Check', 'Check'])
  })
})
