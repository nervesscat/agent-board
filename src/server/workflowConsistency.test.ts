import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { COMPLEXITIES, type Complexity } from '#/lib/constants'
import {
  WORKFLOW_PRESETS,
  WORKFLOW_PRESET_DEFS,
  WORKFLOW_STEPS,
  orderProblem,
  resolveWorkflow,
  type PresetTweak,
  type ResolvedWorkflow,
  type WorkflowPresetId,
  type WorkflowStepId,
} from '#/lib/workflow'

// The workflow module opens SQLite at import; point it at a throwaway directory before anything loads it.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-workflow-consistency-'))

let render: (workflow: ResolvedWorkflow) => string
let applyFlow: typeof import('./workflow').applyFlow
beforeAll(async () => {
  const { renderWorkflowText, applyFlow: apply } = await import('./workflow')
  applyFlow = apply
  render = (workflow) =>
    renderWorkflowText(workflow, { source: 'project', projectPreset: workflow.preset, ticketId: null })
})

/** One way a human may have tweaked a preset, with a name for the failure message. */
interface Combo {
  name: string
  tweak: PresetTweak | undefined
}

const off = (...ids: WorkflowStepId[]): PresetTweak['steps'] =>
  Object.fromEntries(ids.map((id) => [id, { enabled: false }]))

/** Every tweak set the matrix renders for a preset: none, each switch off alone and in pairs, and the rounds. */
function combos(preset: WorkflowPresetId): Combo[] {
  const switchable = WORKFLOW_PRESET_DEFS[preset].steps.filter((id) => WORKFLOW_STEPS[id].lock !== 'always')
  const list: Combo[] = [{ name: 'no tweak', tweak: undefined }]
  for (const id of switchable) list.push({ name: `${id} off`, tweak: { steps: off(id) } })
  for (const [i, a] of switchable.entries())
    for (const b of switchable.slice(i + 1))
      list.push({ name: `${a} and ${b} off`, tweak: { steps: off(a, b) } })
  list.push({ name: 'rounds.low 1', tweak: { rounds: { low: 1 } } })
  list.push({ name: 'rounds.low 1, intent off', tweak: { rounds: { low: 1 }, steps: off('intent') } })
  list.push({
    name: 'rounds.low 1, intent and preview off',
    tweak: { rounds: { low: 1 }, steps: off('intent', 'preview') },
  })
  list.push({
    name: 'rounds.low 1, intent and CI off',
    tweak: { rounds: { low: 1 }, steps: off('intent', 'ci') },
  })
  list.push({ name: 'rounds.mid 0', tweak: { rounds: { mid: 0 } } })
  list.push({ name: 'rounds.mid 0, intent off', tweak: { rounds: { mid: 0 }, steps: off('intent') } })
  list.push({ name: 'rounds.mid 0, preview off', tweak: { rounds: { mid: 0 }, steps: off('preview') } })
  list.push({ name: 'rounds all 0', tweak: { rounds: { low: 0, mid: 0, high: 0, max: 0 } } })
  // The Preview step moved before the Review, which the order rules allow: the text must follow the order.
  const previewFirst = previewBeforeReview(preset)
  list.push({ name: 'preview before review', tweak: { order: previewFirst } })
  list.push({
    name: 'preview before review, intent off',
    tweak: { order: previewFirst, steps: off('intent') },
  })
  list.push({
    name: 'preview before review, preview off',
    tweak: { order: previewFirst, steps: off('preview') },
  })
  list.push({
    name: 'preview before review, intent and CI off',
    tweak: { order: previewFirst, steps: off('intent', 'ci') },
  })
  list.push({
    name: 'preview before review, rounds.low 1, intent off',
    tweak: { order: previewFirst, rounds: { low: 1 }, steps: off('intent') },
  })
  list.push({
    name: 'preview before review, rounds.mid 0',
    tweak: { order: previewFirst, rounds: { mid: 0 } },
  })
  return list
}

