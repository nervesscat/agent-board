import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Loader2, Play, RotateCw, Square } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button, buttonVariants } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Tip } from '#/components/ui/tooltip'
import {
  errorMessage,
  patch,
  post,
  type LinkStopped,
  type ManagedPreview,
  type PreviewState,
} from '#/lib/api'
import { PREVIEW_LIMIT } from '#/lib/constants'
import { clock } from '#/lib/format'
import { cn } from '#/lib/utils'
import type { Settings } from '#/server/agents'

/**
 * The pieces of a preview row, shared by a ticket's Preview card and the project's Previews page: the
 * link and the buttons, whether the link answers, and what the board's own preview is doing.
 */

/** A preview the board is building or running (and so can stop). */
export const previewActive = (m: ManagedPreview | null | undefined) =>
  !!m && (m.status === 'building' || m.status === 'starting' || m.status === 'running')

const STEP_LABEL: Record<NonNullable<ManagedPreview['step']>, string> = {
  install: 'installing dependencies',
  build: 'building',
  copy: 'copying the live data',
  server: 'starting the server',
}

/**
 * Open the link in a new tab, and Start, Stop and Restart the board's own preview of the workspace:
 * Start only when none runs and the board would start one (`cannotStart` null), Stop and Restart while
 * it builds or runs. With `linkStop` null (a link that answers, whose server the board may stop), a Stop
 * of that server. Errors come up as a toast.
 */
export function PreviewActions({
  workspaceId,
  url,
  managed,
  cannotStart,
  linkStop,
  onChange,
}: {
  workspaceId: number
  url: string
  managed: ManagedPreview | null
  /** undefined until the board said. */
  cannotStart: string | null | undefined
  /** null: the board may stop the server behind the link; undefined or a reason: no Stop for it. */
  linkStop?: string | null
  onChange: () => void
}) {
  const action = useMutation({
    mutationFn: (what: 'start' | 'stop' | 'restart') =>
      post(`/api/workspaces/${workspaceId}/preview/${what}`),
    onSuccess: onChange,
    onError: (err) => toast.error(errorMessage(err)),
  })
  const stopLink = useMutation({
    mutationFn: () => post<LinkStopped>(`/api/workspaces/${workspaceId}/preview/stop-link`),
    onSuccess: (r) => {
      if (!r.freed) toast.warning(`Stopped, but something still listens on :${r.port}`)
      onChange()
    },
    // Refused (it changed since the page looked): the toast says why, and the row asks again.
    onError: (err) => {
      toast.error(errorMessage(err))
      onChange()
    },
  })
  const active = previewActive(managed)
  return (
    <>
      {url && (
        <a href={url} target="_blank" rel="noreferrer" className={buttonVariants({ size: 'sm' })}>
          Open preview <ExternalLink />
        </a>
      )}
      {!active && url && linkStop === null && (
        <Tip content="Stop the server behind this link (it runs from the workspace's worktree) and free its port">
          <Button variant="outline" size="sm" disabled={stopLink.isPending} onClick={() => stopLink.mutate()}>
            <Square /> Stop
          </Button>
        </Tip>
      )}
      {!active && cannotStart === null && (
        <Tip content="Build this worktree and run it on a free port, with a fresh copy of the live data">
          <Button
            variant="outline"
            size="sm"
            disabled={action.isPending}
            onClick={() => action.mutate('start')}
          >
            <Play /> Start
          </Button>
        </Tip>
      )}
      {active && (
        <>
          <Tip content="Stop the preview and free its port">
            <Button
              variant="outline"
              size="sm"
              disabled={action.isPending}
              onClick={() => action.mutate('stop')}
            >
              <Square /> Stop
            </Button>
          </Tip>
          <Tip content="Stop it, build again and start it with a fresh copy of the data">
            <Button
              variant="outline"
              size="sm"
              disabled={action.isPending}
              onClick={() => action.mutate('restart')}
            >
              <RotateCw /> Restart
            </Button>
          </Tip>
        </>
      )}
    </>
  )
}

