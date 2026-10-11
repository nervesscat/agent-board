import { describe, expect, it } from 'vitest'

import {
  DEFAULT_REPORT_TEMPLATE,
  checkTemplate,
  effectiveTemplate,
  templateHeadings,
  unwrapReport,
} from './reportTemplate'

const filled = (...headings: string[]) => headings.map((h) => `## ${h}\n\n- something`).join('\n\n')

describe('the default template', () => {
  it('is Done, In progress, Blocked / needs you, Pushed today and Next, in that order', () => {
    expect(templateHeadings(DEFAULT_REPORT_TEMPLATE)).toEqual(
      ['Done', 'In progress', 'Blocked / needs you', 'Pushed today', 'Next'].map((text) => ({
        level: 2,
        text,
      })),
    )
  })

  it('is the one in force while a project has none of its own', () => {
    expect(effectiveTemplate('')).toBe(DEFAULT_REPORT_TEMPLATE)
    expect(effectiveTemplate('  \n')).toBe(DEFAULT_REPORT_TEMPLATE)
    expect(effectiveTemplate('# Mine\n')).toBe('# Mine\n')
  })
})

describe('templateHeadings', () => {
  it('reads ATX headings, with their closing #s off and a # in the text kept', () => {
    expect(templateHeadings('# One #\n  ### Two  \nnot # a heading\n#nope\n## C#\n####### seven')).toEqual([
      { level: 1, text: 'One' },
      { level: 3, text: 'Two' },
      { level: 2, text: 'C#' },
    ])
  })

  it('leaves out a # line inside a code block', () => {
    expect(templateHeadings('## Done\n```bash\n# a comment\n```\n~~~\n## also code\n~~~\n## Next')).toEqual([
      { level: 2, text: 'Done' },
      { level: 2, text: 'Next' },
    ])
  })
})

describe('checkTemplate', () => {
  const template = DEFAULT_REPORT_TEMPLATE

  it.each([
    [
      'the same headings in the same order',
      filled('Done', 'In progress', 'Blocked / needs you', 'Pushed today', 'Next'),
    ],
    [
      'case and spacing of its own, text before the first heading, deeper and shallower headings',
      `# Daily report\nA line first.\n\n${filled('done', 'In   progress', 'Blocked / Needs You', 'Pushed today', 'Next')}\n\n### a detail\n- x`,
    ],
  ])('passes %s', (_, output) => {
    expect(checkTemplate(template, output)).toEqual({ ok: true })
  })

  it.each([
    [
      'a missing heading',
      filled('Done', 'In progress', 'Blocked / needs you', 'Pushed today'),
      'missing: Next',
    ],
    [
      'an extra heading at a level the template uses',
      filled('Done', 'In progress', 'Blocked / needs you', 'Pushed today', 'Notes', 'Next'),
      'unexpected: Notes',
    ],
    [
      'a heading of the template at another level',
      filled('Done', 'In progress', 'Blocked / needs you', 'Pushed today').concat('\n\n### Next\n'),
      'missing: Next',
    ],
    [
      'a heading twice',
      filled('Done', 'Done', 'In progress', 'Blocked / needs you', 'Pushed today', 'Next'),
      'unexpected: Done',
    ],
    [
      'nothing at all',
      'Just a sentence.',
      'missing: Done, In progress, Blocked / needs you, Pushed today, Next',
    ],
  ])('fails on %s, saying so', (_, output, reason) => {
    expect(checkTemplate(template, output)).toEqual({ ok: false, reason })
  })

  it('fails on two headings swapped, saying they are out of order', () => {
    const check = checkTemplate(
      template,
      filled('Done', 'Blocked / needs you', 'In progress', 'Pushed today', 'Next'),
    )
    expect(check.ok).toBe(false)
    expect(!check.ok && check.reason).toMatch(/^out of order: Done, Blocked \/ needs you, In progress/)
  })

  it('names what is missing and what is not asked for together', () => {
    expect(checkTemplate('## A\n## B\n', '## A\n## C\n')).toEqual({
      ok: false,
      reason: 'missing: B; unexpected: C',
    })
  })

  it('checks every level a template uses, and passes anything when it has no heading', () => {
    const nested = '# Week\n## Done\n## Next\n'
    expect(checkTemplate(nested, '# Week\n## Done\n- a\n## Next\n- b')).toEqual({ ok: true })
    expect(checkTemplate(nested, '## Done\n## Next')).toEqual({ ok: false, reason: 'missing: Week' })
    expect(checkTemplate('Just write.', 'Anything')).toEqual({ ok: true })
  })
})

describe('unwrapReport', () => {
  it('takes the report out of a code fence wrapping all of it', () => {
    expect(unwrapReport('```markdown\n## Done\n- a\n```\n')).toBe('## Done\n- a')
    expect(unwrapReport('  ```\n## Done\n```')).toBe('## Done')
    expect(unwrapReport('~~~md\r\n## Done\r\n~~~')).toBe('## Done')
  })

  it('leaves any other text as it is, trimmed, a code block inside it included', () => {
    expect(unwrapReport('\n## Done\n```\ncode\n```\n')).toBe('## Done\n```\ncode\n```')
    expect(unwrapReport('```ts\nconst a = 1\n```')).toBe('```ts\nconst a = 1\n```')
  })
})
