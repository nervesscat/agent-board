import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { LayoutEditor } from '#/components/LayoutEditor'
import { ListInput } from '#/components/ListInput'
import { RunsSettings } from '#/components/RunsSettings'
import { StagesEditor } from '#/components/StagesEditor'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { errorMessage, patch } from '#/lib/api'
import { STALL_MINUTES } from '#/lib/constants'
import { useProject } from '#/lib/project'
import { useAnchor, useReveal } from '#/lib/reveal'
import { DEFAULT_TAG_SUGGESTIONS, cleanSuggestions } from '#/lib/tags'
import { addTasks } from '#/lib/tasks'

export const Route = createFileRoute('/projects/$id/settings')({
  // Old links into the instructions history (a bookmark, another page's link) follow the page there.
  beforeLoad: ({ location, params }) => {
    if (location.hash === 'instructions-history')
      throw redirect({
        to: '/projects/$id/instructions',
        params,
        hash: 'instructions-history',
        replace: true,
      })
  },
  component: Settings,
})

function Settings() {
  const { id } = Route.useParams()
  const navigate = Route.useNavigate()
  const { data: p } = useProject(id)
  const anchor = useAnchor()
  // A link into a section (#layout) lands on it on an in-app navigation too.
  useReveal(anchor, { page: id, ready: p !== undefined })
  // A page loaded afresh sends no fragment to the server, so `beforeLoad` cannot see this one: follow
  // an old #instructions-history link once the page runs.
  const oldHistory = anchor?.target === 'instructions-history'
  useEffect(() => {
    if (oldHistory)
      void navigate({
        to: '/projects/$id/instructions',
        params: { id },
        hash: 'instructions-history',
        replace: true,
      })
  }, [oldHistory, navigate, id])
  if (!p || oldHistory) return null
  return (
    <div className="space-y-10">
      <div className="max-w-3xl space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          How this project works: what new tickets start with, the tags it offers, when a ticket counts as
          stalled, its stages, its runs and what its pages show. Its agents&apos; instructions are on their
          own page.
        </p>
      </div>
      <DefaultPhases key={id} projectId={id} saved={p.defaultPhases} />
      <TagSuggestions key={`tags-${id}`} projectId={id} saved={p.tagSuggestions} />
      <StallMinutes key={`stall-${id}`} projectId={id} saved={p.stallMinutes} />
      <StagesEditor projectId={id} />
      <RunsSettings projectId={id} />
      <LayoutEditor key={`layout-${id}`} projectId={id} saved={p.layout} />
    </div>
  )
}

/**
 * The top-level phases every new ticket of the project starts with, in order: the list in effect
 * (the built-in one until it is changed). Emptying it seeds nothing; the built-in list can be had back.
 * Agents read it in `get_project` and change the phases per ticket.
 */
function DefaultPhases({ projectId, saved }: { projectId: string; saved: string[] }) {
  const qc = useQueryClient()
  const [items, setItems] = useState(saved)
  const [text, setText] = useState('')
  // What Save would store: the list with what is typed and not yet added.
  const phases = addTasks(items, text)
  const dirty = phases.join('\n') !== saved.join('\n')
  const save = useMutation({
    mutationFn: (defaultPhases: string[] | null) =>
      patch<{ defaultPhases: string[] }>(`/api/projects/${projectId}`, { defaultPhases }),
    onSuccess: async (row) => {
      setItems(row.defaultPhases)
      setText('')
      await qc.invalidateQueries({ queryKey: ['project', projectId] })
      toast.success('Saved')
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <section id="default-phases" aria-label="Default phases" className="max-w-3xl scroll-mt-16 space-y-3">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Default phases</h2>
        <p className="text-sm text-muted-foreground">
          The top-level tasks every new ticket starts with, in order. The tasks given when it is created go
          under the first; a lane starts without them. Agents tick each as they finish it, and remove or
          reword the ones that do not fit. Leave it empty to start tickets with no tasks.
        </p>
      </div>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (dirty && !save.isPending) save.mutate(phases)
        }}
      >
        {items.length === 0 && (
          <p className="text-sm text-muted-foreground">No phases: new tickets start with no tasks.</p>
        )}
        <Label htmlFor="default-phases-new" className="sr-only">
          New phase
        </Label>
        <ListInput
          id="default-phases-new"
          value={items}
          onChange={setItems}
          text={text}
          onTextChange={setText}
          label="Default phases"
          placeholder="Add a phase"
          addLabel="Add phase"
          reorderable
        />
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">
            {dirty ? 'Unsaved changes.' : 'No changes.'}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={save.isPending}
            onClick={() => save.mutate(null)}
          >
            Use the built-in list
          </Button>
          <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </section>
  )
}

