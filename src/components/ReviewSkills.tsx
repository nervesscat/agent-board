import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { CopyBlock } from '#/components/AgentPicker'
import { Tabs, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { type Shell, reviewSkillsInstall, savedShell, saveShell } from '#/lib/agents'
import { get } from '#/lib/api'

/**
 * The one-line install of the feature-review and review-queue skills and their agents, which run the
 * default agents' cycle. Without a token the line carries the placeholder to replace.
 */
export function ReviewSkills({ boardUrl, token = '' }: { boardUrl: string; token?: string }) {
  const [shell, setShell] = useState<Shell>(savedShell)
  const { data: paths = [] } = useQuery({
    queryKey: ['review-skills'],
    queryFn: () => get<string[]>('/api/agent-setup/review-skills?list'),
  })
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          <code className="rounded bg-muted px-1">/review-queue</code> is the orchestrator: it works the board
          and delegates to these agents. <code className="rounded bg-muted px-1">/feature-review</code> is the
          review it runs on each change. One line installs both, with their agents, into{' '}
          <code className="rounded bg-muted px-1">~/.claude</code> (Claude Code; OpenCode reads its skills
          too), replacing files of the same name.
          {!token && (
            <>
              {' '}
              Put your token in place of <code className="rounded bg-muted px-1">gate_…</code>.
            </>
          )}
        </p>
        <Tabs
          value={shell}
          onValueChange={(v) => {
            setShell(v as Shell)
            saveShell(v as Shell)
          }}
        >
          <TabsList>
            <TabsTrigger value="bash">bash / zsh</TabsTrigger>
            <TabsTrigger value="powershell">PowerShell</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <CopyBlock text={reviewSkillsInstall(shell, boardUrl, token.trim())} />
      {paths.length > 0 && (
        <details className="rounded-md border">
          <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">
            {paths.length} files it installs
          </summary>
          <ul className="border-t p-3 font-mono text-xs text-muted-foreground">
            {paths.map((p) => (
              <li key={p}>~/.claude/{p}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
