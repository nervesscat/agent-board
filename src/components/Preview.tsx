import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AppWindow, ExternalLink, Loader2, Play, RotateCw, Square } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { openPreview } from '#/components/PreviewWindow'
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
import { previewBrowserUrl, previewTab } from '#/lib/previewWindow'
import { cn } from '#/lib/utils'
import type { Settings } from '#/server/agents'

/**
 * The pieces of a preview row, shared by a ticket's Runs card and the project's Previews page: the
 * link and the buttons, whether the link answers, and what the board's own preview is doing.
 */

/** A preview the board is building or running (and so can stop). */
export const previewActive = (m: ManagedPreview | null | undefined) =>
  !!m && (m.status === 'building' || m.status === 'starting' || m.status === 'running')

const STEP_LABEL = {
  install: 'previews.step.install',
  build: 'previews.step.build',
  copy: 'previews.step.copy',
  server: 'previews.step.server',
} as const satisfies Record<NonNullable<ManagedPreview['step']>, string>

/**
 * Open a preview inside CrossBoard (the embedded window, PreviewWindow.tsx), Open in browser for a tab,
 * and Start, Stop and Restart the board's own preview of the workspace: Start only when none runs and the
 * board would start one (`cannotStart` null), Stop and Restart while it builds or runs. With `linkStop`
 * null (a link that answers, whose server the board may stop), a Stop of that server. Errors come up as a
 * toast. A link that cannot be embedded (one off this machine, a hosted page) gets Open in browser alone.
 */
