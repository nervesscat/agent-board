import type { TFunction } from 'i18next'

import { shared } from '#/i18n'

/**
 * Run reports: what a subagent records about how it did its run, before it hands back
 * (src/server/runReports.ts stores them; the templates ship under src/server/skill/review/run-reports).
 *
 * A report has structured fields wherever a value is compared or counted — times, counts, ratings, a
 * boolean per prescribed step — and named prose sections for everything else (RUN_REPORT_SECTIONS, then
 * the sections of that agent).
 */

/** The default subagents that write one report per run. The orchestrator writes none. */
export const RUN_REPORT_AGENTS = [
  'spec',
  'builder',
  'runner',
  'env',
  'verify',
  'hunt',
  'refute',
  'merge',
  'intent',
] as const
export type RunReportAgent = (typeof RUN_REPORT_AGENTS)[number]

/** A step of the agent's prescribed procedure: whether it was done, and what happened ('' when none). */
export type RunReportStep = { name: string; done: boolean; note: string }

/** Where the run's time went, in milliseconds. Free of prose, so a run's parts can be added up. */
export type RunReportTime = {
  readingMs: number
  runningMs: number
  waitingMs: number
  writingMs: number
  otherMs: number
}
export const RUN_REPORT_TIME_KEYS = ['readingMs', 'runningMs', 'waitingMs', 'writingMs', 'otherMs'] as const

/**
 * How a run's duration was obtained: measured on the work timeline, the agent's own estimate, or
 * neither (a report with no timing says nothing about how long the run took).
 */
export type RunReportDurationSource = 'measured' | 'self' | 'unknown'

/** What every template's report carries as prose, whatever the agent. */
export const RUN_REPORT_SECTIONS = [
  'brief',
  'readRan',
  'problems',
  'gaps',
  'moreTime',
  'improvements',
] as const

/** The prose sections each default agent adds to the common ones. */
export const AGENT_SECTIONS: Record<RunReportAgent, readonly string[]> = {
  spec: ['intent', 'inferences', 'questions'],
  builder: ['approach', 'alternatives', 'selfTests', 'fixPass'],
  runner: ['scheduling', 'judging'],
  env: ['provisioning', 'freshness'],
  verify: ['evidence', 'unexercised'],
  hunt: ['techniques', 'surfaces', 'candidates'],
  refute: ['disproof', 'unsettled'],
  merge: ['conflicts'],
  intent: ['asked', 'compared'],
}

const SECTION_KEYS = [
  'brief',
  'readRan',
  'problems',
  'gaps',
  'moreTime',
  'improvements',
  'intent',
  'inferences',
  'questions',
  'approach',
  'alternatives',
  'selfTests',
  'fixPass',
  'scheduling',
  'judging',
  'provisioning',
  'freshness',
  'evidence',
  'unexercised',
  'techniques',
  'surfaces',
  'candidates',
  'disproof',
  'unsettled',
  'asked',
  'compared',
  'conflicts',
] as const

/** A section key as the board shows it. An unknown key is spelled out as it is. */
export const runReportSectionLabel = (key: string, t: TFunction = shared.t): string =>
  ((SECTION_KEYS as readonly string[]).includes(key)
    ? t(`runReport.section.${key as (typeof SECTION_KEYS)[number]}`)
    : undefined) ??
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .replace(/^./, (c) => c.toUpperCase())

/** The sections a report of this agent should carry: the common ones, then its own. */
export function sectionsForAgent(agent: string): string[] {
  const kind = agent.trim().toLowerCase().split('/').at(-1) ?? ''
  const own = (AGENT_SECTIONS as Record<string, readonly string[]>)[kind] ?? []
  return [...RUN_REPORT_SECTIONS, ...own]
}

/** A run report as the API returns it (a run_reports row). */
export interface RunReport {
  id: number
  projectId: number
  ticketId: number
  /** The kind of run that wrote it: one of RUN_REPORT_AGENTS, or a project agent's name. */
  agent: string
  /** The review round it belongs to; null on a run outside a review. */
  round: number | null
  branch: string
  headSha: string
  model: string
  effort: string
  /** The agent that briefed it ('' when unknown). */
  briefedBy: string
  startedAt: string | null
  endedAt: string | null
  /** The duration the report reads back: measured on the work timeline when one covers the run. */
  durationMs: number
  durationSource: RunReportDurationSource
  /** The agent's own estimate, kept beside the measured duration (null when it gave none). */
  reportedDurationMs: number | null
  time: RunReportTime
  /** The agent's own rating 1–5 of the run's difficulty and of its confidence in the result. */
  difficulty: number | null
  confidence: number | null
  steps: RunReportStep[]
  counts: Record<string, number>
  sections: Record<string, string>
  author: string
  createdAt: string
}

/** A report in a list, with the ticket it is on (the project's list reads across tickets). */
export interface RunReportRow extends RunReport {
  ticketTitle: string
}
