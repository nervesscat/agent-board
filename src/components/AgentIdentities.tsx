import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, Eye, EyeOff, KeyRound } from 'lucide-react'
import { useId, useState } from 'react'
import { toast } from 'sonner'

import { RoleBadge } from '#/components/Actor'
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
import { Switch } from '#/components/ui/switch'
import { Tip } from '#/components/ui/tooltip'
import { type ActorRow, type AgentTokenRow, del, errorMessage, get, patch } from '#/lib/api'
import { ago } from '#/lib/format'

const ORCHESTRATOR_TIP =
  "An orchestrator also changes the projects' instructions; each change waits in your Needs you until you review or revert it. Its subagents that say who they are (<token>/<name>) stay workers."

/**
 * The Agents section of Settings: every agent token (an identity on the board) with its role, the
 * switch that makes it an orchestrator or a worker again, when it was last used, and Revoke; under
 * each, the sub-identities seen working under it (`<token>/<name>`, always workers), a long list
 * folded to its first few rows. Only the human sees it, and only the human's calls change a role
 * (api.ts).
 */
export function AgentIdentities() {
  const qc = useQueryClient()
  const tokens = useQuery({
    queryKey: ['agent-tokens'],
    queryFn: () => get<AgentTokenRow[]>('/api/agent-tokens'),
  })
  const actors = useQuery({ queryKey: ['actors'], queryFn: () => get<ActorRow[]>('/api/actors') })
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['agent-tokens'] })
    void qc.invalidateQueries({ queryKey: ['actors'] })
  }
  const setRole = useMutation({
    mutationFn: ({ id, role }: { id: number; role: AgentTokenRow['role'] }) =>
      patch<AgentTokenRow>(`/api/agent-tokens/${id}`, { role }),
    onSuccess: (t) => {
      toast.success(t.role === 'orchestrator' ? `${t.name} is an orchestrator` : `${t.name} is a worker`)
      refresh()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const revoke = useMutation({
    mutationFn: (id: number) => del(`/api/agent-tokens/${id}`),
    onSuccess: refresh,
    onError: (err) => toast.error(errorMessage(err)),
  })
  const subsOf = (token: string) =>
    (actors.data ?? []).filter((a) => a.kind === 'agent' && a.name.startsWith(`${token}/`))

  return (
    <section aria-label="Agent tokens" className="space-y-2">
      <h2 className="text-sm font-medium">Agent tokens</h2>
      <p className="text-sm text-muted-foreground">
        Who is who: each agent token is an identity on the board, a worker unless you make it an orchestrator.
        Its subagents that name themselves under it are listed with it, always as workers; a long list starts
        folded, with a button for the rest.
      </p>
      {tokens.error && <p className="text-xs text-destructive">{errorMessage(tokens.error)}</p>}
      {tokens.data?.length === 0 && (
        <p className="text-xs text-muted-foreground">No agent tokens yet: Connect an agent makes them.</p>
      )}
      {!!tokens.data?.length && (
        <ul className="divide-y rounded-md border text-sm">
          {tokens.data.map((t) => {
            const subs = subsOf(t.name)
            const orchestrator = t.role === 'orchestrator'
            return (
              <li key={t.id} aria-label={`Agent ${t.name}`} className="space-y-2 px-3 py-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1 basis-40">
                    <div className="flex flex-wrap items-center gap-1.5 font-medium">
                      <span className="wrap-anywhere">{t.name}</span>
                      <RoleBadge role={t.role} />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t.lastUsedAt ? `last used ${ago(t.lastUsedAt)}` : 'never used'}
                    </div>
                  </div>
                  <Tip content={ORCHESTRATOR_TIP}>
                    <label className="flex items-center gap-2 text-xs">
                      <Switch
                        size="sm"
                        checked={orchestrator}
                        disabled={setRole.isPending}
                        aria-label={`${t.name}: orchestrator`}
                        onCheckedChange={(on) =>
                          setRole.mutate({ id: t.id, role: on ? 'orchestrator' : 'worker' })
                        }
                      />
                      Orchestrator
                    </label>
                  </Tip>
                  <AlertDialog>
                    <AlertDialogTrigger
                      render={<Button size="sm" variant="ghost" aria-label={`Revoke ${t.name}`} />}
                    >
                      Revoke
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Revoke {t.name}&apos;s token?</AlertDialogTitle>
                        <AlertDialogDescription>
                          The agent using it, and every subagent working under it, is refused from its next
                          request on. Generate commands again on Connect an agent to connect it with a new
                          one.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Keep</AlertDialogCancel>
                        <AlertDialogAction onClick={() => revoke.mutate(t.id)}>Revoke</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
                {subs.length > 0 && <Workers token={t.name} subs={subs} />}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/** How many of a token's workers a folded list shows: the first few rows, as the Overview cards do. */
const WORKERS_SHOWN = 3

/**
 * The workers seen under a token (`<token>/<name>`, always workers). A long list starts folded — its
 * count in the header and its first few rows showing, the rest behind an eye button that fills like the
 * one that folds it back — so a page of agents stays short. The token's own row stays visible: it is the
 * identity the human makes an orchestrator or revokes. Unfolded rows are not in the page at all, so the
 * page scrolls, never the list.
 */
function Workers({ token, subs }: { token: string; subs: ActorRow[] }) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  const more = subs.length > WORKERS_SHOWN
  const shown = open || !more ? subs : subs.slice(0, WORKERS_SHOWN)
  // One icon-only toggle, the same filled button in both states: an eye for the rows the list hides
  // (press to show them), an eye with a line once they are shown (press to hide them again).
  const label = open ? 'Hide the agents' : `Show the ${subs.length} agents`
  return (
    <div className="ml-7 space-y-1 border-l pl-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="flex flex-wrap items-center gap-x-1.5 text-xs font-medium text-muted-foreground">
          Working under {token}
          <span className="rounded-full bg-muted px-1.5 font-normal tabular-nums">{subs.length}</span>
        </h3>
        {more && (
          <Tip content={label}>
            <Button
              type="button"
              variant="secondary"
              size="icon-sm"
              className="ml-auto"
              aria-expanded={open}
              aria-controls={listId}
              aria-label={label}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
            </Button>
          </Tip>
        )}
      </div>
      <ul id={listId} aria-label={`Working under ${token}`} className="space-y-1">
        {shown.map((a) => (
          <li key={a.name} className="flex flex-wrap items-center gap-x-1.5 text-xs">
            <Bot className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="font-medium wrap-anywhere">{a.name}</span>
            <RoleBadge role={a.role} />
            {a.lastSeenAt && <span className="text-muted-foreground">seen {ago(a.lastSeenAt)}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}
