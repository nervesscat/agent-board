import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { z } from 'zod'

import { AgentPicker, CopyBlock, copyText } from '#/components/AgentPicker'
import { AgentTokenList, GenerateCommands } from '#/components/AgentTokens'
import { Button } from '#/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { ReviewSkills, useShell } from '#/components/ReviewSkills'
import { AGENTS, SHELLS, type Shell, mcpSetup, skillInstall } from '#/lib/agents'
import { errorMessage, get } from '#/lib/api'
import type { AgentClient } from '#/lib/constants'
import type { Settings } from '#/server/agents'
import type { NewAgentToken } from '#/server/tokens'

// ?shell= is the shell the install lines are for (none: the one this browser remembers, else bash).
export const Route = createFileRoute('/agents')({
  component: ConnectAgents,
  validateSearch: z.object({ shell: z.enum(SHELLS).optional().catch(undefined) }),
})

type Setup = { boardUrl: string; settings: Settings }

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
        <h1 className="text-xl font-semibold tracking-tight">Connect agents</h1>
        <p className="text-sm text-muted-foreground">
          Two steps per agent CLI: connect the board&apos;s MCP server, then install the board skill. Generate
          commands first: it makes the agent&apos;s token and puts it in every command below. The skill is one
          file for every repo: it carries the table of projects and repos from the board, so install it again
          after adding a repo or project. The default CLI is set in{' '}
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
