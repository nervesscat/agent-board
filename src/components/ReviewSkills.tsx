import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { ChevronRight, RefreshCw } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import { toast } from 'sonner'

import { CopyBlock } from '#/components/AgentPicker'
import { SkillFileDiffDialog } from '#/components/SkillFileDiff'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '#/components/ui/tabs'
import {
  SHELLS,
  SHELL_KEY,
  type Shell,
  TOKEN_PLACEHOLDER,
  repoClaudeDir,
  reviewSkillsInstall,
} from '#/lib/agents'
import { errorMessage, get, patch } from '#/lib/api'
import type { SkillsTracking } from '#/lib/constants'
import { remember, useRestoreRemembered } from '#/lib/remembered'
import type {
  GlobalSkills as GlobalSkillsRow,
  RepoSkills as RepoSkillsRow,
  ReviewSkillsStatus,
  Settings,
} from '#/server/agents'

/**
 * The shell the install lines are for, on a page whose route takes `?shell=` (Connect an agent): the one in
 * the URL, else the one this browser remembers, else bash. Storage is read only after mount, so the
 * server's render and the browser's agree (as with the PR queue filter). Returns the shell and how to pick
 * another, which the URL and this browser keep.
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
 * default agents' cycle, for the page's shell (`useShell`). The line carries the page's short-lived download
 * credential (`useSkillToken`), which the first copy mints: until then, and in the text, it is
 * `TOKEN_PLACEHOLDER`. Below it, whether the copy the board tracks (a board-wide setting) is current: the
 * one in `~/.claude` on the board's machine, or each repo's own (every repo, or `projectId`'s).
 */
export function ReviewSkills({
  boardUrl,
  token = '',
  copyLine,
  shell,
  onShellChange,
  projectId,
}: {
  boardUrl: string
  token?: string
  /**
   * What one install line is copied as, minting the download credential when this page has none yet: the
   * text for the clipboard, or null when it could not be had.
   */
  copyLine?: (build: (token: string) => string) => Promise<string | null>
  shell: Shell
  onShellChange: (shell: Shell) => void
  projectId?: string
}) {
  const { data: paths = [] } = useQuery({
    queryKey: ['review-skills'],
    queryFn: () => get<string[]>('/api/agent-setup/review-skills?list'),
  })
  /** The copied text for a line built from the page's token: minted on the first copy. */
  const copy = (build: (token: string) => string) => async () =>
    copyLine ? copyLine(build) : build(token.trim())
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
              It carries <code className="rounded bg-muted px-1">{TOKEN_PLACEHOLDER}</code> until a line is
              copied: the board then mints a download token, good for about ten minutes, for every install
              line on this page.
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
      <CopyBlock
        text={reviewSkillsInstall(shell, boardUrl, token.trim())}
        onCopy={copy((t) => reviewSkillsInstall(shell, boardUrl, t))}
      />
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
      <InstalledSkills
        boardUrl={boardUrl}
        token={token.trim()}
        copy={copy}
        shell={shell}
        projectId={projectId}
      />
    </div>
  )
}

/**
 * Which copy the page tracks, a board-wide setting: the one in the settings cache (shared with the Settings
 * page), or the one being saved. Undefined until the settings load.
 */
