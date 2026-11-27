import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { LayoutEditor } from '#/components/LayoutEditor'
import { ListInput } from '#/components/ListInput'
import { NotificationSettings } from '#/components/NotificationSettings'
import { ResumeSettings } from '#/components/ResumeSettings'
import { RunsSettings } from '#/components/RunsSettings'
import { StagesEditor } from '#/components/StagesEditor'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { KindPicker } from '#/components/KindPicker'
import { errorMessage, patch } from '#/lib/api'
import { STALL_MINUTES, WAITING_LONG_DAYS } from '#/lib/constants'
import type { Kind } from '#/lib/kinds'
import { useProject } from '#/lib/project'
import { useAnchor, useReveal } from '#/lib/reveal'
import { DEFAULT_TAG_SUGGESTIONS, cleanSuggestions } from '#/lib/tags'
import { addTasks } from '#/lib/tasks'

/** One project's settings: the project tab of the Settings page. */
export function ProjectSettings({ id }: { id: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
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
        <p className="text-sm text-muted-foreground">{t('projectSettings.intro')}</p>
      </div>
      <ProjectKinds key={`kinds-${id}`} projectId={id} saved={p.kinds} />
      <DefaultPhases key={id} projectId={id} saved={p.defaultPhases} />
      <TagSuggestions key={`tags-${id}`} projectId={id} saved={p.tagSuggestions} />
      <StallMinutes key={`stall-${id}`} projectId={id} saved={p.stallMinutes} />
      <WaitingLong key={`waiting-${id}`} projectId={id} saved={p.waitingLongDays} />
      <NotificationSettings key={`notifications-${id}`} projectId={id} />
      <StagesEditor projectId={id} />
      <RunsSettings projectId={id} />
      <ResumeSettings key={`resume-${id}`} projectId={id} />
      <LayoutEditor key={`layout-${id}`} projectId={id} saved={p.layout} />
    </div>
  )
}

/**
 * What the project is for: its kinds. Software keeps the git side (repositories, PRs, CI, previews,
 * Cleanup); a project with none of software hides it. Changing a kind keeps its repos and PRs stored.
 */
function ProjectKinds({ projectId, saved }: { projectId: string; saved: Kind[] }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [kinds, setKinds] = useState<Kind[]>(saved)
  const dirty = kinds.join(',') !== saved.join(',')
  const save = useMutation({
    mutationFn: (next: Kind[]) => patch<{ kinds: Kind[] }>(`/api/projects/${projectId}`, { kinds: next }),
    onSuccess: async (row) => {
      setKinds(row.kinds)
      await qc.invalidateQueries({ queryKey: ['project', projectId] })
      toast.success(t('common.saved'))
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <section
      id="kinds"
      aria-label={t('projectSettings.kinds.title')}
      className="max-w-3xl scroll-mt-16 space-y-3"
    >
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{t('projectSettings.kinds.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('projectSettings.kinds.description')}</p>
      </div>
      <KindPicker value={kinds} onChange={setKinds} />
      <Button type="button" size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate(kinds)}>
        {t('projectSettings.save')}
      </Button>
    </section>
  )
}

/**
 * The top-level phases every new ticket of the project starts with, in order: the list in effect
 * (the built-in one until it is changed). Emptying it seeds nothing; the built-in list can be had back.
 * Agents read it in `get_project` and change the phases per ticket.
 */
function DefaultPhases({ projectId, saved }: { projectId: string; saved: string[] }) {
  const { t } = useTranslation()
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
      toast.success(t('common.saved'))
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <section
      id="default-phases"
      aria-label={t('projectSettings.phases.title')}
      className="max-w-3xl scroll-mt-16 space-y-3"
    >
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{t('projectSettings.phases.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('projectSettings.phases.description')}</p>
      </div>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (dirty && !save.isPending) save.mutate(phases)
        }}
      >
        {items.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('projectSettings.phases.empty')}</p>
        )}
        <Label htmlFor="default-phases-new" className="sr-only">
          {t('projectSettings.phases.new')}
        </Label>
        <ListInput
          id="default-phases-new"
          value={items}
          onChange={setItems}
          text={text}
          onTextChange={setText}
          label={t('projectSettings.phases.list')}
          placeholder={t('projectSettings.phases.placeholder')}
          addLabel={t('projectSettings.phases.add')}
          reorderable
        />
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">
            {dirty ? t('projectSettings.unsaved') : t('projectSettings.noChanges')}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={save.isPending}
            onClick={() => save.mutate(null)}
          >
            {t('projectSettings.phases.useBuiltIn')}
          </Button>
          <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
            {save.isPending ? t('projectSettings.saving') : t('projectSettings.save')}
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
  const { t } = useTranslation()
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
      toast.success(t('common.saved'))
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <section
      id="tag-suggestions"
      aria-label={t('projectSettings.tags.title')}
      className="max-w-3xl scroll-mt-16 space-y-3"
    >
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{t('projectSettings.tags.title')}</h2>
        <p className="text-sm text-muted-foreground">
          <Trans
            i18nKey="projectSettings.tags.description"
            components={{ code: <code className="rounded bg-muted px-1" /> }}
          />
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
          <p className="text-sm text-muted-foreground">{t('projectSettings.tags.empty')}</p>
        )}
        <Label htmlFor="tag-suggestions-new" className="sr-only">
          {t('projectSettings.tags.new')}
        </Label>
        <ListInput
          id="tag-suggestions-new"
          value={items}
          onChange={setItems}
          text={text}
          onTextChange={setText}
          label={t('projectSettings.tags.title')}
          placeholder={t('projectSettings.tags.placeholder')}
          addLabel={t('projectSettings.tags.add')}
        />
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">
            {dirty ? t('projectSettings.unsaved') : t('projectSettings.noChanges')}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={save.isPending}
            onClick={() => save.mutate([...DEFAULT_TAG_SUGGESTIONS])}
          >
            {t('projectSettings.tags.useDefaults')}
          </Button>
          <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
            {save.isPending ? t('projectSettings.saving') : t('projectSettings.save')}
          </Button>
        </div>
      </form>
    </section>
  )
}