export function PreviewActions({
  workspaceId,
  url,
  managed,
  cannotStart,
  linkStop,
  onChange,
  ticketId,
  ticketTitle,
  label,
}: {
  workspaceId: number
  url: string
  managed: ManagedPreview | null
  /** undefined until the board said. */
  cannotStart: string | null | undefined
  /** null: the board may stop the server behind the link; undefined or a reason: no Stop for it. */
  linkStop?: string | null
  onChange: () => void
  /** The ticket the preview belongs to, for the window's title, and the workspace and run under it. */
  ticketId?: number | null
  ticketTitle?: string
  label?: string
}) {
  const { t } = useTranslation()
  const action = useMutation({
    mutationFn: (what: 'start' | 'stop' | 'restart') =>
      post(`/api/workspaces/${workspaceId}/preview/${what}`),
    onSuccess: onChange,
    onError: (err) => toast.error(errorMessage(err)),
  })
  const stopLink = useMutation({
    mutationFn: () => post<LinkStopped>(`/api/workspaces/${workspaceId}/preview/stop-link`),
    onSuccess: (r) => {
      if (!r.freed) toast.warning(t('previews.stoppedStillListening', { port: r.port }))
      onChange()
    },
    // Refused (it changed since the page looked): the toast says why, and the row asks again.
    onError: (err) => {
      toast.error(errorMessage(err))
      onChange()
    },
  })
  const active = previewActive(managed)
  // The board-run preview, when it is the one whose link the row shows (a workspace has several runs; the
  // board's `managed` is its first preview run, so a second one's link is just a link here): its run id
  // is what the window asks about, and its proxy and tailnet links are the ones to offer.
  const live = managed?.status === 'running' && managed.url === url ? managed : null
  const run = { url, proxyUrl: live?.proxyUrl ?? null, remoteUrl: live?.remoteUrl ?? null }
  const tab = previewTab({
    ticketId: ticketId ?? null,
    title: ticketTitle ?? t('runsSettings.typePreview'),
    workspaceId,
    runId: live?.runId ?? null,
    label: label ?? t('runsSettings.typePreview'),
    run,
  })
  const browser = previewBrowserUrl(run)
  return (
    <>
      {tab && (
        <Tip content={t('runsCard.openTip')}>
          <Button size="sm" data-testid="preview-open" onClick={() => openPreview(tab)}>
            <AppWindow /> {t('runsCard.open')}
          </Button>
        </Tip>
      )}
      {browser && (
        <a
          href={browser}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ size: 'sm', variant: 'outline' })}
        >
          {t('runsCard.openBrowser')} <ExternalLink />
        </a>
      )}
      {!active && url && linkStop === null && (
        <Tip content={t('previews.stopLinkTip')}>
          <Button variant="outline" size="sm" disabled={stopLink.isPending} onClick={() => stopLink.mutate()}>
            <Square /> {t('runsCard.stop')}
          </Button>
        </Tip>
      )}
      {!active && cannotStart === null && (
        <Tip content={t('previews.startTip')}>
          <Button
            variant="outline"
            size="sm"
            disabled={action.isPending}
            onClick={() => action.mutate('start')}
          >
            <Play /> {t('runsCard.start')}
          </Button>
        </Tip>
      )}
      {active && (
        <>
          <Tip content={t('previews.stopTip')}>
            <Button
              variant="outline"
              size="sm"
              disabled={action.isPending}
              onClick={() => action.mutate('stop')}
            >
              <Square /> {t('runsCard.stop')}
            </Button>
          </Tip>
          <Tip content={t('previews.restartTip')}>
            <Button
              variant="outline"
              size="sm"
              disabled={action.isPending}
              onClick={() => action.mutate('restart')}
            >
              <RotateCw /> {t('runsCard.restart')}
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
  const { t } = useTranslation()
  if (!url) return null
  const state = check
    ? check.running
      ? {
          label: t('runsCard.status.running'),
          title: t('previews.answered', { status: check.status, time: clock(check.checkedAt) }),
          className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
        }
      : {
          label: t('previews.notRunning'),
          title: t('previews.noAnswer', { time: clock(check.checkedAt) }),
          className: 'bg-muted text-muted-foreground',
        }
    : unchecked
      ? { label: t('previews.notChecked'), title: unchecked, className: 'bg-muted text-muted-foreground' }
      : {
          label: t('previews.checking'),
          title: t('previews.checkingTitle'),
          className: 'text-muted-foreground',
        }
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
  const { t } = useTranslation()
  const log = (name: 'build' | 'server', label = t('previews.fullLog')) => (
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
        {m.status === 'starting' && m.port
          ? m.step
            ? t('previews.startingOnStep', { port: m.port, step: t(STEP_LABEL[m.step]) })
            : t('previews.startingOn', { port: m.port })
          : m.step
            ? t('previews.buildingStep', { step: t(STEP_LABEL[m.step]) })
            : t('previews.building')}{' '}
        · {log(m.step === 'server' ? 'server' : 'build', t('previews.log'))}
      </div>
    )
  if (m.status === 'running')
    return (
      <div className="text-xs text-muted-foreground">
        {m.runningAt
          ? t('previews.runBySince', { port: m.port, time: clock(m.runningAt) })
          : t('previews.runBy', { port: m.port })}{' '}
        · {log('server', t('previews.serverLog'))}
      </div>
    )
  if (m.status === 'failed')
    return (
      <div className="space-y-1 text-xs">
        <div className="text-destructive">
          {t('previews.failed', { reason: m.reason })}
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
        : m.reason
          ? t('previews.stoppedReason', { reason: m.reason })
          : t('runsCard.status.stopped')}
      {m.stoppedAt && ` (${clock(m.stoppedAt)})`}
    </div>
  )
}

/**
 * The preview limit, board-wide: how many previews the board builds or runs at once. Out of range or
 * not a whole number, the board refuses it and the toast says why.
 */
export function PreviewLimitEditor({ id, limit }: { id: string; limit: number }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [value, setValue] = useState(String(limit))
  const save = useMutation({
    mutationFn: () => patch<Settings>('/api/settings', { previewLimit: Number(value) }),
    onSuccess: (s) => {
      qc.setQueryData(['settings'], s)
      void qc.invalidateQueries({ queryKey: ['previews'] })
      toast.success(t('common.saved'))
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
        {t('previewLimit.label')}
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
        {save.isPending ? t('previewLimit.saving') : t('connect.save')}
      </Button>
    </form>
  )
}