/**
 * The tags offered as chips under every ticket's tags field, before the ones the
 * project's tickets carry. Emptying it offers none of its own; the defaults can be had back.
 */
function TagSuggestions({ projectId, saved }: { projectId: string; saved: string[] }) {
  const qc = useQueryClient()
  const [items, setItems] = useState(saved)
  const [text, setText] = useState('')
  // What Save would store: the list with what is typed and not yet added, trimmed, repeats left out.
  const tags = cleanSuggestions(addTasks(items, text))
  const dirty = tags.join('\n') !== saved.join('\n')
  const save = useMutation({
    mutationFn: (tagSuggestions: string[]) =>
      patch<{ tagSuggestions: string[] }>(`/api/projects/${projectId}`, { tagSuggestions }),
    onSuccess: async (row) => {
      setItems(row.tagSuggestions)
      setText('')
      await qc.invalidateQueries({ queryKey: ['project', projectId] })
      toast.success('Saved')
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <section id="tag-suggestions" aria-label="Tag suggestions" className="max-w-3xl scroll-mt-16 space-y-3">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Tag suggestions</h2>
        <p className="text-sm text-muted-foreground">
          The tags offered as chips under a ticket&apos;s tags, followed by the tags its tickets already
          carry. Agents read them in <code className="rounded bg-muted px-1">get_project</code> and reuse
          them. Leave it empty to offer only the tags in use.
        </p>
      </div>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (dirty && !save.isPending) save.mutate(tags)
        }}
      >
        {items.length === 0 && (
          <p className="text-sm text-muted-foreground">No suggestions: only the tags in use are offered.</p>
        )}
        <Label htmlFor="tag-suggestions-new" className="sr-only">
          New tag
        </Label>
        <ListInput
          id="tag-suggestions-new"
          value={items}
          onChange={setItems}
          text={text}
          onTextChange={setText}
          label="Tag suggestions"
          placeholder="Add a tag"
          addLabel="Add tag"
        />
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">
            {dirty ? 'Unsaved changes.' : 'No changes.'}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={save.isPending}
            onClick={() => save.mutate([...DEFAULT_TAG_SUGGESTIONS])}
          >
            Use the defaults
          </Button>
          <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </section>
  )
}

/**
 * How long a ticket in an active stage may go without an event on its work timeline (a heartbeat, a
 * span, a wait, a push…) before it reads as stalled, on its card, on the Roadmap and in Needs you.
 */
function StallMinutes({ projectId, saved }: { projectId: string; saved: number }) {
  const qc = useQueryClient()
  const [text, setText] = useState(String(saved))
  const minutes = Number(text)
  const valid = Number.isInteger(minutes) && minutes >= STALL_MINUTES.min && minutes <= STALL_MINUTES.max
  const dirty = valid && minutes !== saved
  const save = useMutation({
    mutationFn: (stallMinutes: number) =>
      patch<{ stallMinutes: number }>(`/api/projects/${projectId}`, { stallMinutes }),
    onSuccess: async (row) => {
      setText(String(row.stallMinutes))
      await qc.invalidateQueries({ queryKey: ['project', projectId] })
      toast.success('Saved')
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <section id="stalled-tickets" aria-label="Stalled tickets" className="max-w-3xl scroll-mt-16 space-y-3">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Stalled tickets</h2>
        <p className="text-sm text-muted-foreground">
          Two clocks decide how a ticket reads. The lease is what an agent's heartbeat or post keeps alive: it
          lasts ten minutes, and when it runs out with a span still open the ticket reads as{' '}
          <span className="font-medium">Lost contact</span> — the agent is gone, not waiting on you. A ticket
          with nothing open reads as <span className="font-medium">Stalled</span> once no agent's word (a
          heartbeat, a span, a wait, a hand-off) and nothing the board has seen of it (a push, its PR, its
          preview) has come for this long. This dial sets that silence threshold; the lease's ten minutes stay
          fixed.
        </p>
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (dirty && !save.isPending) save.mutate(minutes)
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="stall-minutes">Stalled after (minutes)</Label>
          <Input
            id="stall-minutes"
            type="number"
            inputMode="numeric"
            min={STALL_MINUTES.min}
            max={STALL_MINUTES.max}
            step={1}
            className="w-32"
            value={text}
            aria-invalid={!valid}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {valid
            ? dirty
              ? 'Unsaved changes.'
              : 'No changes.'
            : `A whole number from ${STALL_MINUTES.min} to ${STALL_MINUTES.max}.`}
        </span>
      </form>
    </section>
  )
}
