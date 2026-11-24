import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Sparkles } from 'lucide-react'
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
import { RoleBadge } from '#/components/Actor'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { AGENT_TOKEN_NAME } from '#/lib/agents'
import { del, errorMessage, get, post } from '#/lib/api'
import { ago, stamp } from '#/lib/format'
import type { AgentTokenRow, NewAgentToken } from '#/server/tokens'

const TOKENS = ['agent-tokens']

/**
 * The name field and "Generate commands": the board makes a token named after the agent (`defaultName`,
 * the CLI, until the human types another) and `onToken` fills it into the page's commands. Nothing is
 * made until the button is pressed; each press makes a new token. The board keeps only its hash, so the
 * token is in these commands once, and leaving the page loses it.
 */
export function GenerateCommands({
  defaultName,
  token,
  onToken,
}: {
  defaultName: string
  token: NewAgentToken | null
  onToken: (token: NewAgentToken) => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [typed, setTyped] = useState<string | null>(null)
  const name = typed ?? defaultName
  const valid = AGENT_TOKEN_NAME.test(name.trim())
  const mint = useMutation({
    mutationFn: () => post<NewAgentToken>('/api/agent-tokens', { name: name.trim() }),
    // The list shows a new token whatever happens to this field.
    onSettled: () => qc.invalidateQueries({ queryKey: TOKENS }),
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <div className="space-y-2">
      <Label htmlFor="agent-token-name">{t('connect.generate.agentName')}</Label>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          // Handed over only while this field is still on the page: a token that answers after the
          // page moved to another agent (which remounts it) never fills that agent's commands.
          if (valid) mint.mutate(undefined, { onSuccess: onToken })
        }}
      >
        <Input
          id="agent-token-name"
          autoComplete="off"
          spellCheck={false}
          value={name}
          maxLength={40}
          onChange={(e) => setTyped(e.target.value)}
          className="max-w-48 font-mono text-xs"
          aria-invalid={!valid}
        />
        <Button type="submit" disabled={!valid || mint.isPending}>
          <Sparkles data-icon="inline-start" /> {t('connect.generate.button')}
        </Button>
      </form>
      <p className="text-xs text-muted-foreground" role={token ? 'status' : undefined}>
        {token ? (
          <Trans
            i18nKey={
              token.role === 'orchestrator'
                ? 'connect.generate.newOrchestrator'
                : 'connect.generate.newWorker'
            }
            values={{ name: token.name, until: stamp(token.expiresAt) }}
            components={{ strong: <strong /> }}
          />
        ) : (
          <Trans i18nKey="connect.generate.intro" components={{ strong: <strong /> }} />
        )}
      </p>
    </div>
  )
}

/** The agent tokens not revoked, with when each was made, last used and expires, and Revoke. */
export function AgentTokenList() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const tokens = useQuery({ queryKey: TOKENS, queryFn: () => get<AgentTokenRow[]>('/api/agent-tokens') })
  const revoke = useMutation({
    mutationFn: (id: number) => del(`/api/agent-tokens/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: TOKENS }),
    onError: (err) => toast.error(errorMessage(err)),
  })
  const now = Date.now()
  return (
    <section id="agent-tokens" className="scroll-mt-16 space-y-2" aria-labelledby="agent-tokens-title">
      <h2 id="agent-tokens-title" className="text-sm font-medium">
        {t('tokens.title')}
      </h2>
      <p className="text-xs text-muted-foreground">{t('tokens.listText')}</p>
      {tokens.error && <p className="text-xs text-destructive">{errorMessage(tokens.error)}</p>}
      {tokens.data?.length === 0 && <p className="text-xs text-muted-foreground">{t('tokens.none')}</p>}
      {!!tokens.data?.length && (
        <ul className="divide-y rounded-md border text-sm" aria-label={t('tokens.title')}>
          {tokens.data.map((tk) => {
            const expired = Date.parse(tk.expiresAt) <= now
            const used = tk.lastUsedAt
              ? t('tokens.lastUsed', { when: ago(tk.lastUsedAt) })
              : t('tokens.neverUsed')
            return (
              <li key={tk.id} className="flex items-center gap-3 px-3 py-2">
                <KeyRound className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 font-medium">
                    {tk.name}
                    <RoleBadge role={tk.role} />
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t(expired ? 'tokens.metaExpired' : 'tokens.meta', {
                      made: ago(tk.createdAt),
                      used,
                      at: stamp(tk.expiresAt),
                    })}
                  </div>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger
                    render={
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t('tokens.revokeAria', { name: tk.name, when: ago(tk.createdAt) })}
                      />
                    }
                  >
                    {t('connect.revoke')}
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t('tokens.revokeTitle', { name: tk.name })}</AlertDialogTitle>
                      <AlertDialogDescription>{t('tokens.revokeText')}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t('connect.keep')}</AlertDialogCancel>
                      <AlertDialogAction onClick={() => revoke.mutate(tk.id)}>
                        {t('connect.revoke')}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
