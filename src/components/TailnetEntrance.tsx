import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'

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
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { errorMessage, get, patch, post } from '#/lib/api'
import type { EntranceCheck, EntranceState } from '#/server/tailnetEntrance'

/**
 * The other-devices section of Settings (README: "Using it from other devices"), for the human only: this
 * machine's Tailscale as the board reads it (reads only), the entrance the board serves, saved here or set in
 * config.env (which wins), the `tailscale serve` command the human runs, and a Test that asks the board over
 * its own tailnet name. The board never runs `tailscale serve` or Funnel itself.
 */
export function TailnetEntrance() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const query = useQuery({ queryKey: ['tailnet'], queryFn: () => get<EntranceState>('/api/tailnet') })
  // The address being typed, until it is saved or dropped: null shows the saved one.
  const [draft, setDraft] = useState<string | null>(null)
  const [check, setCheck] = useState<EntranceCheck | null>(null)
  const recheck = () => qc.invalidateQueries({ queryKey: ['tailnet'] })
  const save = useMutation({
    mutationFn: (origin: string | null) => patch<EntranceState>('/api/tailnet', { origin }),
    onSuccess: (state, origin) => {
      qc.setQueryData(['tailnet'], state)
      setDraft(null)
      setCheck(null)
      toast.success(origin === null ? t('tailnet.entranceOff') : t('common.saved'))
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const test = useMutation({
    mutationFn: () => post<EntranceCheck>('/api/tailnet/test'),
    onSuccess: setCheck,
    onError: (err) => toast.error(errorMessage(err)),
  })

  if (!query.data) return null
  const s = query.data
  const ts = s.tailscale
  // Read-only while the environment sets the entrance; with sign-in off or Funnel on the board refuses a save
  // and says why, so the field stays usable for the human to see that.
  const locked = s.fromEnv !== null
  const value = draft ?? s.saved ?? ''
  const name = ts.name

  return (
    <section className="min-w-0 space-y-3" aria-labelledby="tailnet-title">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h2 id="tailnet-title" className="text-sm font-medium">
          {t('tailnet.title')}
        </h2>
        <Button size="sm" variant="outline" onClick={recheck} disabled={query.isFetching}>
          <RefreshCw /> {t('connect.checkAgain')}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{t('tailnet.text')}</p>

      {s.signInOff && (
        <p role="status" className="rounded-md border p-3 text-sm">
          {t('tailnet.signInOff', { env: s.boardEnv })}
        </p>
      )}
      {s.fromEnv && (
        <p role="status" className="rounded-md border p-3 text-sm">
          <Trans
            i18nKey="tailnet.fromEnv"
            values={{ origin: s.fromEnv }}
            components={{ code: <code className="break-words" /> }}
          />
        </p>
      )}
      {ts.funnel && (
        <p role="alert" className="rounded-md border border-destructive/50 p-3 text-sm text-destructive">
          <Trans i18nKey="tailnet.funnel" components={{ code: <code /> }} />
        </p>
      )}
      {s.unserved && !s.fromEnv && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('tailnet.unserved', { reason: s.unserved })}
        </p>
      )}

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-md border p-3 text-sm">
        <dt className="text-muted-foreground">{t('tailnet.tailscale')}</dt>
        <dd>
          {ts.installed
            ? ts.version
              ? t('tailnet.version', { version: ts.version })
              : t('tailnet.installed')
            : t('tailnet.notInstalled')}
        </dd>
        <dt className="text-muted-foreground">{t('tailnet.signedIn')}</dt>
        <dd>
          {ts.installed
            ? ts.signedIn
              ? t('tailnet.yes')
              : t('tailnet.no', { state: ts.backend ?? t('tailnet.notRunning') })
            : '-'}
        </dd>
        <dt className="text-muted-foreground">{t('tailnet.thisMachine')}</dt>
        <dd className="min-w-0 break-all">
          {name ?? (ts.installed && ts.signedIn ? t('tailnet.noName') : '-')}
        </dd>
        <dt className="text-muted-foreground">{t('tailnet.https')}</dt>
        <dd>{name ? (ts.https ? t('tailnet.certsOn') : t('tailnet.certsOff')) : '-'}</dd>
        <dt className="text-muted-foreground">{t('tailnet.serve')}</dt>
        <dd className="min-w-0 break-all">
          {ts.serve.state === 'board'
            ? t('tailnet.serveBoard', { target: ts.serve.target })
            : ts.serve.state === 'other'
              ? `${ts.serve.target}`
              : t('tailnet.serveNothing')}
        </dd>
        <dt className="text-muted-foreground">{t('tailnet.funnelLabel')}</dt>
        <dd>
          {!ts.funnelKnown
            ? t('tailnet.funnelUnknown')
            : ts.funnel
              ? t('tailnet.funnelOn')
              : t('tailnet.funnelOff')}
        </dd>
      </dl>
      {ts.error && (
        <p className="text-xs text-muted-foreground break-all">{t('tailnet.said', { error: ts.error })}</p>
      )}

      <NextStep state={s} />
      <ServeStatus state={s} />

      <div className="space-y-2">
        <Label htmlFor="tailnet-origin">{t('tailnet.entrance')}</Label>
        <div className="flex min-w-0 flex-wrap gap-2">
          <Input
            id="tailnet-origin"
            className="min-w-0 flex-1"
            // i18n-ignore: an address pattern, not language
            placeholder="https://<machine>.<tailnet>.ts.net"
            value={value}
            disabled={locked}
            onChange={(e) => setDraft(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {name && !locked && (
            <Button variant="outline" size="sm" onClick={() => setDraft(`https://${name}`)}>
              {t('tailnet.use', { name })}
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => save.mutate(value.trim())}
            disabled={locked || save.isPending || value.trim() === (s.saved ?? '')}
          >
            {t('connect.save')}
          </Button>
          {s.saved && (
            <AlertDialog>
              <AlertDialogTrigger
                render={<Button size="sm" variant="ghost" disabled={locked || save.isPending} />}
              >
                {t('connect.turnOff')}
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('tailnet.turnOffTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('tailnet.turnOffText', { origin: s.saved })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('connect.keep')}</AlertDialogCancel>
                  <AlertDialogAction onClick={() => save.mutate(null)}>
                    {t('connect.turnOff')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {t('tailnet.hint')}{' '}
          {s.served
            ? t(s.served.from === 'config' ? 'tailnet.servedConfig' : 'tailnet.servedSetting', {
                origin: s.served.origin,
              })
            : t('tailnet.servedNone')}
        </p>
      </div>

      <div className="space-y-2">
        <Button variant="outline" size="sm" onClick={() => test.mutate()} disabled={test.isPending}>
          {t('tailnet.test')}
        </Button>
        {check && (
          <p role="status" className={`text-sm ${check.ok ? '' : 'text-destructive'}`}>
            {check.ok ? t('tailnet.works') : t('tailnet.notYet')} {check.message}
          </p>
        )}
      </div>
    </section>
  )
}

/** What this machine's Tailscale needs before the entrance can work, or that it is ready. */
function NextStep({ state }: { state: EntranceState }) {
  const { t } = useTranslation()
  const ts = state.tailscale
  const text = !ts.installed
    ? t('tailnet.next.notInstalled')
    : !ts.signedIn
      ? t('tailnet.next.notSignedIn', { state: ts.backend ?? t('tailnet.notRunning') })
      : ts.name === null
        ? t('tailnet.next.noName')
        : !ts.https
          ? t('tailnet.next.httpsOff', { name: ts.name })
          : ts.serve.state === 'board'
            ? t('tailnet.next.ready', { name: ts.name })
            : null
  if (!text) return null
  return <p className="text-sm">{text}</p>
}

/** Whether `tailscale serve` sends 443 to the board, and the command to run when it does not. */
function ServeStatus({ state }: { state: EntranceState }) {
  const { t } = useTranslation()
  const ts = state.tailscale
  if (!ts.installed || !ts.signedIn || ts.name === null || ts.serve.state === 'board') return null
  const other = ts.serve.state === 'other'
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <p>
        {other
          ? t('tailnet.serveOther', { target: ts.serve.target, name: ts.name })
          : t('tailnet.serveNotSet', { name: ts.name })}
      </p>
      <div className="flex min-w-0 items-start gap-2">
        <code className="min-w-0 flex-1 break-words rounded bg-muted px-2 py-1 text-xs">{state.command}</code>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t('tailnet.copyServe')}
          onClick={() =>
            navigator.clipboard.writeText(state.command).then(
              () => toast.success(t('connect.copied')),
              () => toast.error(t('connect.couldNotCopy')),
            )
          }
        >
          <Copy />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        <Trans i18nKey="tailnet.neverRuns" components={{ code: <code /> }} />
      </p>
    </div>
  )
}
