import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Copy, ExternalLink } from 'lucide-react'
import { useEffect, useState } from 'react'

import { AgentPicker, CopyBlock, copyText } from '#/components/AgentPicker'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { ReviewSkills } from '#/components/ReviewSkills'
import { AGENTS, type Shell, mcpSetup, savedShell, saveShell, skillInstall } from '#/lib/agents'
import { errorMessage, get } from '#/lib/api'
import type { AgentClient } from '#/lib/constants'
import type { Settings } from '#/server/agents'

export const Route = createFileRoute('/agents')({ component: ConnectAgents })

type Setup = { boardUrl: string; gateUrl: string; settings: Settings }

function ConnectAgents() {
  const { data: setup } = useQuery({
    queryKey: ['agent-setup'],
    queryFn: () => get<Setup>('/api/agent-setup'),
  })
  const [client, setClient] = useState<AgentClient | null>(null)
  const [shell, setShell] = useState<Shell>(savedShell)
  // The token only fills in the commands on this page; it is never saved or sent anywhere.
  const [token, setToken] = useState('')
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
  const mcp = mcpSetup(client, setup.boardUrl, token.trim())
  const pickShell = (s: Shell) => {
    setShell(s)
    saveShell(s)
  }
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Connect agents</h1>
        <p className="text-sm text-muted-foreground">
          Two steps per agent CLI: connect the board&apos;s MCP server, then install the board skill. The
          skill is one file for every repo: it carries the table of projects and repos from the board, so
          install it again after adding a repo or project. The default CLI is set in{' '}
          <Link to="/settings" className="underline hover:text-foreground">
            Settings
          </Link>
          .
        </p>
      </div>

      <AgentPicker value={client} onChange={setClient} />

      <div className="space-y-2">
        <Label htmlFor="token">Gate token</Label>
        <div className="flex items-center gap-2">
          <Input
            id="token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="gate_… (fills in the commands below; not saved)"
            className="max-w-md font-mono text-xs"
          />
          <a
            href={`${setup.gateUrl}/devices`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground underline hover:text-foreground"
          >
            Mint one <ExternalLink className="size-3" />
          </a>
        </div>
        <p className="text-xs text-muted-foreground">
          Mint one token per agent: its name is the agent&apos;s name on the board (claude, codex, …).
        </p>
      </div>

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
        <CopyBlock text={skillInstall(client, shell, setup.boardUrl, token.trim())} />
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
        <ReviewSkills boardUrl={setup.boardUrl} token={token} />
      </section>
    </div>
  )
}
