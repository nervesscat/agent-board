import { useQuery } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { ChevronRight, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import { CopyBlock } from '#/components/AgentPicker'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { SHELLS, SHELL_KEY, type Shell, repoClaudeDir, reviewSkillsInstall } from '#/lib/agents'
import { errorMessage, get } from '#/lib/api'
import { remember, useRestoreRemembered } from '#/lib/remembered'
import type { RepoSkills as RepoSkillsRow, ReviewSkillsStatus } from '#/server/agents'

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
 * placeholder to replace. Below it, whether each repo (every repo, or `projectId`'s) has its own copy,
 * and whether that copy is current.
 */
export function ReviewSkills({
  boardUrl,
  token = '',
  shell,
  onShellChange,
  projectId,
}: {
  boardUrl: string
  token?: string
  shell: Shell
  onShellChange: (shell: Shell) => void
  projectId?: string
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
      <RepoSkills boardUrl={boardUrl} token={token.trim()} shell={shell} projectId={projectId} />
    </div>
  )
}

const STATUS_LABEL: Record<RepoSkillsRow['status'], string> = {
  current: 'Up to date',
  outdated: 'Outdated',
  none: 'Not installed in the repo',
  unreachable: "Can't read the checkout",
}

/**
 * The repos' own copies of the review skills, read from each checkout's `.claude` when the page loads
 * and on Check again. An outdated copy opens to the files that are not current and the line that
 * brings it up to date.
 */
function RepoSkills({
  boardUrl,
  token,
  shell,
  projectId,
}: {
  boardUrl: string
  token: string
  shell: Shell
  projectId?: string
}) {
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ['review-skills-status', projectId ?? 'all'],
    queryFn: () =>
      get<ReviewSkillsStatus>(
        `/api/agent-setup/review-skills/status${projectId ? `?projectId=${projectId}` : ''}`,
      ),
  })
  return (
    <section className="space-y-2" aria-label="In your repos">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium">In your repos</h3>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw data-icon="inline-start" className={isFetching ? 'animate-spin' : ''} /> Check again
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        A repo can carry its own copy in its <code className="rounded bg-muted px-1">.claude</code> folder,
        which Claude Code uses there instead of the one in{' '}
        <code className="rounded bg-muted px-1">~/.claude</code>. An outdated copy has a line that installs
        these files into that repo&apos;s <code className="rounded bg-muted px-1">.claude</code>, replacing
        files of the same name and keeping the rest.
      </p>
      {error && <p className="text-xs text-destructive">{errorMessage(error)}</p>}
      {data &&
        (data.repos.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
            {projectId ? 'No repos in this project yet.' : 'No repos on the board yet.'}
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {data.repos.map((r) => (
              <RepoSkillsItem
                key={r.repoId}
                repo={r}
                total={data.files.length}
                showProject={!projectId}
                line={reviewSkillsInstall(shell, boardUrl, token, repoClaudeDir(r.repoPath))}
              />
            ))}
          </ul>
        ))}
    </section>
  )
}

function RepoSkillsItem({
  repo,
  total,
  showProject,
  line,
}: {
  repo: RepoSkillsRow
  total: number
  showProject: boolean
  line: string
}) {
  const [open, setOpen] = useState(false)
  const outdated = repo.status === 'outdated'
  const stale = repo.files.filter((f) => f.status !== 'current')
  return (
    <li className="space-y-1.5 px-3 py-2" aria-label={`${repo.repoName} in ${repo.projectName}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <p className="text-sm">
            <span className="font-medium">{repo.repoName}</span>
            {showProject && <span className="text-muted-foreground"> · {repo.projectName}</span>}
          </p>
          <p className="font-mono text-xs break-all text-muted-foreground">{repo.repoPath}</p>
        </div>
        <Badge variant={outdated ? 'destructive' : repo.status === 'current' ? 'secondary' : 'outline'}>
          {STATUS_LABEL[repo.status]}
        </Badge>
      </div>
      {repo.status === 'none' && (
        <p className="text-xs text-muted-foreground">
          Uses the <code className="rounded bg-muted px-1">~/.claude</code> install.
        </p>
      )}
      {outdated && (
        <>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="flex items-center gap-1 text-left text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className={`size-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
            {stale.length} of {total} files differ or are missing
          </button>
          {/* Rendered only when open: the page has one install line per shell until a repo's is asked for. */}
          {open && (
            <div className="space-y-2">
              <ul className="font-mono text-xs text-muted-foreground" aria-label="Files not up to date">
                {stale.map((f) => (
                  <li key={f.path} className="flex gap-2">
                    <span className="w-16 shrink-0">{f.status}</span>
                    <span className="min-w-0 break-all">.claude/{f.path}</span>
                  </li>
                ))}
              </ul>
              <CopyBlock text={line} />
            </div>
          )}
        </>
      )}
    </li>
  )
}
