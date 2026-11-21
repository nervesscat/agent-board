import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Label } from '#/components/ui/label'
import { Progress } from '#/components/ui/progress'
import { Switch } from '#/components/ui/switch'
import { Tip } from '#/components/ui/tooltip'
import { errorMessage, get, type Me, patch, post } from '#/lib/api'
import { shared } from '#/i18n'
import { ago } from '#/lib/format'
import { forgetUpdateMemory, recallUpdateMemory, subscribeUpdateMemory } from '#/lib/updateCard'
import {
  type DesktopUpdates,
  UPDATE_IN_PROGRESS,
  type UpdateSettings,
  type UpdatesState,
  updateOffered,
} from '#/lib/updates'
import { useHydrated } from '#/lib/useHydrated'

/** How often the page reads the state again while nothing is under way: a check of the app's own shows. */
const IDLE_REFRESH_MS = 5 * 60_000

/**
 * The desktop app's updates (GET /api/updates), for the human only: an agent is never asked, and the
 * route refuses one. Read again about every second while a check or a download is under way.
 */
export function useUpdates() {
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => get<Me>('/api/me'), staleTime: Infinity })
  return useQuery({
    queryKey: ['updates'],
    queryFn: () => get<UpdatesState>('/api/updates'),
    enabled: me !== undefined && !me.agent,
    refetchInterval: (q) => {
      const s = q.state.data
      return s?.mode === 'desktop' && UPDATE_IN_PROGRESS.includes(s.status) ? 1000 : IDLE_REFRESH_MS
    },
  })
}

/** The top bar's word that a newer version of the app is there, to its Updates section. */
export function UpdateBadge() {
  const { t } = useTranslation()
  const { data } = useUpdates()
  // Read after mount: the update can be found before React has hydrated the top bar.
  const hydrated = useHydrated()
  if (!hydrated || !updateOffered(data)) return null
  return (
    <Tip content={t('updates.badgeTip', { version: data.newest.version, installed: data.installed })}>
      <Link to="/settings" hash="updates" className="shrink-0" aria-label={t('updates.badgeAria')}>
        <Badge variant="secondary">{t('updates.badge')}</Badge>
      </Link>
    </Tip>
  )
}

/** The Updates section of Settings: under the desktop app its updater, from a checkout how to update. */
export function Updates() {
  const { t } = useTranslation()
  const { data } = useUpdates()
  if (!data) return null
  return (
    <section id="updates" className="scroll-mt-16 space-y-3" aria-labelledby="updates-title">
      <h2 id="updates-title" className="text-sm font-medium">
        {t('updates.title')}
      </h2>
      {data.mode === 'checkout' ? <CheckoutUpdates /> : <DesktopUpdatesSection state={data} />}
    </section>
  )
}

function CheckoutUpdates() {
  return (
    <p className="text-sm text-muted-foreground">
      <Trans i18nKey="updates.checkout" components={{ code: <code /> }} />
    </p>
  )
}

