import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Info, RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'

import { Empty } from '#/components/Empty'
import {
  AddStepSelect,
  DeleteWorkflowButton,
  NewWorkflowDialog,
  RenameWorkflowDialog,
} from '#/components/WorkflowCustom'
import { ComplexityPicker, PresetSwitcher } from '#/components/WorkflowPresets'
import { WhatAgentsRead, readsKey } from '#/components/WorkflowReads'
import { WorkflowGraph } from '#/components/WorkflowGraph'
import { IdlePanel, SheetPanel, SidePanel, type WorkflowEdits } from '#/components/WorkflowPanel'
import type { RoundsFlight } from '#/components/WorkflowReview'
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
import { del, errorMessage, get, patch, post, put, type WorkflowOverview } from '#/lib/api'
import type { Complexity } from '#/lib/constants'
import {
  WORKFLOW_PRESET_DEFS,
  addStep,
  addableSteps,
  customSource,
  moveStep,
  removeStep,
  resolveWorkflow,
  type PresetTweak,
  type WorkflowRef,
} from '#/lib/workflow'
import {
  tweakBody,
  withEffort,
  withEnabled,
  withAgent,
  withOrder,
  withRounds,
  withoutStep,
} from '#/lib/workflowEdit'
import { findNode } from '#/lib/workflowGraph'
import { COMPLEXITY_NAMES, reviewHeaderText } from '#/lib/workflowView'

/** The project's workflow: the overview of every preset, read once and kept as each change answers with the new one. */
const overviewKey = (projectId: string) => ['workflow', projectId] as const

type Entry = WorkflowOverview['presets'][number]

/** What the model resolves an entry of the overview from: its preset's id, or a custom workflow's source. */
const refOf = (entry: Entry): WorkflowRef =>
  entry.custom
    ? customSource({
        id: entry.id,
        name: entry.label,
        base: entry.custom.base,
        seed: { order: entry.defaultOrder },
      })
    : (entry.id as WorkflowRef)

/** Whether the page is wide enough for the settings to sit beside the graph (else they open as a sheet over it). */
const WIDE = '(min-width: 1024px)'
function useWide(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(WIDE)
      query.addEventListener('change', notify)
      return () => query.removeEventListener('change', notify)
    },
    () => window.matchMedia(WIDE).matches,
    () => true,
  )
}