function useSkillsTracking() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['settings'], queryFn: () => get<Settings>('/api/settings') })
  const save = useMutation({
    mutationFn: (skillsTracking: SkillsTracking) => patch<Settings>('/api/settings', { skillsTracking }),
    onSuccess: (s) => {
      qc.setQueryData(['settings'], s)
      qc.invalidateQueries({ queryKey: ['agent-setup'] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return [save.isPending ? save.variables : data?.skillsTracking, save.mutate] as const
}

/** The installed copies, as read when the page loads and on Check again: `~/.claude` and every repo's. */
export function useSkillsStatus(projectId?: string) {
  return useQuery({
    queryKey: ['review-skills-status', projectId ?? 'all'],
    queryFn: () =>
      get<ReviewSkillsStatus>(
        `/api/agent-setup/review-skills/status${projectId ? `?projectId=${projectId}` : ''}`,
      ),
  })
}

/** Where the skills are installed: the switch between the user-wide copy and the repos' own, and that view. */
function InstalledSkills({
  boardUrl,
  token,
  copy,
  shell,
  projectId,
}: {
  boardUrl: string
  token: string
  copy: (build: (token: string) => string) => () => Promise<string | null>
  shell: Shell
  projectId?: string
}) {
  const [tracking, track] = useSkillsTracking()
  const label = useId()
  if (!tracking) return null
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span id={label} className="text-xs font-medium">
          Track
        </span>
        <Tabs value={tracking} onValueChange={(v) => track(v as SkillsTracking)}>
          <TabsList aria-labelledby={label}>
            <TabsTrigger value="global">Global</TabsTrigger>
            <TabsTrigger value="repo">By repo</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {tracking === 'global' ? (
        <GlobalSkills boardUrl={boardUrl} token={token} copy={copy} shell={shell} projectId={projectId} />
      ) : (
        <RepoSkills boardUrl={boardUrl} token={token} copy={copy} shell={shell} projectId={projectId} />
      )}
    </>
  )
}

const STATUS_LABEL: Record<RepoSkillsRow['status'], string> = {
  current: 'Up to date',
  outdated: 'Outdated',
  none: 'Not installed in the repo',
  unreachable: "Can't read the checkout",
}

const GLOBAL_LABEL: Record<GlobalSkillsRow['status'], string> = {
  current: 'Up to date',
  outdated: 'Outdated',
  none: 'Not installed',
  unreachable: "Can't read the folder",
}

/** Reads the copies from disk again. */
function CheckAgain({ status }: { status: ReturnType<typeof useSkillsStatus> }) {
  return (
    <Button variant="outline" size="sm" onClick={() => status.refetch()} disabled={status.isFetching}>
      <RefreshCw data-icon="inline-start" className={status.isFetching ? 'animate-spin' : ''} /> Check again
    </Button>
  )
}

/**
 * The user-wide copy, in the `.claude` folder in the home of the machine the board runs on (or the one
 * CLAUDE_HOME names). An outdated copy opens to the files that are not current and the install line, the
 * one above unless the folder is not `~/.claude`: then its own, into that folder, also when none are there.
 */
function GlobalSkills({
  boardUrl,
  token,
  copy,
  shell,
  projectId,
}: {
  boardUrl: string
  token: string
  copy: (build: (token: string) => string) => () => Promise<string | null>
  shell: Shell
  projectId?: string
}) {
  const status = useSkillsStatus(projectId)
  const { data, error } = status
  const installTo = data?.global.installTo ?? null
  const build = (t: string) => reviewSkillsInstall(shell, boardUrl, t, installTo ?? undefined)
  return (
    <section className="space-y-2" aria-label="On this machine">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium">On this machine</h3>
        <CheckAgain status={status} />
      </div>
      {installTo === null ? (
        <p className="text-xs text-muted-foreground">
          The copy in <code className="rounded bg-muted px-1">~/.claude</code> on the machine the board runs
          on, which Claude Code uses in every repo without a copy of its own. The line above brings it up to
          date.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          The copy in the folder <code className="rounded bg-muted px-1">CLAUDE_HOME</code> names on the
          machine the board runs on, in place of <code className="rounded bg-muted px-1">~/.claude</code>. The
          line above installs into <code className="rounded bg-muted px-1">~/.claude</code>: this copy has a
          line of its own that installs the files into that folder.
        </p>
      )}
      {error && <p className="text-xs text-destructive">{errorMessage(error)}</p>}
      {data && (
        <ul className="divide-y rounded-md border">
          <SkillsItem
            label="~/.claude on this machine"
            name={<span className="font-medium">~/.claude</span>}
            path={data.global.path}
            status={data.global.status}
            statusLabel={GLOBAL_LABEL[data.global.status]}
            none={
              installTo === null
                ? 'None of these files are there yet: the line above installs them.'
                : 'None of these files are there yet: this line installs them.'
            }
            noneLine={installTo !== null}
            files={data.global.files}
            total={data.files.length}
            line={build(token)}
            copy={copy(build)}
          />
        </ul>
      )}
    </section>
  )
}

/**
 * The repos' own copies of the review skills, read from each checkout's `.claude`. An outdated copy
 * opens to the files that are not current and the line that brings it up to date.
 */
function RepoSkills({
  boardUrl,
  token,
  copy,
  shell,
  projectId,
}: {
  boardUrl: string
  token: string
  copy: (build: (token: string) => string) => () => Promise<string | null>
  shell: Shell
  projectId?: string
}) {
  const status = useSkillsStatus(projectId)
  const { data, error } = status
  return (
    <section className="space-y-2" aria-label="In your repos">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium">In your repos</h3>
        <CheckAgain status={status} />
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
              <SkillsItem
                key={r.repoId}
                repoId={r.repoId}
                label={`${r.repoName} in ${r.projectName}`}
                name={
                  <>
                    <span className="font-medium">{r.repoName}</span>
                    {!projectId && <span className="text-muted-foreground"> · {r.projectName}</span>}
                  </>
                }
                path={r.repoPath}
                status={r.status}
                statusLabel={STATUS_LABEL[r.status]}
                none={
                  <>
                    Uses the <code className="rounded bg-muted px-1">~/.claude</code> install.
                  </>
                }
                files={r.files}
                total={data.files.length}
                line={reviewSkillsInstall(shell, boardUrl, token, repoClaudeDir(r.repoPath))}
                copy={copy((t) => reviewSkillsInstall(shell, boardUrl, t, repoClaudeDir(r.repoPath)))}
              />
            ))}
          </ul>
        ))}
    </section>
  )
}

