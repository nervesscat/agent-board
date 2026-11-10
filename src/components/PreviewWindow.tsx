import { useQuery } from '@tanstack/react-query'
import { Check, Copy, ExternalLink, Loader2, Maximize2, Minimize2, RotateCw, X } from 'lucide-react'
import { createElement, useEffect, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { Tip } from '#/components/ui/tooltip'
import { get, type WorkspacePreview } from '#/lib/api'
import { cn } from '#/lib/utils'
import {
  activeTab,
  closeTab,
  NO_PREVIEW_WINDOW,
  openTab,
  previewHealth,
  previewNotice,
  type PreviewTab,
  type PreviewWindowsState,
  reloadTabs,
  showTab,
  toggleMaximized,
} from '#/lib/previewWindow'

/**
 * The embedded preview window (src/lib/previewWindow.ts holds its state and link rules): one window
 * over the board's pages, with a tab per preview opened, its title and links in a toolbar, and the
 * preview itself under it — an iframe of its path on the board's own origin in a browser, a real
 * embedded browser view (`<webview>`) in the desktop app. It stays while the human navigates the board,
 * and it never starts or stops the run: the board's answer for the workspace says whether it still runs.
 *
 * It opens from a preview's Open (PreviewActions, a ticket's Runs card, the Previews page); the same
 * preview opened again switches to its tab, another adds one.
 */

let state: PreviewWindowsState = NO_PREVIEW_WINDOW
const listeners = new Set<() => void>()

function set(next: PreviewWindowsState) {
  state = next
  for (const l of listeners) l()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The window's state; it renders nothing until a preview is opened. */
export function usePreviewWindows(): PreviewWindowsState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => NO_PREVIEW_WINDOW,
  )
}

/** Opens a preview in the window, or switches to it when it is already open. */
export function openPreview(tab: PreviewTab) {
  set(openTab(state, tab))
}

/** Whether the page runs inside the desktop app, whose build can embed a real browser view. */
function inDesktop() {
  return typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent)
}

