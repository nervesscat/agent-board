import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, Eye, EyeOff, KeyRound } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
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

/**
 * The Agents section of Settings: every agent token (an identity on the board) with its role, the
 * switch that makes it an orchestrator or a worker again, when it was last used, and Revoke; under
 * each, the sub-identities seen working under it (`<token>/<name>`, always workers), a long list
 * folded to its first few rows. Only the human sees it, and only the human's calls change a role
 * (api.ts).
 */
export function AgentIdentities() {
  const { t } = useTranslation()
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
    onSuccess: (tok) => {
      toast.success(
        tok.role === 'orchestrator'
          ? t('tokens.identities.nowOrchestrator', { name: tok.name })
          : t('tokens.identities.nowWorker', { name: tok.name }),
      )
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
    <section aria-label={t('tokens.title')} className="space-y-2">
      <h2 className="text-sm font-medium">{t('tokens.title')}</h2>
      <p className="text-sm text-muted-foreground">{t('tokens.identities.text')}</p>
      {tokens.error && <p className="text-xs text-destructive">{errorMessage(tokens.error)}</p>}
      {tokens.data?.length === 0 && (
        <p className="text-xs text-muted-foreground">{t('tokens.identities.empty')}</p>
      )}
      {!!tokens.data?.length && (
        <ul className="divide-y rounded-md border text-sm">
          {tokens.data.map((tk) => {
            const subs = subsOf(tk.name)
            const orchestrator = tk.role === 'orchestrator'
            return (
              <li
                key={tk.id}
                aria-label={t('tokens.identities.agentAria', { name: tk.name })}
                className="space-y-2 px-3 py-2"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1 basis-40">
                    <div className="flex flex-wrap items-center gap-1.5 font-medium">
                      <span className="wrap-anywhere">{tk.name}</span>
                      <RoleBadge role={tk.role} />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {tk.lastUsedAt
                        ? t('tokens.lastUsed', { when: ago(tk.lastUsedAt) })
                        : t('tokens.neverUsed')}
                    </div>
                  </div>
                  <Tip content={t('tokens.identities.orchestratorTip')}>
                    <label className="flex items-center gap-2 text-xs">
                      <Switch
                        size="sm"
                        checked={orchestrator}
                        disabled={setRole.isPending}
                        aria-label={t('tokens.identities.orchestratorAria', { name: tk.name })}
                        onCheckedChange={(on) =>
                          setRole.mutate({ id: tk.id, role: on ? 'orchestrator' : 'worker' })
                        }
                      />
                      {t('tokens.identities.orchestrator')}
                    </label>
                  </Tip>
                  <AlertDialog>
                    <AlertDialogTrigger
                      render={
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t('tokens.identities.revokeAria', { name: tk.name })}
                        />
                      }
                    >
                      {t('connect.revoke')}
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t('tokens.revokeTitle', { name: tk.name })}</AlertDialogTitle>
                        <AlertDialogDescription>{t('tokens.identities.revokeText')}</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t('connect.keep')}</AlertDialogCancel>
                        <AlertDialogAction onClick={() => revoke.mutate(tk.id)}>
                          {t('connect.revoke')}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
                {subs.length > 0 && <Workers token={tk.name} subs={subs} />}
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
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const listId = useId()
  const more = subs.length > WORKERS_SHOWN
  const shown = open || !more ? subs : subs.slice(0, WORKERS_SHOWN)
  // One icon-only toggle, the same filled button in both states: an eye for the rows the list hides
  // (press to show them), an eye with a line once they are shown (press to hide them again).
  const label = open ? t('tokens.identities.hide') : t('tokens.identities.show', { count: subs.length })
  return (
    <div className="ml-7 space-y-1 border-l pl-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="flex flex-wrap items-center gap-x-1.5 text-xs font-medium text-muted-foreground">
          {t('tokens.identities.workingUnder', { token })}
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
      <ul id={listId} aria-label={t('tokens.identities.workingUnder', { token })} className="space-y-1">
        {shown.map((a) => (
          <li key={a.name} className="flex flex-wrap items-center gap-x-1.5 text-xs">
            <Bot className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="font-medium wrap-anywhere">{a.name}</span>
            <RoleBadge role={a.role} />
            {a.lastSeenAt && (
              <span className="text-muted-foreground">
                {t('tokens.identities.seen', { when: ago(a.lastSeenAt) })}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
