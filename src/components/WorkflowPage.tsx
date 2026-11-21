import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronsDownUp, ChevronsUpDown, RotateCcw } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Empty } from '#/components/Empty'
import { ComplexityPicker, PresetSwitcher } from '#/components/WorkflowPresets'
import { WhatAgentsRead, readsKey } from '#/components/WorkflowReads'
import { WorkflowTree, type WorkflowEdits } from '#/components/WorkflowTree'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '#/components/ui/alert-dialog'
import { Button } from '#/components/ui/button'
import { Skeleton } from '#/components/ui/skeleton'
import { del, errorMessage, get, put, type WorkflowOverview } from '#/lib/api'
import type { Complexity } from '#/lib/constants'
import { type PresetTweak, type WorkflowPresetId, moveStep, resolveWorkflow } from '#/lib/workflow'
import {
  tweakBody,
  withEffort,
  withEnabled,
  withInstructions,
  withOrder,
  withRounds,
} from '#/lib/workflowEdit'
import { COMPLEXITY_NAMES, expandableIds, roundsText } from '#/lib/workflowView'

/** The project's workflow: the overview of every preset, read once and kept as each change answers with the new one. */
const overviewKey = (projectId: string) => ['workflow', projectId] as const

/**
 * The Workflow page: the four presets, and the one shown as a tree of the steps a ticket's agent runs, with the
 * order, what runs, each agent's effort, the hand-off instructions and the review rounds editable on it. The
 * complexity picked decides what the tree shows (a low ticket skips steps and gets no review). Every change
 * saves at once, one after another, each built on what the last one saved.
 */
