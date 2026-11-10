import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { CheckCircle2, Copy, RefreshCw, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'

import { AgentPicker, CopyBlock, copyText } from '#/components/AgentPicker'
import { AgentTokenList, GenerateCommands } from '#/components/AgentTokens'
import { Button } from '#/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { ReviewSkills, useShell } from '#/components/ReviewSkills'
import { AGENTS, SHELLS, type Shell, mcpSetup, skillInstall } from '#/lib/agents'
import { errorMessage, get, post } from '#/lib/api'
import type { AgentClient } from '#/lib/constants'
import type { Settings } from '#/server/agents'
import type { OpencodeConfig } from '#/server/opencodeConfig'
import type { NewAgentToken } from '#/server/tokens'

// ?shell= is the shell the install lines are for (none: the one this browser remembers, else bash).
export const Route = createFileRoute('/agents')({
  component: ConnectAgents,
  validateSearch: z.object({ shell: z.enum(SHELLS).optional().catch(undefined) }),
})

type Setup = { boardUrl: string; settings: Settings; opencode: OpencodeConfig }

function ConnectAgents() {
  const { data: setup } = useQuery({
    queryKey: ['agent-setup'],
    queryFn: () => get<Setup>('/api/agent-setup'),
  })
  const [client, setClient] = useState<AgentClient | null>(null)
  const [shell, pickShell] = useShell()
  // The token "Generate commands" made: shown once, in the commands on this page, never stored here.
  const [made, setMade] = useState<NewAgentToken | null>(null)
  const token = made?.token ?? ''
  useEffect(() => {
    if (setup && !client) setClient(setup.settings.defaultAgent)
  }, [setup, client])
  const skill = useQuery({
    queryKey: ['agent-skill', client],
    queryFn: async () => {
      const r = await fetch(`/api/agent-setup/skill?client=${client}`)
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
      return r.text()
    },
    enabled: Boolean(client),
  })
  if (!setup || !client) return null
  const agent = AGENTS[client]
  const mcp = mcpSetup(client, setup.boardUrl, token)
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Connect an agent</h1>
        <p className="text-sm text-muted-foreground">
          Connect a CLI, then install the skill. Generate commands first. The default CLI is set in{' '}
          <Link to="/settings" className="underline hover:text-foreground">
            Settings
          </Link>
          .
        </p>
      </div>

      <AgentPicker
        value={client}
        onChange={(c) => {
          // A token is one agent's: another CLI starts again from its own name, with no token.
          setClient(c)
          setMade(null)
        }}
      />

      {client === 'opencode' && <OpencodeDelegation config={setup.opencode} />}

      {/* Keyed by the CLI: another CLI's field is a new one, and a press of the old one hands over nothing. */}
      <GenerateCommands key={client} defaultName={client} token={made} onToken={setMade} />

      <section className="space-y-2">
        <h2 className="text-sm font-medium">1. Connect the MCP server</h2>
        <p className="text-xs text-muted-foreground">
          {mcp.kind === 'command' ? (
            <>Run once in a terminal; it registers the server for every repo.</>
          ) : (
            <>
              Add to <code className="rounded bg-muted px-1">{agent.mcpFile}</code>
              {client === 'opencode' && ' (merge the board entry into "mcp" if the file already has one)'}.
            </>
          )}
        </p>
        <CopyBlock text={mcp.text} />
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">2. Install the skill</h2>
          <Tabs value={shell} onValueChange={(v) => pickShell(v as Shell)}>
            <TabsList>
              <TabsTrigger value="bash">bash / zsh</TabsTrigger>
              <TabsTrigger value="powershell">PowerShell</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <p className="text-xs text-muted-foreground">
          Downloads the board&apos;s current skill to{' '}
          <code className="rounded bg-muted px-1">
            {shell === 'bash' ? agent.skillDir.unix : agent.skillDir.windows}/SKILL.md
          </code>
          , where {agent.label} finds it in every repo.
          {client === 'codex' && ' OpenCode reads this folder too.'}
          {client === 'opencode' &&
            ' OpenCode also reads ~/.claude/skills: skip this if Claude Code has it already.'}
        </p>
        <CopyBlock text={skillInstall(client, shell, setup.boardUrl, token)} />
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!skill.data}
            onClick={() => skill.data && copyText(skill.data, 'SKILL.md copied')}
          >
            <Copy data-icon="inline-start" /> Copy SKILL.md
          </Button>
          {skill.error && <span className="text-xs text-destructive">{errorMessage(skill.error)}</span>}
        </div>
        {skill.data && (
          <details className="rounded-md border">
            <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">
              Preview SKILL.md
            </summary>
            <pre className="max-h-96 overflow-auto border-t p-3 font-mono text-xs whitespace-pre-wrap">
              {skill.data}
            </pre>
          </details>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">3. Install the review skills (Claude Code)</h2>
        <ReviewSkills boardUrl={setup.boardUrl} token={token} shell={shell} onShellChange={pickShell} />
      </section>

      <AgentTokenList />
    </div>
  )
}

/**
 * Whether OpenCode can run a subagent from inside a subagent, read from its config on the board's machine:
 * off (the default) with the snippet that turns it on and the file it read, on with the depth and where it
 * came from, or a file that could not be read. "Check again" re-reads it after the human edits the file;
 * the board never writes it.
 */
function OpencodeDelegation({ config }: { config: OpencodeConfig }) {
  const queryClient = useQueryClient()
  const check = useMutation({
    mutationFn: () => post<OpencodeConfig>('/api/agent-setup/opencode-check'),
    onSuccess: (opencode) =>
      queryClient.setQueryData<Setup>(['agent-setup'], (old) => (old ? { ...old, opencode } : old)),
    onError: (err) => toast.error(errorMessage(err)),
  })
  const again = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label="Check the OpenCode config again"
      disabled={check.isPending}
      onClick={() => check.mutate()}
    >
      <RefreshCw data-icon="inline-start" className={check.isPending ? 'animate-spin' : ''} /> Check again
    </Button>
  )

  if (config.error && !config.set)
    return (
      <section
        aria-label="OpenCode multilevel delegation"
        className="flex items-start gap-2 rounded-md border border-rose-300/60 bg-rose-50 p-3 text-rose-950 dark:border-rose-400/20 dark:bg-rose-950/40 dark:text-rose-100"
      >
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-rose-600 dark:text-rose-400" aria-hidden />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm font-medium">Could not read the OpenCode config</p>
          <p className="text-xs [overflow-wrap:anywhere]">{config.error}</p>
          <p className="text-xs">
            Fix that file, then check again. Multilevel delegation stays off until the config can be read.
          </p>
          {again}
        </div>
      </section>
    )

  if (config.set)
    return (
      <section
        aria-label="OpenCode multilevel delegation"
        className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
      >
        <div className="min-w-0 space-y-1">
          <p className="flex items-center gap-1.5 text-sm">
            <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
            <span>Multilevel delegation on (depth {config.depth})</span>
          </p>
          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
            Read from <code className="rounded bg-muted px-1">{config.source}</code>.
          </p>
          {config.error && (
            <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{config.error}</p>
          )}
        </div>
        {again}
      </section>
    )

  return (
    <section
      aria-label="OpenCode multilevel delegation"
      className="rounded-md border border-amber-300/60 bg-amber-50 p-3 text-amber-950 dark:border-amber-400/20 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm font-medium">
            Multilevel delegation is off: subagents cannot launch subagents
          </p>
          <p className="text-xs [overflow-wrap:anywhere]">
            Add this to <code className="rounded bg-black/10 px-1 dark:bg-white/10">{config.source}</code>{' '}
            (inside its <code className="rounded bg-black/10 px-1 dark:bg-white/10">experimental</code> block
            if it has one), then restart OpenCode. The last config file that defines an{' '}
            <code className="rounded bg-black/10 px-1 dark:bg-white/10">experimental</code> block decides, so
            a later one can override an earlier depth. The board only reads the file.
          </p>
          <CopyBlock text={'"experimental": { "subagent_depth": 2 }'} label="Copy snippet" />
          {again}
        </div>
      </div>
    </section>
  )
}
