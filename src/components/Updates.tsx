import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Copy } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Label } from '#/components/ui/label'
import { Progress } from '#/components/ui/progress'
import { Switch } from '#/components/ui/switch'
import { Tip } from '#/components/ui/tooltip'
import { errorMessage, get, type Me, patch, post } from '#/lib/api'
import { ago } from '#/lib/format'
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
  const { data } = useUpdates()
  // Read after mount: the update can be found before React has hydrated the top bar.
  const hydrated = useHydrated()
  if (!hydrated || !updateOffered(data)) return null
  return (
    <Tip content={`CrossBoard ${data.newest.version} is available (${data.installed} installed)`}>
      <Link to="/settings" hash="updates" className="shrink-0" aria-label="Update available">
        <Badge variant="secondary">Update</Badge>
      </Link>
    </Tip>
  )
}

/** The Updates section of Settings: under the desktop app its updater, from a checkout how to update. */
export function Updates() {
  const { data } = useUpdates()
  if (!data) return null
  return (
    <section id="updates" className="scroll-mt-16 space-y-3" aria-labelledby="updates-title">
      <h2 id="updates-title" className="text-sm font-medium">
        Updates
      </h2>
      {data.mode === 'checkout' ? <CheckoutUpdates /> : <DesktopUpdatesSection state={data} />}
    </section>
  )
}

function CheckoutUpdates() {
  return (
    <p className="text-sm text-muted-foreground">
      This board runs from a checkout, which has no updater. To update it, run <code>git pull</code> on{' '}
      <code>main</code> in that checkout, then <code>pnpm start</code> (README: "Running it"). Only the
      desktop app checks for and installs new versions from here.
    </p>
  )
}

function DesktopUpdatesSection({ state }: { state: DesktopUpdates }) {
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
        <dt className="text-muted-foreground">Installed</dt>
        <dd data-testid="updates-installed">CrossBoard {state.installed}</dd>
        <dt className="text-muted-foreground">Newest release</dt>
        <dd data-testid="updates-newest">{newestText(state)}</dd>
      </dl>
      {unsupported ? (
        <p className="text-muted-foreground">
          This copy of the app cannot update itself: it runs from an unpacked folder, not from its installer
          or a package. Install a release from GitHub to get updates here.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => check.mutate()}
            disabled={busy || check.isPending}
          >
            {state.status === 'checking' ? 'Checking…' : 'Check now'}
          </Button>
          {offered && (
            <Button size="sm" onClick={() => install.mutate()} disabled={install.isPending}>
              Download and install
            </Button>
          )}
        </div>
      )}
      {state.status === 'downloading' && (
        <Progress value={state.progress?.percent ?? 0} aria-label="Download">
          <span className="text-muted-foreground">
            Downloading {state.newest?.version}… {state.progress?.percent ?? 0}%
          </span>
        </Progress>
      )}
      {state.status === 'installing' && (
        <p role="status">
          Installing {state.newest?.version}: the board stops for a moment and the app starts again as the new
          version.
        </p>
      )}
      {state.error && (
        <p role="alert" className="text-destructive [overflow-wrap:anywhere]">
          {state.error}
        </p>
      )}
      {state.manual && <ManualCommand command={state.manual.command} />}
      {updateOffered(state) && state.newest.notes && (
        <div className="space-y-1">
          <h3 className="text-xs font-medium text-muted-foreground">What's new in {state.newest.version}</h3>
          <div
            data-testid="updates-notes"
            className="max-h-64 overflow-auto rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]"
          >
            {state.newest.notes}
          </div>
        </div>
      )}
      {!unsupported && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Switch
              id="updates-auto-check"
              checked={state.settings.autoCheck}
              onCheckedChange={(autoCheck) => settings.mutate({ autoCheck })}
              disabled={settings.isPending}
            />
            <Label htmlFor="updates-auto-check">Check for updates at start and every six hours</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="updates-prereleases"
              checked={state.settings.prereleases}
              onCheckedChange={(prereleases) => settings.mutate({ prereleases })}
              disabled={settings.isPending}
            />
            <Label htmlFor="updates-prereleases">Include pre-releases (0.3.0-beta.1 and the like)</Label>
          </div>
          <p className="text-xs text-muted-foreground">
            Nothing is downloaded or installed until you press Download and install. Each download is checked
            against the sha512 in the release's metadata first.
          </p>
        </div>
      )}
    </div>
  )
}

function newestText(state: DesktopUpdates) {
  if (state.newest) return `CrossBoard ${state.newest.version}`
  if (state.status === 'checking') return 'Checking…'
  if (!state.checkedAt) return 'Not checked yet'
  if (state.status === 'none') return `None newer (checked ${ago(state.checkedAt)})`
  return `Unknown (checked ${ago(state.checkedAt)})`
}

/** The command that installs the downloaded package, for when polkit could not. */
function ManualCommand({ command }: { command: string }) {
  return (
    <div className="space-y-1">
      <p>Run this in a terminal to install it, then start the app again:</p>
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
          aria-label="Copy the command"
          onClick={() =>
            navigator.clipboard.writeText(command).then(
              () => toast.success('Copied'),
              () => toast.error('Could not copy'),
            )
          }
        >
          <Copy />
        </Button>
      </div>
    </div>
  )
}