/** The preset's order with the Preview step moved to just before the Review (an order the rules allow). */
function previewBeforeReview(preset: WorkflowPresetId): WorkflowStepId[] {
  const order: WorkflowStepId[] = WORKFLOW_PRESET_DEFS[preset].steps.filter((id) => id !== 'preview')
  order.splice(order.indexOf('review'), 0, 'preview')
  expect(orderProblem(preset, order), `${preset} with the preview before the review`).toBeNull()
  return order
}

const flat = (text: string) => text.replace(/\s+/g, ' ')

/** How the served text names a step, in the lines that tell what a step does and hands on. */
const NAMES: Partial<Record<WorkflowStepId, RegExp>> = {
  intent: /intent check|intent step/i,
  preview: /preview/i,
  ci: /\bCI\b/,
  review: /review round|one more review|review phases|every review|each round|the next round/i,
  spec: /first spec|reconcile the two|merge the two|the two specs/i,
  spec2: /second spec|01-spec-2/i,
  tests: /test-writing/i,
}

/** A sentence that asks for something the workflow lists as skipped is a contradiction; one that says it is not asked for is not. */
const REQUIRES = /\bonly after\b|\bsurvives only when\b|\bmatches\b|\brequired\b|\brequires\b|\bmust\b/i
const EXEMPT =
  /\b(skipped|turned off|none is required|no intent check|no preview|there is no|not required|none ran)\b/i

