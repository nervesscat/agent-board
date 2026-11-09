import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, RefreshCw } from 'lucide-react'
import { useState } from 'react'
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
      toast.success(origin === null ? 'The entrance is off' : 'Saved')
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
  const t = s.tailscale
  // Read-only while the environment sets the entrance; with sign-in off or Funnel on the board refuses a save
  // and says why, so the field stays usable for the human to see that.
  const locked = s.fromEnv !== null
  const value = draft ?? s.saved ?? ''
  const name = t.name

  return (
    <section className="min-w-0 space-y-3" aria-labelledby="tailnet-title">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h2 id="tailnet-title" className="text-sm font-medium">
          Other devices (tailnet)
        </h2>
        <Button size="sm" variant="outline" onClick={recheck} disabled={query.isFetching}>
          <RefreshCw /> Check again
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Open the board from your other devices and cloud agents over your tailnet, with HTTPS. Turn it on
        here; no file to edit. Your devices then sign in with passkeys of their own (Devices, below).
      </p>

      {s.signInOff && (
        <p role="status" className="rounded-md border p-3 text-sm">
          Sign-in is off on this board (BOARD_ENV={s.boardEnv}): it answers on this machine only, never
          through the tailnet, so the entrance cannot be saved here.
        </p>
      )}
      {s.fromEnv && (
        <p role="status" className="rounded-md border p-3 text-sm">
          Set in config.env (or .env): <code className="break-words">PUBLIC_ORIGIN={s.fromEnv}</code>. It wins
          over this setting, so the entrance is read-only here. Remove that line there to set it in Settings.
        </p>
      )}
      {t.funnel && (
        <p role="alert" className="rounded-md border border-destructive/50 p-3 text-sm text-destructive">
          Tailscale Funnel is on: it puts the board on the internet, which the board refuses. Turn it off (
          <code>tailscale funnel off</code>, or <code>tailscale serve reset</code>); saving is refused until
          then.
        </p>
      )}
      {s.unserved && !s.fromEnv && (
        <p role="status" className="text-sm text-muted-foreground">
          The saved entrance is not served: {s.unserved}.
        </p>
      )}

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-md border p-3 text-sm">
        <dt className="text-muted-foreground">Tailscale</dt>
        <dd>{t.installed ? (t.version ? `version ${t.version}` : 'installed') : 'not installed'}</dd>
        <dt className="text-muted-foreground">Signed in</dt>
        <dd>{t.installed ? (t.signedIn ? 'yes' : `no (${t.backend ?? 'not running'})`) : '-'}</dd>
        <dt className="text-muted-foreground">This machine</dt>
        <dd className="min-w-0 break-all">{name ?? (t.installed && t.signedIn ? 'no tailnet name' : '-')}</dd>
        <dt className="text-muted-foreground">HTTPS</dt>
        <dd>{name ? (t.https ? 'certificates on' : 'certificates off') : '-'}</dd>
        <dt className="text-muted-foreground">Serve on 443</dt>
        <dd className="min-w-0 break-all">
          {t.serve.state === 'board'
            ? `the board (${t.serve.target})`
            : t.serve.state === 'other'
              ? `${t.serve.target}`
              : 'nothing'}
        </dd>
        <dt className="text-muted-foreground">Funnel</dt>
        <dd>{t.funnel ? 'on (refused)' : 'off'}</dd>
      </dl>
      {t.error && <p className="text-xs text-muted-foreground break-all">Tailscale said: {t.error}</p>}

      <NextStep state={s} />
      <ServeStatus state={s} />

      <div className="space-y-2">
        <Label htmlFor="tailnet-origin">Entrance</Label>
        <div className="flex min-w-0 flex-wrap gap-2">
          <Input
            id="tailnet-origin"
            className="min-w-0 flex-1"
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
              Use https://{name}
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => save.mutate(value.trim())}
            disabled={locked || save.isPending || value.trim() === (s.saved ?? '')}
          >
            Save
          </Button>
          {s.saved && (
            <AlertDialog>
              <AlertDialogTrigger
                render={<Button size="sm" variant="ghost" disabled={locked || save.isPending} />}
              >
                Turn off
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Turn the tailnet entrance off?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The board stops answering on {s.saved}. Browsers signed in through that name are signed
                    out (their passkeys stay listed).
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep</AlertDialogCancel>
                  <AlertDialogAction onClick={() => save.mutate(null)}>Turn off</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Only https, a host name, no port and no path. Saved in the board&apos;s database and applied at
          once, without a restart.{' '}
          {s.served
            ? `Served now: ${s.served.origin} (${s.served.from === 'config' ? 'set in config.env' : 'from this setting'}).`
            : 'Served now: nothing; the board answers on this machine only.'}
        </p>
      </div>

      <div className="space-y-2">
        <Button variant="outline" size="sm" onClick={() => test.mutate()} disabled={test.isPending}>
          Test the entrance
        </Button>
        {check && (
          <p role="status" className={`text-sm ${check.ok ? '' : 'text-destructive'}`}>
            {check.ok ? 'Works. ' : 'Not yet. '}
            {check.message}
          </p>
        )}
      </div>
    </section>
  )
}

/** What this machine's Tailscale needs before the entrance can work, or that it is ready. */
function NextStep({ state }: { state: EntranceState }) {
  const t = state.tailscale
  const text = !t.installed
    ? 'Tailscale is not installed on this machine: install it and sign in, then check again (README: Using it from other devices).'
    : !t.signedIn
      ? `Tailscale is ${t.backend ?? 'not running'} on this machine: run tailscale up and sign in, then check again.`
      : t.name === null
        ? 'This machine has no tailnet name: turn on MagicDNS in the Tailscale admin console, then check again.'
        : !t.https
          ? `HTTPS certificates are off for ${t.name}: turn them on in the Tailscale admin console, then check again.`
          : t.serve.state === 'board'
            ? `Ready: this machine is ${t.name} on your tailnet, and serve sends it to the board.`
            : null
  if (!text) return null
  return <p className="text-sm">{text}</p>
}

/** Whether `tailscale serve` sends 443 to the board, and the command to run when it does not. */
function ServeStatus({ state }: { state: EntranceState }) {
  const t = state.tailscale
  if (!t.installed || !t.signedIn || t.name === null || t.serve.state === 'board') return null
  const other = t.serve.state === 'other'
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <p>
        {other
          ? `Port 443 of this machine serves ${t.serve.target} now. To send https://${t.name} to the board instead, run this here:`
          : `Serve is not set up yet. To open the board at https://${t.name} run this here:`}
      </p>
      <div className="flex min-w-0 items-start gap-2">
        <code className="min-w-0 flex-1 break-words rounded bg-muted px-2 py-1 text-xs">{state.command}</code>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Copy the serve command"
          onClick={() =>
            navigator.clipboard.writeText(state.command).then(
              () => toast.success('Copied'),
              () => toast.error('Could not copy'),
            )
          }
        >
          <Copy />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        The board never runs it. Then check again. To stop: <code>tailscale serve --https=443 off</code>.
      </p>
    </div>
  )
}