/** The window, over the board's pages; nothing until a preview is opened. */
export function PreviewWindows() {
  const windows = usePreviewWindows()
  const tab = activeTab(windows)
  // The desktop app's embedded browser view is made after mount, so the server's page (an iframe) and
  // the first client render agree.
  const [desktop, setDesktop] = useState(false)
  useEffect(() => setDesktop(inDesktop()), [])
  // Whether the preview still runs: asked while the window shows it, never to change it.
  const preview = useQuery({
    queryKey: ['preview-window', tab?.workspaceId],
    queryFn: () => get<WorkspacePreview>(`/api/workspaces/${tab!.workspaceId}/preview`),
    enabled: !!tab,
    refetchInterval: 5_000,
    retry: false,
  })
  const [copied, setCopied] = useState(false)
  useEffect(() => setCopied(false), [tab?.key])

  if (!tab) return null
  const health = previewHealth(tab, preview.data)
  const notice = previewNotice(health, tab, preview.data?.managed?.reason)
  const link =
    tab.browser ?? (typeof window === 'undefined' ? tab.src : `${window.location.origin}${tab.src}`)
  const loads = windows.loads[tab.key] ?? 0
  const frameKey = `${tab.key}:${loads}`
  const frameTitle = `Preview of ${tab.title}`

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      toast.success('Link copied')
    } catch {
      toast.error('The link could not be copied')
    }
  }

  return (
    <section
      aria-label="Preview window"
      data-testid="preview-window"
      className={cn(
        'fixed z-30 flex flex-col overflow-hidden border bg-background shadow-2xl',
        // A phone: the whole screen, its own close button in the toolbar.
        'inset-0 pb-[env(safe-area-inset-bottom)]',
        windows.maximized
          ? 'sm:inset-2 sm:rounded-lg'
          : 'sm:inset-auto sm:right-4 sm:bottom-4 sm:h-[70vh] sm:w-[min(56rem,calc(100vw-2rem))] sm:rounded-xl',
      )}
    >
      {windows.tabs.length > 1 && (
        <div
          role="tablist"
          aria-label="Open previews"
          className="flex shrink-0 gap-1 overflow-x-auto border-b px-1.5 pt-1.5"
        >
          {windows.tabs.map((t) => (
            <Tip key={t.key} content={`${t.title} · ${t.subtitle}`}>
              <button
                type="button"
                role="tab"
                aria-selected={t.key === tab.key}
                data-testid="preview-tab"
                onClick={() => set(showTab(state, t.key))}
                onAuxClick={(e) => {
                  if (e.button === 1) set(closeTab(state, t.key))
                }}
                className={cn(
                  'flex max-w-[16rem] shrink-0 items-center gap-1 rounded-t-md px-2 py-1 text-xs whitespace-nowrap',
                  t.key === tab.key
                    ? 'bg-muted font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-muted/60',
                )}
              >
                <span className="truncate">{t.subtitle}</span>
              </button>
            </Tip>
          ))}
        </div>
      )}
      <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" data-testid="preview-title">
            {tab.title}
          </p>
          <p className="truncate text-[11px] text-muted-foreground">{tab.subtitle}</p>
        </div>
        {(health === 'building' || preview.isPending) && (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
        )}
        <Tip content="Load the preview again">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Reload preview"
            data-testid="preview-reload"
            onClick={() => set(reloadTabs(state, tab.key))}
          >
            <RotateCw />
          </Button>
        </Tip>
        <Tip content={windows.maximized ? 'Back to the floating window' : 'Use the whole screen'}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={windows.maximized ? 'Restore preview window' : 'Maximize preview window'}
            data-testid="preview-maximize"
            // A phone already shows it full screen.
            className="hidden sm:inline-flex"
            onClick={() => set(toggleMaximized(state))}
          >
            {windows.maximized ? <Minimize2 /> : <Maximize2 />}
          </Button>
        </Tip>
        <Tip content="Close the preview (the run keeps going)">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close preview window"
            data-testid="preview-close"
            onClick={() => set(closeTab(state, tab.key))}
          >
            <X />
          </Button>
        </Tip>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 px-2 py-1.5">
        <input
          readOnly
          aria-label="Preview URL"
          data-testid="preview-url"
          value={link}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded-md border bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground"
        />
        <Tip content="Copy the preview's link">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Copy preview link"
            data-testid="preview-copy"
            onClick={() => void copy()}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
        </Tip>
        {tab.browser && (
          <a
            href={tab.browser}
            target="_blank"
            rel="noreferrer"
            data-testid="preview-open-browser"
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border border-border px-2 text-xs font-medium whitespace-nowrap hover:bg-muted"
          >
            <span className="hidden sm:inline">Open in browser</span>
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
      <div className="relative min-h-0 flex-1 bg-muted">
        {notice && (
          <p
            role="status"
            data-testid="preview-notice"
            className="absolute inset-x-0 top-0 z-10 border-b bg-amber-500/15 px-3 py-1.5 text-xs text-amber-900 dark:text-amber-200"
          >
            {notice}
          </p>
        )}
        {desktop ? (
          // The desktop app's real browser view; PreviewWindows only asks for it once the page runs
          // inside the app (main.mjs turns the tag on for the board's own window).
          createElement('webview', {
            key: frameKey,
            src: tab.src,
            title: frameTitle,
            'data-testid': 'preview-frame',
            className: 'flex h-full w-full',
          })
        ) : (
          <iframe
            key={frameKey}
            src={tab.src}
            title={frameTitle}
            data-testid="preview-frame"
            // Same origin as the board (the proxy sets no X-Frame-Options) and its sign-in: the session
            // cookie is what the proxy checks. Sandboxed to what a preview needs, when its engine allows.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
            className="h-full w-full border-0 bg-white"
          />
        )}
      </div>
    </section>
  )
}