/**
 * One copy of the bundle: where it is, its status, and, when outdated, its stale files and line. Each
 * stale file opens to what the line would change in it.
 */
function SkillsItem({
  label,
  name,
  repoId,
  path,
  status,
  statusLabel,
  none,
  noneLine = false,
  files,
  total,
  line,
  copy,
}: {
  label: string
  name: ReactNode
  /** The repo whose `.claude` holds this copy; none for `~/.claude`. */
  repoId?: number
  path: string
  status: RepoSkillsRow['status']
  statusLabel: string
  /** What a copy with none of the files means. */
  none: ReactNode
  /** Whether a copy with none of the files shows the line too. */
  noneLine?: boolean
  files: RepoSkillsRow['files']
  total: number
  line: string
  /** The same line to copy, with this page's download token minted on the first copy. */
  copy: () => Promise<string | null>
}) {
  const [open, setOpen] = useState(false)
  // The stale file whose changes are shown, and how many times one was opened: each opening reads anew.
  const [diffOf, setDiffOf] = useState<string | null>(null)
  const [opened, setOpened] = useState(0)
  const outdated = status === 'outdated'
  const stale = files.filter((f) => f.status !== 'current')
  // A diff is open only while its file is listed: once the file or the whole copy is read as up to date
  // (a read on Check again, or when the page is shown again), it closes, and stays closed when the copy
  // is outdated again later, until a file is pressed.
  const listed = outdated && open && stale.some((f) => f.path === diffOf)
  if (diffOf !== null && !listed) setDiffOf(null)
  return (
    <li className="space-y-1.5 px-3 py-2" aria-label={label}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <p className="text-sm">{name}</p>
          <p className="font-mono text-xs break-all text-muted-foreground">{path}</p>
        </div>
        <Badge variant={outdated ? 'destructive' : status === 'current' ? 'secondary' : 'outline'}>
          {statusLabel}
        </Badge>
      </div>
      {status === 'none' && <p className="text-xs text-muted-foreground">{none}</p>}
      {status === 'none' && noneLine && <CopyBlock text={line} onCopy={copy} />}
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
          {/* Rendered only when open: the page has one install line per shell until a copy's is asked for. */}
          {open && (
            <div className="space-y-2">
              <ul className="font-mono text-xs text-muted-foreground" aria-label="Files not up to date">
                {stale.map((f) => (
                  <li key={f.path}>
                    {/* Opens what the line would change in this file. */}
                    <button
                      type="button"
                      aria-haspopup="dialog"
                      onClick={() => {
                        setOpened((n) => n + 1)
                        setDiffOf(f.path)
                      }}
                      className="flex w-full gap-2 rounded-sm text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      <span className="w-16 shrink-0">{f.status}</span>
                      <span className="min-w-0 break-all underline-offset-2 hover:underline">
                        .claude/{f.path}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <CopyBlock text={line} onCopy={copy} />
            </div>
          )}
        </>
      )}
      <SkillFileDiffDialog
        file={listed ? diffOf : null}
        repoId={repoId}
        opened={opened}
        onClose={() => setDiffOf(null)}
      />
    </li>
  )
}