/**
 * The Workflow page: the four presets, and the one shown as a vertical graph of the steps a ticket's agent runs.
 * A node opens its settings beside the graph (a sheet on a phone): the Team agent of each node, and of a step
 * its effort, switch and place in the order, of the review its round counts. The complexity picked decides what
 * the graph shows (a low ticket skips steps and gets no review). Every change saves at once, one after another,
 * each built on what the last one saved.
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
  preset: string | undefined
  complexity: Complexity
  onView: (preset: string) => void
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
  const run = (
    job: () => Promise<WorkflowOverview & { created?: string }>,
    message = 'Saved',
    after?: (overview: WorkflowOverview & { created?: string }) => void,
  ) => {
    const next = queue.current.then(job).then(
      (overview): string | null => {
        qc.setQueryData(key, overview)
        qc.invalidateQueries({ queryKey: readsKey(projectId) })
        qc.invalidateQueries({ queryKey: ['project', projectId] })
        toast.success(message)
        after?.(overview)
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
  const [confirmingReset, setConfirmingReset] = useState(false)
  // The node whose settings are open, and a count that moves the focus into them when the keyboard chose it: 0 for
  // a node chosen with the mouse, so only the selection that asked for the focus gets it.
  const [selected, setSelected] = useState<string | null>(null)
  const [focusToken, setFocusToken] = useState(0)
  const wide = useWide()
  // The rounds being saved, per preset and level: the fields are made again when the node or the preset changes,
  // and the count sent but not yet answered must outlive them.
  const flights = useRef(new Map<string, RoundsFlight>())

  const active = data?.active
  // A workflow named in the link that the project does not have (deleted, or never there) shows the project's own.
  const missing =
    pickedPreset !== undefined && data !== undefined && !data.presets.some((p) => p.id === pickedPreset)
  const viewed = missing ? active : (pickedPreset ?? active)
  const current = data?.presets.find((p) => p.id === viewed)
  // The graph is the workflow and its saved tweaks resolved for the complexity: the board's own function.
  const workflow = useMemo(
    () => (current ? resolveWorkflow(refOf(current), current.tweaks, complexity, data?.team) : null),
    [current, complexity, data?.team],
  )
  const node = workflow ? findNode(workflow, selected) : null
  // A node another preset does not have is not selected any more.
  const gone = selected !== null && workflow !== null && node === null
  useEffect(() => {
    if (gone) setSelected(null)
  }, [gone])
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
  // The steps the workflow has with `t` saved on it, in order.
  const stepsOf = (t: PresetTweak | null) => resolveWorkflow(refOf(current), t, null).order
  const edits: WorkflowEdits = {
    setEnabled: (id, enabled) => edit((t) => withEnabled(t, id, enabled)),
    setEffort: (id, effort) => edit((t) => withEffort(t, id, effort)),
    setAgent: (nodeId, agent) => edit((t) => withAgent(t, nodeId, agent)),
    setRounds: (level, rounds) => edit((t) => withRounds(t, level, rounds)),
    move: (id, direction) =>
      edit((t) => {
        const moved = moveStep(refOf(current), stepsOf(t), id, direction)
        if (!moved.ok) throw new Error(moved.reason)
        return withOrder(t, moved.order)
      }),
    // Only a custom workflow has steps to take out.
    remove: current.custom
      ? (id) =>
          edit((t) => {
            const next = removeStep(stepsOf(t), id)
            if (!next.ok) throw new Error(next.reason)
            return withoutStep(t, id, next.order)
          })
      : undefined,
  }
  // A kind of step the custom workflow lacks put in, where the order allows it.
  const addKind = (id: string) =>
    edit((t) => {
      const next = addStep(stepsOf(t), id)
      if (!next.ok) throw new Error(next.reason)
      return withOrder(t, next.order)
    })
  const create = async (name: string, from: string) => {
    return run(
      () =>
        post<WorkflowOverview & { created: string }>(`/api/projects/${projectId}/workflow/custom`, {
          name,
          from,
        }),
      'Workflow created',
      (overview) => overview.created && onView(overview.created),
    )
  }
  const rename = (name: string) =>
    run(
      () => patch<WorkflowOverview>(`/api/projects/${projectId}/workflow/custom/${viewed}`, { name }),
      'Renamed',
    )
  const removeWorkflow = () =>
    run(
      () => del<WorkflowOverview>(`/api/projects/${projectId}/workflow/custom/${viewed}`),
      'Workflow deleted',
      (overview) => onView(overview.active),
    )
  const makeActive = () =>
    run(() => put<WorkflowOverview>(`/api/projects/${projectId}/workflow`, { preset: viewed }), 'Saved')
  // The project's workflow is stored as Standard, so a pick that was deleted is not read as one any more.
  const keepStandard = () =>
    run(() => put<WorkflowOverview>(`/api/projects/${projectId}/workflow`, { preset: 'standard' }), 'Saved')
  const reset = () =>
    run(() => del<WorkflowOverview>(`/api/projects/${projectId}/workflow/${viewed}`), 'Reset')
  const isActive = viewed === active
  const rounds = workflow.rounds[complexity]
  const flightOf = (level: Complexity) => {
    const flightKey = `${workflow.preset}:${level}`
    let flight = flights.current.get(flightKey)
    if (!flight) flights.current.set(flightKey, (flight = { sent: null, pending: 0 }))
    return flight
  }
  const select = (id: string, byKeyboard: boolean) => {
    setSelected(id)
    setFocusToken((t) => (byKeyboard ? t + 1 : 0))
  }
  const close = () => {
    const id = selected
    // Closed from inside the panel, the focus goes back to the node; a sheet does that itself.
    const inside = wide && document.activeElement?.closest('[data-panel="side"]') != null
    setSelected(null)
    if (inside)
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-step="${id}"]`)?.focus())
  }
  const panel = node && {
    workflow,
    team: data.team,
    node,
    edits,
    flightOf,
    onClose: close,
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Workflow</h1>
        <p className="text-sm text-muted-foreground">
          How a ticket goes from To do to hand-off: the steps its agent runs, in order, who runs each and what
          each hands to the next. The project follows one workflow; a ticket can name another on its page. The
          agents read it from the board, so a change here is followed from their next run.
        </p>
      </div>

      {(data.fellBack || missing) && (
        <p
          data-workflow-notice
          role="status"
          className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200"
        >
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="flex-1">
            {data.fellBack
              ? `The workflow this project followed was deleted, so it follows ${WORKFLOW_PRESET_DEFS.standard.label} now. Tickets that named it follow the project's workflow. Keep ${WORKFLOW_PRESET_DEFS.standard.label} to dismiss this, or pick another workflow below and press Use this workflow.`
              : "That workflow is not one of this project's (it may have been deleted), so the project's own is shown."}
          </span>
          {data.fellBack && (
            <Button type="button" size="sm" variant="outline" data-keep-standard onClick={keepStandard}>
              Keep {WORKFLOW_PRESET_DEFS.standard.label}
            </Button>
          )}
        </p>
      )}

      <PresetSwitcher
        presets={data.presets}
        active={data.active}
        viewed={viewed}
        onView={onView}
        extra={
          <NewWorkflowDialog
            choices={data.presets.map((p) => ({ id: p.id, label: p.label }))}
            from={viewed}
            onCreate={create}
          />
        }
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <ComplexityPicker value={complexity} onChange={onComplexity} />
        <span className="text-xs text-muted-foreground">
          The graph shows a {COMPLEXITY_NAMES[complexity].toLowerCase()} ticket.
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
          {current.custom && <RenameWorkflowDialog name={current.label} onRename={rename} />}
          {current.custom && <DeleteWorkflowButton name={current.label} onDelete={removeWorkflow} />}
          <AlertDialog open={confirmingReset} onOpenChange={setConfirmingReset}>
            <AlertDialogTrigger
              render={<Button type="button" variant="outline" size="sm" disabled={!current.tweaked} />}
            >
              <RotateCcw data-icon="inline-start" /> Reset this workflow
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle className="wrap-anywhere">
                  Reset the {current.label} workflow?
                </AlertDialogTitle>
                <AlertDialogDescription className="wrap-anywhere">
                  {current.custom
                    ? `Its steps, order, switches, efforts, Team agents and review rounds go back to how the ${current.label} workflow was made. Its name stays and the other workflows keep what was changed in them.`
                    : `Its order, switches, efforts, Team agents and review rounds go back to what the ${current.label} preset ships with. The other presets keep what was changed in them.`}
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
          <h2 className="text-base font-semibold wrap-anywhere">
            {current.label}
            {isActive && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">the project&apos;s</span>
            )}
          </h2>
          <p className="text-xs text-muted-foreground" data-summary>
            {workflow.numbered} steps for a {COMPLEXITY_NAMES[complexity].toLowerCase()} ticket ·{' '}
            {reviewHeaderText(workflow.order, rounds)}
          </p>
          {current.custom && (
            <div className="ml-auto w-full sm:w-auto">
              <AddStepSelect kinds={addableSteps(workflow.order)} onAdd={addKind} />
            </div>
          )}
        </div>
        {current.custom && (
          <p className="text-xs text-muted-foreground" data-custom-note>
            Your own workflow, copied from {WORKFLOW_PRESET_DEFS[current.custom.base].label}. Add steps of the
            kinds listed, remove the ones that are not locked, and move them within what each step allows. The
            review inside it (its phases and what they run) comes with{' '}
            {WORKFLOW_PRESET_DEFS[current.custom.base].label}.
          </p>
        )}
        <div
          className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]"
          // Escape closes the settings, unless a list open on top of them is the one it is meant for. Decided
          // as the key goes down, before a control under the settings takes it.
          onKeyDownCapture={(e) => {
            if (e.key === 'Escape' && wide && selected !== null && !listOpen()) close()
          }}
        >
          <div className="min-w-0 rounded-xl border bg-muted/20 bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:18px_18px] p-3 sm:p-4">
            <WorkflowGraph workflow={workflow} selected={node ? selected : null} onSelect={select} />
          </div>
          {wide && (
            <div className="sticky top-4 min-w-0">
              {panel ? <SidePanel {...panel} focusToken={focusToken} /> : <IdlePanel />}
            </div>
          )}
        </div>
        {!wide && panel && <SheetPanel {...panel} />}
      </section>

      <WhatAgentsRead projectId={projectId} preset={current.id} complexity={complexity} />
    </div>
  )
}

function WorkflowSkeleton() {
  return (
    <div className="max-w-6xl space-y-6">
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

/** Whether a list (a Select's options) is open on top of the page: its Escape closes it, not the settings. */
const listOpen = () => document.querySelector('[role="combobox"][aria-expanded="true"]') !== null
