import { useQuery } from '@tanstack/react-query'
import { Fragment, useState } from 'react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '#/components/ui/dialog'
import { errorMessage, get } from '#/lib/api'
import type { DiffLine } from '#/lib/diff'
import { cn } from '#/lib/utils'
import type { SkillFileDiff } from '#/server/agents'

const TONE: Record<DiffLine['kind'], string> = {
  add: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  del: 'bg-destructive/10 text-destructive dark:bg-destructive/20',
  context: '',
}
const SIGN: Record<DiffLine['kind'], string> = { add: '+', del: '-', context: ' ' }

/**
 * One review skills file as installed against the copy the board serves, as `git diff` shows it: what
 * the install line would change in it. Read from disk each time it opens (`opened` counts the openings);
 * `file` null keeps it closed. `repoId` is the repo whose `.claude` holds the copy, none for `~/.claude`.
 */
export function SkillFileDiffDialog({
  file,
  repoId,
  opened,
  onClose,
}: {
  file: string | null
  repoId?: number
  opened: number
  onClose: () => void
}) {
  // Keeps showing the last file while the dialog animates closed.
  const [last, setLast] = useState(file)
  if (file !== null && file !== last) setLast(file)
  const shown = file ?? last
  const query = new URLSearchParams({ path: shown ?? '', ...(repoId ? { repoId: String(repoId) } : {}) })
  const { data, error } = useQuery({
    queryKey: ['review-skills-diff', repoId ?? 'global', shown, opened],
    queryFn: () => get<SkillFileDiff>(`/api/agent-setup/review-skills/diff?${query}`),
    enabled: file !== null,
    staleTime: 0,
    gcTime: 0,
  })
  return (
    <Dialog open={file !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="pr-6 font-mono leading-snug break-all">.claude/{shown}</DialogTitle>
          <DialogDescription className="text-xs">
            What the install line would change: lines marked - are in the installed copy and go, lines marked
            + come from the copy the board serves. Line endings aside.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-destructive">{errorMessage(error)}</p>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <DiffView diff={data} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function DiffView({ diff }: { diff: SkillFileDiff }) {
  if (diff.unreadable !== null)
    return (
      <p className="text-sm">
        The installed copy can&apos;t be read as text ({diff.unreadable}):{' '}
        <code className="rounded bg-muted px-1 text-xs break-all">{diff.installed}</code>
      </p>
    )
  if (!diff.hunks.length)
    return (
      <p className="text-sm text-muted-foreground">
        No changes: the installed copy is up to date with the board&apos;s.
      </p>
    )
  return (
    // Long lines scroll sideways in here, never the page.
    <div
      role="region"
      aria-label="Changes"
      tabIndex={0}
      className="min-w-0 overflow-x-auto rounded-md border font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <div className="w-max min-w-full py-1">
        {diff.header.map((h) => (
          <div key={h} data-line="header" className="px-2 font-medium whitespace-pre text-muted-foreground">
            {h}
          </div>
        ))}
        {diff.hunks.map((hunk) => (
          <Fragment key={hunk.header}>
            <div data-line="hunk" className="mt-1 bg-muted px-2 whitespace-pre text-muted-foreground">
              {hunk.header}
            </div>
            {hunk.lines.map((l, i) => (
              <Fragment key={i}>
                <div data-line={l.kind} className={cn('flex whitespace-pre', TONE[l.kind])}>
                  <span className="w-9 shrink-0 pr-1 text-right opacity-60 select-none">{l.oldNo}</span>
                  <span className="w-9 shrink-0 pr-1 text-right opacity-60 select-none">{l.newNo}</span>
                  <span className="w-4 shrink-0 text-center">{SIGN[l.kind]}</span>
                  <span className="pr-2">{l.text}</span>
                </div>
                {l.noNewline && (
                  <div data-line="note" className="pl-22 whitespace-pre text-muted-foreground">
                    \ No newline at end of file
                  </div>
                )}
              </Fragment>
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  )
}
