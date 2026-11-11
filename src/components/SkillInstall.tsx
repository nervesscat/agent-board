import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Download, RefreshCw, TriangleAlert } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { ApiError, errorMessage, post } from '#/lib/api'
import { stamp } from '#/lib/format'
import type { AgentClient } from '#/lib/constants'
import type { InstallResult } from '#/server/agents'

/** The short-lived credential an install line carries, as the mint answers it. */
export interface SkillToken {
  token: string
  expiresAt: string
}

/**
 * The download credential the install lines carry: minted when the first one is copied, and reused by every
 * line and copy on the page until it expires or the page is left (a later copy mints a new one). Nothing is
 * made on load.
 */
export function useSkillToken() {
  const [made, setMade] = useState<SkillToken | null>(null)
  // The same, for a copy pressed before the page has re-rendered with the answer.
  const current = useRef<SkillToken | null>(null)
  const inFlight = useRef<Promise<SkillToken> | null>(null)
  const mint = useMutation({
    mutationFn: () => post<SkillToken>('/api/agent-setup/skill-token'),
    onSuccess: (token) => {
      current.current = token
      setMade(token)
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const { mutateAsync } = mint
  /**
   * The text of one install line to put on the clipboard, built with this page's credential, which the
   * first copy mints and a copy after it expired mints again: null when it could not be had, and nothing
   * is copied.
   */
  const copyLine = async (build: (token: string) => string): Promise<string | null> => {
    // An `expiresAt` at or before now is no credential to copy: the board refuses it, so a new one is made.
    if (current.current && Date.parse(current.current.expiresAt) > Date.now())
      return build(current.current.token)
    try {
      inFlight.current ??= mutateAsync().finally(() => {
        inFlight.current = null
      })
      return build((await inFlight.current).token)
    } catch {
      return null
    }
  }
  return { made, copyLine }
}

/**
 * Installs a skill on the board's machine, where the board runs: the board skill for `client` under the home
 * the board runs as, or the review bundle into CLAUDE_HOME. `installed` says whether a copy is there
 * already (the review skills' status), so the button reads Install skill or Update skill; a press of the
 * board skill's own flips it after the first success. Its card says where each file went, when, and what
 * changed, or why it could not and how to try again.
 */
export function SkillInstallButton({
  kind,
  client,
  installed = false,
}: {
  kind: 'skill' | 'review-skills'
  /** The CLI whose board skill is written: needed for `kind: 'skill'`. */
  client?: AgentClient
  /** Whether the copy is there already, as the page reads it: Update skill rather than Install skill. */
  installed?: boolean
}) {
  const qc = useQueryClient()
  const [result, setResult] = useState<InstallResult | null>(null)
  const [failure, setFailure] = useState<{ message: string; status: number } | null>(null)
  const [pressed, setPressed] = useState(false)
  const what = kind === 'skill' ? 'the board skill' : 'the review skills'
  const install = useMutation({
    mutationFn: () => post<InstallResult>('/api/agent-setup/skill/install', { client, kind }),
    onMutate: () => setFailure(null),
    onSuccess: (r) => {
      setResult(r)
      setPressed(true)
      // The review skills' status is what tells Install from Update: read it again.
      if (kind === 'review-skills') qc.invalidateQueries({ queryKey: ['review-skills-status'] })
    },
    onError: (err) => {
      setResult(null)
      setFailure({
        message: errorMessage(err),
        status: err instanceof ApiError ? err.status : 0,
      })
    },
  })
  return (
    <div className="space-y-2">
      <Button variant="outline" size="sm" disabled={install.isPending} onClick={() => install.mutate()}>
        <Download data-icon="inline-start" /> {installed || pressed ? 'Update skill' : 'Install skill'}
      </Button>
      {result && (
        <div
          role="status"
          aria-label={`Installed ${what}`}
          className="flex items-start gap-2 rounded-md border border-emerald-300/60 bg-emerald-50 p-3 text-emerald-950 dark:border-emerald-400/20 dark:bg-emerald-950/40 dark:text-emerald-100"
        >
          <CheckCircle2
            className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
            aria-hidden
          />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm font-medium">
              Installed {what} at <time dateTime={result.at}>{stamp(result.at)}</time>
            </p>
            <ul
              className="space-y-0.5 font-mono text-xs [overflow-wrap:anywhere]"
              aria-label="Installed files"
            >
              {result.files.map((f) => (
                <li key={f.path}>
                  {f.path} <span className="not-italic opacity-80">· {f.action}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {failure && (
        <div
          role="alert"
          aria-label={`Could not install ${what}`}
          className="flex items-start gap-2 rounded-md border border-rose-300/60 bg-rose-50 p-3 text-rose-950 dark:border-rose-400/20 dark:bg-rose-950/40 dark:text-rose-100"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-rose-600 dark:text-rose-400" aria-hidden />
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-sm font-medium">
              Could not install {what} (HTTP {failure.status})
            </p>
            <p className="text-xs [overflow-wrap:anywhere]">{failure.message}</p>
            <p className="text-xs">
              Check that the folder belongs to the user the board runs as, and that it can be written to.
            </p>
            <Button variant="outline" size="sm" disabled={install.isPending} onClick={() => install.mutate()}>
              <RefreshCw data-icon="inline-start" className={install.isPending ? 'animate-spin' : ''} /> Retry
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