/** The `## n. Label` sections of the text, by label, with their number. */
function sections(text: string) {
  const out: { number: number; label: string; body: string }[] = []
  const parts = text.split(/^## (\d+)\. /m)
  for (let i = 1; i < parts.length; i += 2) {
    const body = parts[i + 1]!
    out.push({ number: Number(parts[i]), label: body.split(/ - |\n/)[0]!.replace(/ \[locked.*$/, ''), body })
  }
  return out
}

/** Generic invariants of one rendered workflow; each violation names the rule and the offending text. */
function inconsistencies(w: ResolvedWorkflow, text: string): string[] {
  const found: string[] = []
  const skipped = w.steps.filter((s) => s.skipped)
  const skippedIds = new Set(skipped.map((s) => s.id))
  const sentences = flat(text).split(/(?<=[.;:])\s+(?=[A-Z*`-])/)

  // (a) A step listed as skipped is never named as a required precondition, and no line that says what a
  // step does or hands on names it.
  for (const step of skipped) {
    const name = NAMES[step.id]
    if (!name) continue
    for (const sentence of sentences) {
      if (name.test(sentence) && REQUIRES.test(sentence) && !EXEMPT.test(sentence))
        found.push(`(a) ${step.id} is skipped but a sentence requires it: ${sentence.slice(0, 160)}`)
    }
    if (step.id === 'intent') {
      for (const bad of [
        /Only after the intent check returned/,
        /intent check at the end of the round/i,
        /the intent check matches/i,
        /survives only when[^.]*intent/i,
      ])
        if (bad.test(flat(text))) found.push(`(a) intent is skipped but the text matches ${bad}`)
    }
    for (const other of w.steps.filter((o) => !o.skipped && o.id !== step.id)) {
      for (const field of ['what', 'handoff'] as const) {
        if (name.test(other[field]))
          found.push(`(a) ${step.id} is skipped but ${other.id}'s ${field} names it`)
      }
    }
  }

  // (b) The review's phases never include an intent phase when the intent step is skipped.
  const review = w.steps.find((s) => s.id === 'review')!
  if (skippedIds.has('intent') && review.review) {
    const labels: string[] = []
    const walk = (list: typeof review.review.phases) => {
      for (const p of list) {
        labels.push(p.id)
        walk(p.children)
      }
    }
    walk(review.review.phases)
    if (labels.includes('review.intent'))
      found.push('(b) the review lists an intent phase with the intent step skipped')
    if (/Intent check - `intent`/.test(text))
      found.push('(b) the text lists an intent phase with the intent step skipped')
    if (/matches/.test(review.review.survival))
      found.push('(b) the survival rule asks for a match with the intent step skipped')
  }

  // (c) A review that is skipped has no phases line, survival rule, round count or between-rounds text.
  if (review.skipped) {
    for (const marker of [
      'phases=',
      'Survives when',
      'Between rounds',
      'Each round runs these phases',
      'Pass to /feature-review',
      'Run /feature-review once for each',
    ])
      if (text.includes(marker)) found.push(`(c) the review is skipped but the text has "${marker}"`)
    if (/^ +rounds: \d/m.test(text)) found.push('(c) the review is skipped but the text has a round count')
    if (!/^- Review - skipped/m.test(text))
      found.push('(c) the review is skipped but is not listed as skipped')
  }

  // (d) A file named as an input is written by an earlier step, or the text names the fallback.
  const secs = sections(text)
  const writers: Record<string, WorkflowStepId[]> = {
    '01-spec.md': ['spec', 'spec2'],
    '01-spec-2.md': ['spec2'],
  }
  const labelOf = (id: WorkflowStepId) => WORKFLOW_STEPS[id].label
  for (const sec of secs) {
    for (const [file, by] of Object.entries(writers)) {
      const re = new RegExp('`?(?:WORKDIR/)?' + file.replace(/[.-]/g, '\\$&') + '`?', 'g')
      for (const m of sec.body.matchAll(re)) {
        const around = flat(sec.body.slice(Math.max(0, m.index! - 120), m.index! + 120))
        if (/\bno `?(WORKDIR\/)?01-spec|there is no|when there is one|in place of|is skipped/i.test(around))
          continue
        const mine = by.some((id) => labelOf(id) === sec.label)
        const earlier = secs.some((o) => o.number < sec.number && by.some((id) => labelOf(id) === o.label))
        if (!mine && !earlier)
          found.push(`(d) ${sec.label} reads ${file} but no earlier step writes it: ...${around}...`)
      }
    }
  }

  // (e) A step that is said to come "later" or "earlier" in the order does, in this order, relative to the
  // step whose section says it.
  const stepOfLabel = (label: string) =>
    w.steps.find((st) => label === st.label || label.startsWith(`${st.label} `))
  for (const sec of secs) {
    const here = stepOfLabel(sec.label)
    if (!here) continue
    for (const m of flat(sec.body).matchAll(/the (\w+) step[^.]{0,40}?\b(later|earlier)\b/gi)) {
      const named = w.steps.find((st) => st.id === m[1]!.toLowerCase())
      if (!named || named.skipped) continue
      const later = named.position > here.position
      if ((m[2]!.toLowerCase() === 'later') !== later)
        found.push(`(e) ${here.id} says the ${named.id} step is ${m[2]} in the order, but it is not: ${m[0]}`)
    }
  }
  return found
}

describe('the served workflow text for every preset, complexity and tweak', () => {
  it('has no step required that the same text lists as skipped (matrix)', () => {
    let rendered = 0
    const problems: string[] = []
    for (const preset of WORKFLOW_PRESETS) {
      for (const complexity of COMPLEXITIES as readonly Complexity[]) {
        for (const combo of combos(preset)) {
          const workflow = resolveWorkflow(preset, combo.tweak, complexity)
          const text = render(workflow)
          rendered++
          for (const problem of inconsistencies(workflow, text))
            problems.push(`${preset}/${complexity}/${combo.name}: ${problem}`)
        }
      }
    }
    // Four presets by four complexities by the tweak sets above.
    expect(rendered).toBeGreaterThan(500)
    const unique = [...new Set(problems.map((p) => p.replace(/^[^:]*: /, '')))]
    expect(unique).toEqual([])
  })

  it('has every step whose procedure carries a condition read it: no tag is left in any text', () => {
    for (const preset of WORKFLOW_PRESETS)
      for (const complexity of COMPLEXITIES)
        for (const combo of combos(preset)) {
          const text = render(resolveWorkflow(preset, combo.tweak, complexity))
          expect(text, `${preset}/${complexity}/${combo.name}`).not.toMatch(/\{\{|\}\}/)
          expect(text, `${preset}/${complexity}/${combo.name}`).not.toMatch(/\n{3,}/)
        }
  })

  it('drops the round-end intent check from the Thorough and Maximum review when the intent step is off for a low ticket (C1)', () => {
    const tweak = { rounds: { low: 1 }, steps: off('intent') }
    for (const preset of ['thorough', 'maximum'] as const) {
      const low = resolveWorkflow(preset, tweak, 'low')
      const review = low.steps.find((s) => s.id === 'review')!
      expect(review.skipped, preset).toBeNull()
      expect(review.review!.rounds).toBe(1)
      expect(JSON.stringify(review.review!.phases)).not.toContain('review.intent')
      expect(review.review!.survival).not.toContain('intent')
      const text = flat(render(low))
      expect(text, preset).toContain(
        '- Intent check - skipped: turned off for low tickets on the Workflow page',
      )
      expect(text, preset).not.toContain('intent check at the end of')
      expect(text, preset).not.toContain('Only after the intent check')
      expect(text, preset).toContain('adds one thing to every round')
      // The same switch changes nothing for a ticket above low: the check is locked there.
      const mid = resolveWorkflow(preset, tweak, 'mid')
      expect(JSON.stringify(mid.steps.find((s) => s.id === 'review')!.review!.phases)).toContain(
        'review.intent',
      )
      expect(flat(render(mid))).toContain('and the intent check at the end of the round matches')
    }
    // A low ticket that keeps the check has it at the end of its round.
    const kept = resolveWorkflow('thorough', { rounds: { low: 1 } }, 'low')
    expect(flat(render(kept))).toContain('the intent check at the end of the round matches')
  })

  it('has the intent hand-off of a ticket with no review go back to the builder and the gate, then the check again (C3)', () => {
    for (const preset of WORKFLOW_PRESETS)
      for (const complexity of ['low', 'mid'] as const) {
        const w = resolveWorkflow(
          preset,
          complexity === 'mid' ? { rounds: { mid: 0 } } : undefined,
          complexity,
        )
        const intent = w.steps.find((s) => s.id === 'intent')!
        expect(intent.handoff, `${preset}/${complexity}`).toContain(
          'goes back to the builder and the gate, then the check again',
        )
        expect(intent.handoff).not.toMatch(/review/)
      }
    // With a review the preset's own line stands.
    expect(
      resolveWorkflow('thorough', undefined, 'mid').steps.find((s) => s.id === 'intent')!.handoff,
    ).toContain('an ordinary round of the budget in this workflow')
    expect(
      resolveWorkflow('standard', undefined, 'mid').steps.find((s) => s.id === 'intent')!.handoff,
    ).toContain('one more review, outside the round budget')
  })

  it('gives the second spec the spec itself to write when the first spec is off', () => {
    const text = flat(render(resolveWorkflow('maximum', { steps: off('spec') }, 'mid')))
    expect(text).toContain('- Spec - skipped: turned off on the Workflow page')
    expect(text).toContain('this is the only spec: there is no first spec to reconcile with')
    expect(text).not.toContain('Reconcile them yourself')
    // Its own Does and Hand-off lines follow the flow state too: it is the only spec, nothing is reconciled.
    const second = resolveWorkflow('maximum', { steps: off('spec') }, 'mid').steps.find(
      (st) => st.id === 'spec2',
    )!
    expect(second.what).toContain("writes the ticket's only spec from the ticket alone, to `01-spec.md`")
    expect(second.what).toContain('with nothing to merge')
    expect(second.handoff).toContain('Its spec is the one the builder gets')
    for (const line of [second.what, second.handoff])
      expect(line).not.toMatch(/reconcile|merge the two|first/i)
    expect(second.handoffDefault).toBe(second.handoff)
    // With the Spec step on, the catalogue's own lines (two specs, reconciled) stand.
    const both = resolveWorkflow('maximum', undefined, 'mid').steps.find((st) => st.id === 'spec2')!
    expect(both.what).toBe(WORKFLOW_STEPS.spec2.what)
    expect(both.handoff).toBe(WORKFLOW_STEPS.spec2.handoff)
    // Both on: the two are reconciled.
    expect(flat(render(resolveWorkflow('maximum', undefined, 'mid')))).toContain('Reconcile them yourself')
  })

  it('says nothing of the preview step being later in the order when it comes first, and has the intent check see a preview of its own head (C2)', () => {
    const intentOf = (text: string) => flat(text.slice(text.indexOf('Intent check')))
    for (const preset of WORKFLOW_PRESETS) {
      for (const [name, order] of [
        ['preview after review', undefined],
        ['preview before review', previewBeforeReview(preset)],
      ] as const) {
        const w = resolveWorkflow(preset, order ? { order } : undefined, 'mid')
        const heads = w.steps.map((st) => st.id)
        expect(heads.indexOf('preview') < heads.indexOf('review'), `${preset}/${name}`).toBe(
          order !== undefined,
        )
        const text = flat(render(w))
        expect(text, `${preset}/${name}`).not.toMatch(/preview step[^.]{0,30}\b(later|earlier)\b/i)
        // The first intent run and every re-run find a preview that runs for the head they check.
        expect(intentOf(render(w)), `${preset}/${name}`).toContain(
          'The intent check always runs against a preview of the head it checks. Before the first intent run and before every re-run',
        )
        expect(intentOf(render(w)), `${preset}/${name}`).toContain(
          "whatever the preview step's place in the order",
        )
        if (preset === 'thorough' || preset === 'maximum') {
          expect(text, `${preset}/${name}`).toContain(
            '**The preview comes first:** in a round where no preview',
          )
          expect(text, `${preset}/${name}`).toContain(
            "whatever the preview step's place in the order, a fix commit changes the head",
          )
        }
      }
      // With the preview off, nothing asks for one.
      const none = flat(render(resolveWorkflow(preset, { steps: off('preview') }, 'mid')))
      expect(none, preset).not.toContain('The intent check always runs against a preview')
    }
  })

  it('has a turned-off preview leave the screenshots to the review, in the summary, the hand-off and the intent brief (C3)', () => {
    for (const preset of WORKFLOW_PRESETS)
      for (const complexity of ['low', 'mid'] as const) {
        const on = flat(render(resolveWorkflow(preset, undefined, complexity)))
        const text = flat(render(resolveWorkflow(preset, { steps: off('preview') }, complexity)))
        const at = `${preset}/${complexity}`
        // The summary: the screenshots are the review's own and it says the preview was turned off.
        expect(text, at).toContain(
          "the screenshots of a UI change in `files`, which come from the review's own run (its `shots/` folder, the verify phase)",
        )
        expect(text, at).toContain('the summary says the preview was turned off on the Workflow page')
        // The hand-off checklist.
        expect(text, at).toContain(
          "With the preview turned off, the screenshots of a UI change are the review's own (`shots/`, the verify phase)",
        )
        // The intent brief.
        expect(text, at).toContain("the screenshots of a UI change come from the review's own run")
        // With the preview on, none of it is said.
        expect(on, at).not.toContain("which come from the review's own run")
        expect(on, at).not.toContain('With the preview turned off')
      }
    // A ticket with no review has none of the review's screenshots to name as a source.
    const low = flat(render(resolveWorkflow('standard', { steps: off('preview') }, 'low')))
    expect(low).toContain('if it took any (this ticket has no review)')
  })

  it('reads the conditions of a procedure: if, else, not, nested, and refuses a broken one', () => {
    const flow = {
      spec: true,
      firstSpec: true,
      tests: false,
      review: true,
      roundIntent: false,
      preview: true,
      intent: true,
      ci: false,
    }
    expect(applyFlow('a {{if ci}}b{{else}}c{{end}} d', flow)).toBe('a c d')
    expect(applyFlow('a {{if !ci}}b{{end}}', flow)).toBe('a b')
    expect(applyFlow('{{if intent}}x {{if roundIntent}}y{{else}}z{{end}}{{end}}', flow)).toBe('x z')
    expect(applyFlow('{{if tests}}{{if intent}}x{{end}}{{else}}no{{end}}', flow)).toBe('no')
    // A tag alone on its line takes its line break: no blank line is left.
    expect(applyFlow('one\n{{if ci}}\ntwo\n{{end}}\nthree', flow)).toBe('one\nthree')
    expect(() => applyFlow('{{if nonsense}}x{{end}}', flow)).toThrow(/unknown condition "nonsense"/)
    expect(() => applyFlow('{{if ci}}x', flow)).toThrow(/never closed/)
    expect(() => applyFlow('x{{end}}', flow)).toThrow(/stray/)
  })
})
