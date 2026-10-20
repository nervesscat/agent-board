import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Sparkles } from 'lucide-react'
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
      <Label htmlFor="agent-token-name">Agent name</Label>
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
          <Sparkles data-icon="inline-start" /> Generate commands
        </Button>
      </form>
      <p className="text-xs text-muted-foreground" role={token ? 'status' : undefined}>
        {token ? (
          <>
            The commands below carry a new token for <strong>{token.name}</strong>, valid until{' '}
            {stamp(token.expiresAt)}. It is shown this once: copy what you need now. Leaving the page loses
            it; pressing again makes another.
          </>
        ) : (
          <>
            Makes a token for this agent and fills it into every command on this page. The name is the
            agent&apos;s name on the board. A token signs in for 1 year, unless revoked, and is shown only
            once.
          </>
        )}
      </p>
    </div>
  )
}

/** The agent tokens not revoked, with when each was made, last used and expires, and Revoke. */
export function AgentTokenList() {
  const qc = useQueryClient()
  const tokens = useQuery({ queryKey: TOKENS, queryFn: () => get<AgentTokenRow[]>('/api/agent-tokens') })
  const revoke = useMutation({
    mutationFn: (id: number) => del(`/api/agent-tokens/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: TOKENS }),
    onError: (err) => toast.error(errorMessage(err)),
  })
  const now = Date.now()
  return (
    <section className="space-y-2" aria-labelledby="agent-tokens-title">
      <h2 id="agent-tokens-title" className="text-sm font-medium">
        Agent tokens
      </h2>
      <p className="text-xs text-muted-foreground">
        The tokens the commands above carry. Revoke one and the agent using it is signed out at its next
        request.
      </p>
      {tokens.error && <p className="text-xs text-destructive">{errorMessage(tokens.error)}</p>}
      {tokens.data?.length === 0 && <p className="text-xs text-muted-foreground">None yet.</p>}
      {!!tokens.data?.length && (
        <ul className="divide-y rounded-md border text-sm" aria-label="Agent tokens">
          {tokens.data.map((t) => {
            const expired = Date.parse(t.expiresAt) <= now
            return (
              <li key={t.id} className="flex items-center gap-3 px-3 py-2">
                <KeyRound className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{t.name}</div>
                  <div className="text-xs text-muted-foreground">
                    made {ago(t.createdAt)} · {t.lastUsedAt ? `last used ${ago(t.lastUsedAt)}` : 'never used'}{' '}
                    · {expired ? 'expired' : 'expires'} {stamp(t.expiresAt)}
                  </div>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger
                    render={
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Revoke ${t.name}, made ${ago(t.createdAt)}`}
                      />
                    }
                  >
                    Revoke
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Revoke {t.name}&apos;s token?</AlertDialogTitle>
                      <AlertDialogDescription>
                        The agent using it is refused from its next request on. Generate commands again to
                        connect it with a new one.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep</AlertDialogCancel>
                      <AlertDialogAction onClick={() => revoke.mutate(t.id)}>Revoke</AlertDialogAction>
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