/**
 * Whether the link answers: Running or Not running once checked, Checking… until then, and Not
 * checked (with why) when the board did not check it. Nothing without a link.
 */
export function PreviewBadge({
  url,
  check,
  unchecked,
  className,
}: {
  url: string
  check: PreviewState | null | undefined
  /** Why it was not checked: an error, or a link off this machine. */
  unchecked?: string | null
  className?: string
}) {
  if (!url) return null
  const state = check
    ? check.running
      ? {
          label: 'Running',
          title: `Answered with HTTP ${check.status} at ${clock(check.checkedAt)}`,
          className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
        }
      : {
          label: 'Not running',
          title: `No answer at ${clock(check.checkedAt)}`,
          className: 'bg-muted text-muted-foreground',
        }
    : unchecked
      ? { label: 'Not checked', title: unchecked, className: 'bg-muted text-muted-foreground' }
      : { label: 'Checking…', title: 'Checking whether it answers', className: 'text-muted-foreground' }
  return (
    <Tip content={state.title}>
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px]',
          state.className,
          className,
        )}
      >
        {check && <span className="size-1.5 rounded-full bg-current" />}
        {state.label}
      </span>
    </Tip>
  )
}

/** What the board's own preview of the workspace is doing, and why it failed or stopped. */
export function ManagedLine({ m, workspaceId }: { m: ManagedPreview; workspaceId: number }) {
  const log = (name: 'build' | 'server', label = 'full log') => (
    <a
      href={`/api/workspaces/${workspaceId}/preview/log?name=${name}`}
      target="_blank"
      rel="noreferrer"
      className="underline hover:text-foreground"
    >
      {label}
    </a>
  )
  if (m.status === 'building' || m.status === 'starting')
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        {m.status === 'starting' && m.port ? `Starting on :${m.port}…` : 'Building…'}
        {m.step && ` ${STEP_LABEL[m.step]}`} · {log(m.step === 'server' ? 'server' : 'build', 'log')}
      </div>
    )
  if (m.status === 'running')
    return (
      <div className="text-xs text-muted-foreground">
        Run by the board on :{m.port}
        {m.runningAt && `, since ${clock(m.runningAt)}`} · {log('server', 'server log')}
      </div>
    )
  if (m.status === 'failed')
    return (
      <div className="space-y-1 text-xs">
        <div className="text-destructive">
          Failed: {m.reason}
          {m.tailLog && <> · {log(m.tailLog)}</>}
        </div>
        {m.tail.length > 0 && (
          <pre className="max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap">
            {m.tail.join('\n')}
          </pre>
        )}
      </div>
    )
  return (
    <div className="text-xs text-muted-foreground">
      {m.reason?.startsWith('stopped')
        ? m.reason.charAt(0).toUpperCase() + m.reason.slice(1)
        : `Stopped${m.reason ? `: ${m.reason}` : ''}`}
      {m.stoppedAt && ` (${clock(m.stoppedAt)})`}
    </div>
  )
}

/**
 * The preview limit, board-wide: how many previews the board builds or runs at once. Out of range or
 * not a whole number, the board refuses it and the toast says why.
 */
export function PreviewLimitEditor({ id, limit }: { id: string; limit: number }) {
  const qc = useQueryClient()
  const [value, setValue] = useState(String(limit))
  const save = useMutation({
    mutationFn: () => patch<Settings>('/api/settings', { previewLimit: Number(value) }),
    onSuccess: (s) => {
      qc.setQueryData(['settings'], s)
      void qc.invalidateQueries({ queryKey: ['previews'] })
      toast.success('Saved')
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    // The board checks the value: what it refuses comes up as a toast, not a browser bubble.
    <form
      noValidate
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <Label htmlFor={id} className="text-xs whitespace-nowrap">
        Preview limit
      </Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={PREVIEW_LIMIT.min}
        max={PREVIEW_LIMIT.max}
        step={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-20"
      />
      <Button type="submit" variant="outline" size="sm" disabled={save.isPending || value === String(limit)}>
        {save.isPending ? 'Saving…' : 'Save'}
      </Button>
    </form>
  )
}