function DesktopUpdatesSection({ state }: { state: DesktopUpdates }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const onState = (s: UpdatesState) => qc.setQueryData(['updates'], s)
  const onError = (err: unknown) => toast.error(errorMessage(err))
  const check = useMutation({
    mutationFn: () => post<UpdatesState>('/api/updates/check'),
    onSuccess: onState,
    onError,
  })
  const install = useMutation({
    mutationFn: () => post<UpdatesState>('/api/updates/install'),
    onSuccess: onState,
    onError,
  })
  const settings = useMutation({
    mutationFn: (p: Partial<UpdateSettings>) => patch<UpdatesState>('/api/updates/settings', p),
    onSuccess: onState,
    onError,
  })
  const busy = UPDATE_IN_PROGRESS.includes(state.status)
  const unsupported = state.status === 'unsupported'
  const offered = updateOffered(state) && ['available', 'error', 'manual'].includes(state.status)

  return (
    <div className="space-y-3 text-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">{t('updates.installed')}</dt>
        <dd data-testid="updates-installed">{t('updates.installedValue', { version: state.installed })}</dd>
        <dt className="text-muted-foreground">{t('updates.newestRelease')}</dt>
        <dd data-testid="updates-newest">{newestText(state)}</dd>
      </dl>
      {unsupported ? (
        <p className="text-muted-foreground">{t('updates.unsupported')}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => check.mutate()}
            disabled={busy || check.isPending}
          >
            {state.status === 'checking' ? t('updates.checking') : t('updates.checkNow')}
          </Button>
          {offered && (
            <Button size="sm" onClick={() => install.mutate()} disabled={install.isPending}>
              {t('updates.install')}
            </Button>
          )}
        </div>
      )}
      {state.status === 'downloading' && (
        <Progress value={state.progress?.percent ?? 0} aria-label={t('updates.downloadAria')}>
          <span className="text-muted-foreground">
            {t('updates.downloading', {
              version: state.newest?.version,
              percent: state.progress?.percent ?? 0,
            })}
          </span>
        </Progress>
      )}
      {state.status === 'installing' && (
        <p role="status">{t('updates.installing', { version: state.newest?.version })}</p>
      )}
      {state.error && (
        <p role="alert" className="text-destructive [overflow-wrap:anywhere]">
          {state.error}
        </p>
      )}
      {state.manual && <ManualCommand command={state.manual.command} />}
      {updateOffered(state) && state.newest.notes && (
        <div className="space-y-1">
          <h3 className="text-xs font-medium text-muted-foreground">
            {t('updates.whatsNew', { version: state.newest.version })}
          </h3>
          <div
            data-testid="updates-notes"
            className="max-h-64 overflow-auto rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]"
          >
            {state.newest.notes}
          </div>
        </div>
      )}
      <SkippedUpdate />
      {!unsupported && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Switch
              id="updates-auto-check"
              checked={state.settings.autoCheck}
              onCheckedChange={(autoCheck) => settings.mutate({ autoCheck })}
              disabled={settings.isPending}
            />
            <Label htmlFor="updates-auto-check">{t('updates.autoCheck')}</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="updates-prereleases"
              checked={state.settings.prereleases}
              onCheckedChange={(prereleases) => settings.mutate({ prereleases })}
              disabled={settings.isPending}
            />
            <Label htmlFor="updates-prereleases">{t('updates.prereleases')}</Label>
          </div>
          <p className="text-xs text-muted-foreground">{t('updates.note')}</p>
        </div>
      )}
    </div>
  )
}

function newestText(state: DesktopUpdates) {
  if (state.newest) return shared.t('updates.installedValue', { version: state.newest.version })
  if (state.status === 'checking') return shared.t('updates.checking')
  if (!state.checkedAt) return shared.t('updates.notChecked')
  if (state.status === 'none') return shared.t('updates.none', { when: ago(state.checkedAt) })
  return shared.t('updates.unknown', { when: ago(state.checkedAt) })
}

/**
 * The release this browser skipped, with the way back: Undo forgets it, so the update card may announce
 * it again. Per browser (it is not on the server), and only under the app, which has the card.
 */
function SkippedUpdate() {
  const { t } = useTranslation()
  const [skipped, setSkipped] = useState<string | null>(null)
  useEffect(() => {
    const read = () => setSkipped(recallUpdateMemory().skippedVersion)
    read()
    return subscribeUpdateMemory(read)
  }, [])
  if (!skipped) return null
  return (
    <div data-testid="updates-skipped" className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground">{t('updates.skipped', { version: skipped })}</span>
      <Button size="sm" variant="outline" onClick={() => forgetUpdateMemory()}>
        {t('updates.undo')}
      </Button>
    </div>
  )
}

/** The command that installs the downloaded package, for when polkit could not. */
function ManualCommand({ command }: { command: string }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-1">
      <p>{t('updates.manual')}</p>
      <div className="flex items-start gap-2">
        <code
          data-testid="updates-command"
          className="min-w-0 flex-1 rounded-md border bg-muted/30 px-2 py-1.5 font-mono text-xs [overflow-wrap:anywhere]"
        >
          {command}
        </code>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t('updates.copyCommand')}
          onClick={() =>
            navigator.clipboard.writeText(command).then(
              () => toast.success(t('connect.copied')),
              () => toast.error(t('connect.couldNotCopy')),
            )
          }
        >
          <Copy />
        </Button>
      </div>
    </div>
  )
}
