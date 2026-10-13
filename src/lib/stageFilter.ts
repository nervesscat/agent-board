import type { StageLike } from './stages'

/**
 * The stage filter's value for every stage. No stage key can be it: a key is a slug of the stage's
 * name with no leading underscore (`newKey` in src/server/stages.ts).
 */
export const ALL_STAGES = '_all'

/** Whether a value is one the filter offers: every stage, or one of the project's stages by key. */
export const isStageFilter = (stages: StageLike[], value: string | null | undefined): value is string =>
  value === ALL_STAGES || stages.some((s) => s.key === value)

/** The filter a page starts on: the project's first stage of kind review, else every stage. */
export const defaultStageFilter = (stages: StageLike[]) =>
  stages.find((s) => s.kind === 'review')?.key ?? ALL_STAGES

/**
 * The filter that shows: the one in the URL while the project has that stage, else the one this
 * browser remembers if the project still has it, else the default. A stage since removed (or a made-up
 * key) counts as none.
 */
export function resolveStageFilter(
  stages: StageLike[],
  inUrl: string | undefined,
  remembered: string | null | undefined,
): string {
  if (isStageFilter(stages, inUrl)) return inUrl
  if (isStageFilter(stages, remembered)) return remembered
  return defaultStageFilter(stages)
}

/** Whether a ticket in stage `status` shows under the filter. */
export const inStageFilter = (filter: string, status: string) => filter === ALL_STAGES || status === filter

/**
 * How many rows each status holds, and every row under ALL_STAGES. A status no stage has any more is
 * no option of the filter: its rows show, and count, under every stage only. A Map, as a stage key can
 * be any slug, `constructor` included, which a plain object would read from its prototype.
 */
export function countByStage(statuses: string[]): Map<string, number> {
  const counts = new Map([[ALL_STAGES, statuses.length]])
  for (const s of statuses) counts.set(s, (counts.get(s) ?? 0) + 1)
  return counts
}

/** What `?stage=` holds once the router has read it: it JSON-parses a value, so `2026` is a number. */
export type StageInSearch = string | number | boolean | null | undefined

/**
 * The stage key `?stage=` names. The router JSON-parses search values, so a key such as `2026`, `1e3`,
 * `true` or `null`, written by hand without quotes, arrives as a number, a boolean or null: it names
 * the project's stage whose key parses to it (the app writes such a key quoted, which arrives as the
 * key itself).
 */
export function stageInSearch(stages: StageLike[], value: StageInSearch): string | undefined {
  if (value === undefined || typeof value === 'string') return value
  return stages.find((s) => parsesTo(s.key, value))?.key ?? String(value)
}

function parsesTo(key: string, value: number | boolean | null) {
  try {
    return JSON.parse(key) === value
  } catch {
    return false
  }
}
