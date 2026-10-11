import { useMutation } from '@tanstack/react-query'
import { ExternalLink, Loader2, Play, RotateCw, Square } from 'lucide-react'
import { toast } from 'sonner'

import { Button, buttonVariants } from '#/components/ui/button'
import { errorMessage, post, type ManagedPreview, type PreviewState } from '#/lib/api'
import { clock } from '#/lib/format'
import { cn } from '#/lib/utils'

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
 * it builds or runs. Errors come up as a toast.
 */
export function PreviewActions({
  workspaceId,
  url,
  managed,
  cannotStart,
  onChange,
}: {
  workspaceId: number
  url: string
  managed: ManagedPreview | null
  /** undefined until the board said. */
  cannotStart: string | null | undefined
  onChange: () => void
}) {
  const action = useMutation({
    mutationFn: (what: 'start' | 'stop' | 'restart') =>
      post(`/api/workspaces/${workspaceId}/preview/${what}`),
    onSuccess: onChange,
    onError: (err) => toast.error(errorMessage(err)),
  })
  const active = previewActive(managed)
  return (
    <>
      {url && (
        <a href={url} target="_blank" rel="noreferrer" className={buttonVariants({ size: 'sm' })}>
          Open preview <ExternalLink />
        </a>
      )}
      {!active && cannotStart === null && (
        <Button
          variant="outline"
          size="sm"
          disabled={action.isPending}
          onClick={() => action.mutate('start')}
          title="Build this worktree and run it on a free port, with a fresh copy of the live data"
        >
          <Play /> Start
        </Button>
      )}
      {active && (
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={action.isPending}
            onClick={() => action.mutate('stop')}
            title="Stop the preview and free its port"
          >
            <Square /> Stop
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={action.isPending}
            onClick={() => action.mutate('restart')}
            title="Stop it, build again and start it with a fresh copy of the data"
          >
            <RotateCw /> Restart
          </Button>
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
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px]',
        state.className,
        className,
      )}
      title={state.title}
    >
      {check && <span className="size-1.5 rounded-full bg-current" />}
      {state.label}
    </span>
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