export function WorkflowPage({
  projectId,
  preset: pickedPreset,
  complexity,
  onView,
  onComplexity,
}: {
  projectId: string
  /** The preset shown; the project's active one when none is picked. */
  preset: WorkflowPresetId | undefined
  complexity: Complexity
  onView: (preset: WorkflowPresetId) => void
  onComplexity: (level: Complexity) => void
}) {
  const qc = useQueryClient()
  const key = overviewKey(projectId)
  const { data, error } = useQuery({
    queryKey: key,
    queryFn: () => get<WorkflowOverview>(`/api/projects/${projectId}/workflow`),
  })
  // Saves wait for each other: the next is built from what the one before it saved, never from older data.
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  // The answer is the reason a save failed, or null once it was kept: an editor stays open on a refusal.
  const run = (job: () => Promise<WorkflowOverview>, message = 'Saved') => {
    const next = queue.current.then(job).then(
      (overview): string | null => {
        qc.setQueryData(key, overview)
        qc.invalidateQueries({ queryKey: readsKey(projectId) })
        qc.invalidateQueries({ queryKey: ['project', projectId] })
        toast.success(message)
        return null
      },
      (err): string | null => {
        toast.error(errorMessage(err))
        qc.invalidateQueries({ queryKey: key })
        return errorMessage(err)
      },
    )
    queue.current = next
    return next
  }
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [confirmingReset, setConfirmingReset] = useState(false)

  const active = data?.active
  const viewed = pickedPreset ?? active
  const current = data?.presets.find((p) => p.id === viewed)
  // The tree is the preset and its saved tweaks resolved for the complexity: the board's own function.
  const workflow = useMemo(
    () => (current ? resolveWorkflow(current.id, current.tweaks, complexity) : null),
    [current, complexity],
  )
  if (error) return <Empty>{errorMessage(error)}</Empty>
  if (!data || !current || !workflow || !viewed) return <WorkflowSkeleton />

  /** The preset's tweak as the last save left it, changed by `build`, saved in place of it. */
  const edit = (build: (tweak: PresetTweak | null) => PresetTweak) =>
    run(() => {
      const latest = qc.getQueryData<WorkflowOverview>(key)?.presets.find((p) => p.id === viewed)
      return put<WorkflowOverview>(
        `/api/projects/${projectId}/workflow/${viewed}`,
        tweakBody(build(latest?.tweaks ?? null)),
      )
    })
  const edits: WorkflowEdits = {
    setEnabled: (id, enabled) => edit((t) => withEnabled(t, id, enabled)),
    setEffort: (id, effort) => edit((t) => withEffort(t, id, effort)),
    setInstructions: (id, text) => edit((t) => withInstructions(t, id, text)),
    setRounds: (level, rounds) => edit((t) => withRounds(t, level, rounds)),
    move: (id, direction) =>
      edit((t) => {
        const moved = moveStep(viewed, resolveWorkflow(viewed, t, null).order, id, direction)
        if (!moved.ok) throw new Error(moved.reason)
        return withOrder(t, moved.order)
      }),
  }
  const makeActive = () =>
    run(() => put<WorkflowOverview>(`/api/projects/${projectId}/workflow`, { preset: viewed }), 'Saved')
  const reset = () =>
    run(() => del<WorkflowOverview>(`/api/projects/${projectId}/workflow/${viewed}`), 'Reset')
  const isActive = viewed === active
  const expandable = expandableIds(workflow)
  const allOpen = expandable.every((id) => !collapsed.has(id))
  const rounds = workflow.rounds[complexity]

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Workflow</h1>
        <p className="text-sm text-muted-foreground">
          How a ticket goes from To do to hand-off: the steps its agent runs, in order, who runs each and what
          each hands to the next. The project follows one workflow; a ticket can name another on its page. The
          agents read it from the board, so a change here is followed from their next run.
        </p>
      </div>

      <PresetSwitcher presets={data.presets} active={data.active} viewed={viewed} onView={onView} />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <ComplexityPicker value={complexity} onChange={onComplexity} />
        <span className="text-xs text-muted-foreground">
          The tree shows a {COMPLEXITY_NAMES[complexity].toLowerCase()} ticket.
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {isActive ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Check className="size-3.5" aria-hidden /> The project follows this workflow
            </span>
          ) : (
            <Button type="button" size="sm" onClick={makeActive}>
              <Check data-icon="inline-start" /> Use this workflow
            </Button>
          )}
          <AlertDialog open={confirmingReset} onOpenChange={setConfirmingReset}>
            <AlertDialogTrigger
              render={<Button type="button" variant="outline" size="sm" disabled={!current.tweaked} />}
            >
              <RotateCcw data-icon="inline-start" /> Reset this workflow
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Reset the {current.label} workflow?</AlertDialogTitle>
                <AlertDialogDescription>
                  Its order, switches, efforts, hand-off instructions and review rounds go back to what the{' '}
                  {current.label} preset ships with. The other presets keep what was changed in them.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    setConfirmingReset(false)
                    reset()
                  }}
                >
                  Reset
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <section aria-label={`${current.label} workflow`} className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="text-base font-semibold">
            {current.label}
            {isActive && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">the project&apos;s</span>
            )}
          </h2>
          <p className="text-xs text-muted-foreground" data-summary>
            {workflow.numbered} steps for a {COMPLEXITY_NAMES[complexity].toLowerCase()} ticket · review:{' '}
            {roundsText(rounds)}
          </p>
          {expandable.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="ml-auto"
              onClick={() => setCollapsed(allOpen ? new Set(expandable) : new Set())}
            >
              {allOpen ? (
                <>
                  <ChevronsDownUp data-icon="inline-start" /> Collapse all
                </>
              ) : (
                <>
                  <ChevronsUpDown data-icon="inline-start" /> Expand all
                </>
              )}
            </Button>
          )}
        </div>
        <WorkflowTree
          workflow={workflow}
          edits={edits}
          collapsed={collapsed}
          onToggle={(id) =>
            setCollapsed((c) => {
              const next = new Set(c)
              if (!next.delete(id)) next.add(id)
              return next
            })
          }
        />
      </section>

      <WhatAgentsRead projectId={projectId} preset={current.id} complexity={complexity} />
    </div>
  )
}

function WorkflowSkeleton() {
  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-96" />
    </div>
  )
}
