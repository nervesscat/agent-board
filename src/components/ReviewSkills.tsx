import { useQuery } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'

import { CopyBlock } from '#/components/AgentPicker'
import { Tabs, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { SHELLS, SHELL_KEY, type Shell, reviewSkillsInstall } from '#/lib/agents'
import { get } from '#/lib/api'
import { remember, useRestoreRemembered } from '#/lib/remembered'

/**
 * The shell the install lines are for, on a page whose route takes `?shell=` (Connect agents, a
 * project's Agents): the one in the URL, else the one this browser remembers, else bash. Storage is
 * read only after mount, so the server's render and the browser's agree (as with the PR queue filter).
 * Returns the shell and how to pick another, which the URL and this browser keep.
 */
export function useShell() {
  const { shell: picked } = useSearch({ strict: false })
  const navigate = useNavigate()
  const show = (shell: Shell) =>
    navigate({ to: '.', search: (s: Record<string, unknown>) => ({ ...s, shell }), replace: true })
  useRestoreRemembered(SHELL_KEY, picked, SHELLS, show)
  const pick = (shell: Shell) => {
    show(shell)
    remember(SHELL_KEY, shell)
  }
  return [picked ?? 'bash', pick] as const
}

/**
 * The one-line install of the feature-review, review-queue and todo-review skills and their agents, which run the
 * default agents' cycle, for the page's shell (`useShell`). Without a token the line carries the
 * placeholder to replace.
 */
export function ReviewSkills({
  boardUrl,
  token = '',
  shell,
  onShellChange,
}: {
  boardUrl: string
  token?: string
  shell: Shell
  onShellChange: (shell: Shell) => void
}) {
  const { data: paths = [] } = useQuery({
    queryKey: ['review-skills'],
    queryFn: () => get<string[]>('/api/agent-setup/review-skills?list'),
  })
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          <code className="rounded bg-muted px-1">/todo-review</code> works the To do tickets to hand-off and{' '}
          <code className="rounded bg-muted px-1">/review-queue</code> reviews the PR queue, both delegating
          to these agents. <code className="rounded bg-muted px-1">/feature-review</code> is the review they
          run on each change. One line installs all three, with their agents, into{' '}
          <code className="rounded bg-muted px-1">~/.claude</code> (Claude Code; OpenCode reads its skills
          too), replacing files of the same name.
          {!token && (
            <>
              {' '}
              Put your token in place of <code className="rounded bg-muted px-1">gate_…</code>.
            </>
          )}
        </p>
        <Tabs value={shell} onValueChange={(v) => onShellChange(v as Shell)}>
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
