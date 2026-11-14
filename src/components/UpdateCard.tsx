import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { X } from 'lucide-react'
import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toast } from 'sonner'

import { CrossBoardMark } from '#/components/CrossBoardMark'
import { useUpdates } from '#/components/Updates'
import { Button } from '#/components/ui/button'
import { errorMessage, get, type Me, post } from '#/lib/api'
import {
  artworkCandidates,
  recallUpdateMemory,
  rememberUpdateSeen,
  rememberUpdateSkipped,
  shouldShow,
  type UpdateMemory,
} from '#/lib/updateCard'
import type { UpdatesState } from '#/lib/updates'
import { useHydrated } from '#/lib/useHydrated'

/**
 * Whether the page is dark: the `dark` class src/lib/theme.ts puts on <html>, followed while it is open
 * (the theme can change under the card, and the artwork has a file per theme). Only ever read in the
 * browser: the server's snapshot is light.
 */
function subscribeToDark(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  const scheme = window.matchMedia('(prefers-color-scheme: dark)')
  scheme.addEventListener('change', onChange)
  return () => {
    observer.disconnect()
    scheme.removeEventListener('change', onChange)
  }
}

const darkNow = () => document.documentElement.classList.contains('dark')
const useDark = () => useSyncExternalStore(subscribeToDark, darkNow, () => false)

/**
 * The release announcement: what a newer version brings, over the board as the desktop app starts, once
 * per release this browser has not seen. It is deliberately not a modal — nothing is focused or trapped,
 * the page behind stays clickable and scrollable, Esc and Close dismiss it. Install is the Settings
 * button's own route; Skip is remembered here and can be undone in Settings, Updates.
 */
export function UpdateCard() {
  const hydrated = useHydrated()
  const qc = useQueryClient()
  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: () => get<Me>('/api/me'),
    staleTime: Infinity,
  })
  const { data: updates } = useUpdates()
  const router = useRouter()
  // Read after mount: this browser's memory is not in the server's HTML, and the render must agree with it.
  const [memory, setMemory] = useState<UpdateMemory | null>(null)
  // The release this page has dismissed: seen alone keeps the query data as it is, so the card needs its own.
  const [dismissed, setDismissed] = useState<string | null>(null)
  useEffect(() => setMemory(recallUpdateMemory()), [])
  // Settings' Undo clears this browser's memory under a mounted page. On the next move, read it again, so
  // the release is offered without a reload; anything else the memory says keeps what this page decided.
  useEffect(
    () =>
      router.subscribe('onResolved', () => {
        const next = recallUpdateMemory()
        if (next.seenVersion !== null || next.skippedVersion !== null) return
        setMemory(next)
        setDismissed(null)
      }),
    [router],
  )

  const install = useMutation({
    mutationFn: () => post<UpdatesState>('/api/updates/install'),
    onSuccess: (state) => qc.setQueryData(['updates'], state),
    onError: (err) => toast.error(errorMessage(err)),
  })

  const shownVersion = updates?.mode === 'desktop' ? (updates.newest?.version ?? null) : null
  const show =
    hydrated &&
    me !== undefined &&
    !me.agent &&
    memory !== null &&
    shouldShow(updates, memory) &&
    dismissed !== shownVersion

  // Seen as it is shown (not skipped): a reload, or the app started again, does not announce it twice.
  useEffect(() => {
    if (show && shownVersion) rememberUpdateSeen(shownVersion)
  }, [show, shownVersion])

  if (!show || updates?.mode !== 'desktop' || !updates.newest) return null
  const { version, notes, notesMarkdown } = updates.newest
  return (
    <UpdateCardPanel
      version={version}
      notes={notes}
      notesMarkdown={notesMarkdown}
      onClose={() => setDismissed(version)}
      onSkip={() => {
        rememberUpdateSkipped(version)
        setDismissed(version)
      }}
      onInstall={() => {
        // The card goes at once: the download is the app's, and Settings follows it as before.
        setDismissed(version)
        install.mutate()
      }}
    />
  )
}

/** The card itself: artwork, the release's notes, and what can be done about it. */
function UpdateCardPanel({
  version,
  notes,
  notesMarkdown,
  onClose,
  onSkip,
  onInstall,
}: {
  version: string
  notes: string
  notesMarkdown: string
  onClose: () => void
  onSkip: () => void
  onInstall: () => void
}) {
  const titleId = useId()
  const dark = useDark()
  const [broken, setBroken] = useState<string[]>([])
  const artwork = artworkCandidates(version, dark).find((file) => !broken.includes(file))

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    // The overlay is transparent to the pointer: the page behind keeps its clicks and its scroll.
    <div className="pointer-events-none fixed inset-0 z-50 flex items-start justify-center px-4 pt-16 pb-4">
      <div
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        data-testid="update-card"
        className="pointer-events-auto flex max-h-[calc(100dvh-5rem)] w-full max-w-lg flex-col overflow-hidden rounded-xl border bg-background text-foreground shadow-xl"
      >
        <div className="relative aspect-video w-full shrink-0 overflow-hidden bg-muted">
          {artwork ? (
            <img
              data-testid="update-card-art"
              src={artwork}
              alt=""
              className="h-full w-full bg-muted object-cover"
              onError={() => setBroken((files) => (files.includes(artwork) ? files : [...files, artwork]))}
            />
          ) : (
            <div
              data-testid="update-card-art-placeholder"
              className="flex h-full w-full flex-col items-center justify-center gap-1 bg-linear-to-br from-muted to-accent text-center"
            >
              <CrossBoardMark className="size-9 text-muted-foreground" />
              <p className="text-sm font-medium">CrossBoard {version}</p>
              <p className="text-xs text-muted-foreground">Release artwork</p>
            </div>
          )}
        </div>
        <div className="flex items-start justify-between gap-3 px-4 pt-3">
          <h2 id={titleId} className="text-base leading-snug font-semibold">
            CrossBoard {version} is available
          </h2>
          <Button size="icon-sm" variant="ghost" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        </div>
        {/* The notes are the one part that scrolls: the card itself fits the viewport. */}
        <div data-testid="update-card-notes" className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
          {notesMarkdown ? (
            <div className="prose prose-sm dark:prose-invert max-w-none break-words">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ node: _n, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
                }}
              >
                {notesMarkdown}
              </ReactMarkdown>
            </div>
          ) : notes ? (
            <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{notes}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3">
          <Button size="sm" variant="outline" onClick={onSkip}>
            Skip this version
          </Button>
          <Button size="sm" onClick={onInstall}>
            Install now
          </Button>
        </div>
      </div>
    </div>
  )
}