/**
 * How many days a ticket may wait in a review stage, or in To do, before Needs you lists it as waiting long,
 * oldest first. Bug and Security tickets in To do are listed after a day whatever this is.
 */
function WaitingLong({ projectId, saved }: { projectId: string; saved: number }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [text, setText] = useState(String(saved))
  const days = Number(text)
  const valid = Number.isInteger(days) && days >= WAITING_LONG_DAYS.min && days <= WAITING_LONG_DAYS.max
  const dirty = valid && days !== saved
  const save = useMutation({
    mutationFn: (waitingLongDays: number) =>
      patch<{ waitingLongDays: number }>(`/api/projects/${projectId}`, { waitingLongDays }),
    onSuccess: async (row) => {
      setText(String(row.waitingLongDays))
      await qc.invalidateQueries({ queryKey: ['project', projectId] })
      toast.success(t('common.saved'))
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <section
      id="waiting-too-long"
      aria-label={t('projectSettings.waitingLong.title')}
      className="max-w-3xl scroll-mt-16 space-y-3"
    >
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{t('projectSettings.waitingLong.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('projectSettings.waitingLong.description')}</p>
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (dirty && !save.isPending) save.mutate(days)
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="waiting-long-days">{t('projectSettings.waitingLong.label')}</Label>
          <Input
            id="waiting-long-days"
            type="number"
            inputMode="numeric"
            min={WAITING_LONG_DAYS.min}
            max={WAITING_LONG_DAYS.max}
            step={1}
            className="w-32"
            value={text}
            aria-invalid={!valid}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
          {save.isPending ? t('projectSettings.saving') : t('projectSettings.save')}
        </Button>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {valid
            ? dirty
              ? t('projectSettings.unsaved')
              : t('projectSettings.noChanges')
            : t('projectSettings.stall.invalid', { min: WAITING_LONG_DAYS.min, max: WAITING_LONG_DAYS.max })}
        </span>
      </form>
    </section>
  )
}

/**
 * How long a ticket in an active stage may go without an event on its work timeline (a heartbeat, a
 * span, a wait, a push…) before it reads as stalled, on its card, on the Roadmap and in Needs you.
 */
function StallMinutes({ projectId, saved }: { projectId: string; saved: number }) {
  const { t } = useTranslation()
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
      toast.success(t('common.saved'))
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <section
      id="stalled-tickets"
      aria-label={t('projectSettings.stall.title')}
      className="max-w-3xl scroll-mt-16 space-y-3"
    >
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{t('projectSettings.stall.title')}</h2>
        <p className="text-sm text-muted-foreground">
          <Trans
            i18nKey="projectSettings.stall.description"
            components={{ lost: <span className="font-medium" />, stalled: <span className="font-medium" /> }}
          />
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
          <Label htmlFor="stall-minutes">{t('projectSettings.stall.label')}</Label>
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
          {save.isPending ? t('projectSettings.saving') : t('projectSettings.save')}
        </Button>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {valid
            ? dirty
              ? t('projectSettings.unsaved')
              : t('projectSettings.noChanges')
            : t('projectSettings.stall.invalid', { min: STALL_MINUTES.min, max: STALL_MINUTES.max })}
        </span>
      </form>
    </section>
  )
}
