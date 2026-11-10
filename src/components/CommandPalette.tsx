'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { Compass, CornerDownLeft, LayoutGrid, Loader2, Search, Settings2, X, Zap } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { copyText } from '#/components/AgentPicker'
import { NewTicket } from '#/components/NewTicket'
import { Button } from '#/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Tip } from '#/components/ui/tooltip'
import { type Me, errorMessage, get, post, type Project, type RunOutcome, type TicketRow } from '#/lib/api'
import {
  type PaletteGroup,
  type PaletteItem,
  type PaletteKind,
  groupItems,
  rankItems,
} from '#/lib/commandPalette'
import { useProjects } from '#/lib/project'
import { stageBadge, stageOf } from '#/lib/stages'
import { keepSearchRows, ticketsQuery } from '#/lib/tickets'
import { cn } from '#/lib/utils'

/** Where a remembered palette pick is kept, and how many are kept. */
const RECENTS_KEY = 'command-palette.recents'
const RECENTS_MAX = 6

/** An item as the palette holds it: what it is, and how to run it. */
type Entry = PaletteItem & { run: () => void }

/** A group as drawn: the kinds of a search, plus the Recent one an empty box shows. */
type Group = { kind: PaletteKind | 'recent'; label: string; items: Entry[] }

const KIND_ICON: Record<PaletteKind, typeof Compass> = {
  ticket: Compass,
  page: LayoutGrid,
  setting: Settings2,
  action: Zap,
}

const PROJECT_PATHS = {
  overview: '/projects/$id',
  board: '/projects/$id/features',
  roadmap: '/projects/$id/roadmap',
  prs: '/projects/$id/prs',
  reviews: '/projects/$id/reviews',
  previews: '/projects/$id/previews',
  gallery: '/projects/$id/gallery',
  team: '/projects/$id/agents',
  daily: '/projects/$id/daily',
  cleanup: '/projects/$id/cleanup',
  repositories: '/projects/$id/repositories',
  instructions: '/projects/$id/settings',
} as const

type ProjectPath = (typeof PROJECT_PATHS)[keyof typeof PROJECT_PATHS]

const PROJECT_PAGES: {
  key: string
  to: ProjectPath
  title: string
  subtitle?: string
  keywords?: string[]
}[] = [
  {
    key: 'overview',
    to: PROJECT_PATHS.overview,
    title: 'Overview',
    subtitle: "The project's summary",
    keywords: ['home', 'project', 'summary', 'needs you'],
  },
  {
    key: 'board',
    to: PROJECT_PATHS.board,
    title: 'Board',
    subtitle: 'Ongoing features',
    keywords: ['tickets', 'features', 'kanban', 'stages', 'in progress'],
  },
  {
    key: 'roadmap',
    to: PROJECT_PATHS.roadmap,
    title: 'Roadmap',
    subtitle: 'The work timeline',
    keywords: ['timeline', 'work', 'schedule'],
  },
  {
    key: 'prs',
    to: PROJECT_PATHS.prs,
    title: 'PR queue',
    subtitle: 'Pull requests to review and waiting on others',
    keywords: ['prs', 'pull requests', 'reviews', 'merge'],
  },
  {
    key: 'reviews',
    to: PROJECT_PATHS.reviews,
    title: 'Reviews',
    subtitle: 'Review results, in the PR queue',
    keywords: ['verdict', 'findings', 'review results', 'prs'],
  },
  {
    key: 'previews',
    to: PROJECT_PATHS.previews,
    title: 'Previews',
    subtitle: 'The previews the board runs',
    keywords: ['runs', 'servers', 'ports'],
  },
  {
    key: 'gallery',
    to: PROJECT_PATHS.gallery,
    title: 'Gallery',
    subtitle: 'Files and screenshots',
    keywords: ['files', 'images', 'uploads'],
  },
  {
    key: 'team',
    to: PROJECT_PATHS.team,
    title: 'Team',
    subtitle: 'The agents the project works with',
    keywords: ['agents', 'personas', 'reservations'],
  },
  {
    key: 'daily',
    to: PROJECT_PATHS.daily,
    title: 'Daily',
    subtitle: "The project's day",
    keywords: ['activity', 'today', 'report'],
  },
  {
    key: 'cleanup',
    to: PROJECT_PATHS.cleanup,
    title: 'Cleanup',
    subtitle: 'Branches and worktrees left behind',
    keywords: ['branches', 'worktrees', 'delete', 'leftovers'],
  },
  {
    key: 'repositories',
    to: PROJECT_PATHS.repositories,
    title: 'Repositories',
    subtitle: 'Checkouts this project reads',
    keywords: ['repos', 'git', 'checkouts'],
  },
  {
    key: 'instructions',
    to: PROJECT_PATHS.instructions,
    title: 'Instructions',
    subtitle: 'Settings: what every agent reads',
    keywords: ['settings', 'project settings', 'rules', 'layout', 'phases', 'stages', 'runs'],
  },
]

const GLOBAL_PAGES: {
  key: string
  to: '/' | '/daily' | '/agents' | '/settings'
  title: string
  subtitle: string
  keywords?: string[]
}[] = [
  {
    key: 'home',
    to: '/',
    title: 'Home',
    subtitle: 'Every project at a glance',
    keywords: ['projects', 'summary', 'board'],
  },
  {
    key: 'daily-global',
    to: '/daily',
    title: 'Daily',
    subtitle: 'What every project did',
    keywords: ['activity', 'reports', 'today'],
  },
  {
    key: 'connect',
    to: '/agents',
    title: 'Connect',
    subtitle: 'Connect an agent and install the skill',
    keywords: ['agents', 'mcp', 'tokens', 'setup', 'install'],
  },
  {
    key: 'settings-global',
    to: '/settings',
    title: 'Settings',
    subtitle: 'Board-wide preferences',
    keywords: ['preferences', 'theme', 'previews', 'devices'],
  },
]

type Section = {
  key: string
  title: string
  subtitle?: string
  keywords?: string[]
  hash: string
  /** Only the human sees it: an agent's pages leave it out too. */
  humanOnly?: boolean
  /** The page draws it only while sign-in is on (a board with sign-in off has no passkeys). */
  signInOnly?: boolean
}

const BOARD_SETTINGS: Section[] = [
  {
    key: 'theme',
    title: 'Theme',
    subtitle: 'System, light or dark',
    keywords: ['appearance', 'colour', 'color', 'dark', 'light', 'system'],
    hash: 'theme',
  },
  {
    key: 'default-agent',
    title: 'Default agent CLI',
    subtitle: 'The CLI Connect opens on',
    keywords: ['agent', 'claude', 'codex', 'opencode', 'connect'],
    hash: 'default-agent',
  },
  {
    key: 'previews-limit',
    title: 'Previews limit',
    subtitle: 'How many previews run at once',
    keywords: ['previews', 'runs', 'limit', 'ports'],
    hash: 'previews',
  },
  {
    key: 'updates',
    title: 'Updates',
    subtitle: "The board app's updates",
    keywords: ['version', 'release', 'upgrade'],
    hash: 'updates',
    humanOnly: true,
  },
  {
    key: 'agent-roles',
    title: 'Agent roles',
    subtitle: 'Worker or orchestrator',
    keywords: ['agents', 'tokens', 'orchestrator', 'worker', 'permissions'],
    hash: 'agent-roles',
    humanOnly: true,
  },
  {
    key: 'tailnet',
    title: 'Tailnet entrance',
    subtitle: 'Reach the board from another device',
    keywords: ['tailscale', 'network', 'remote', 'public'],
    hash: 'tailnet',
    humanOnly: true,
  },
  {
    key: 'devices',
    title: 'Devices and passkeys',
    subtitle: 'The devices that sign in',
    keywords: ['passkeys', 'sessions', 'sign in', 'security'],
    hash: 'devices',
    humanOnly: true,
    signInOnly: true,
  },
]

const PROJECT_SETTINGS: Section[] = [
  {
    key: 'instructions',
    title: 'Project instructions',
    subtitle: 'What every agent reads',
    keywords: ['rules', 'agents', 'prompt'],
    hash: 'instructions',
  },
  {
    key: 'instructions-history',
    title: 'Instructions history',
    subtitle: 'Every change to the instructions',
    keywords: ['versions', 'history', 'changes'],
    hash: 'instructions-history',
  },
  {
    key: 'default-phases',
    title: 'Default phases',
    subtitle: 'The tasks every new ticket starts with',
    keywords: ['tasks', 'phases', 'new ticket'],
    hash: 'default-phases',
  },
  {
    key: 'tag-suggestions',
    title: 'Tag suggestions',
    subtitle: 'The tags offered on tickets',
    keywords: ['tags', 'labels'],
    hash: 'tag-suggestions',
  },
  {
    key: 'stalled-tickets',
    title: 'Stalled tickets',
    subtitle: 'When a ticket reads as stalled',
    keywords: ['stall', 'minutes', 'idle'],
    hash: 'stalled-tickets',
  },
  {
    key: 'stages',
    title: 'Stages',
    subtitle: 'The board columns and what they mean',
    keywords: ['columns', 'workflow', 'status', 'work stage'],
    hash: 'stages',
  },
  {
    key: 'runs',
    title: 'Runs',
    subtitle: 'Previews and jobs the board runs',
    keywords: ['previews', 'jobs', 'commands', 'build'],
    hash: 'runs',
  },
  {
    key: 'layout',
    title: 'Layout',
    subtitle: 'The pages, cards and ticket sections',
    keywords: ['arrange', 'menu', 'sidebar'],
    hash: 'layout',
  },
]

const CONNECT_SECTIONS: Section[] = [
  {
    key: 'agent-tokens',
    title: 'Agent tokens',
    subtitle: 'The tokens agents sign in with',
    keywords: ['tokens', 'agents', 'keys', 'revoke', 'roles'],
    hash: 'agent-tokens',
    humanOnly: true,
  },
  {
    key: 'skills',
    title: 'Review skills',
    subtitle: 'Install the review skills (Claude Code)',
    keywords: ['skills', 'review', 'install'],
    hash: 'review-skills',
  },
]

/** The project and ticket the URL is on, for the pages and actions the palette offers there. */
function where(pathname: string) {
  const project = /^\/projects\/(\d+)(?:\/(.*))?$/.exec(pathname)
  const ticket = project ? /^features\/(\d+)/.exec(project[2] ?? '') : null
  return {
    projectId: project ? Number(project[1]) : null,
    ticketId: ticket ? Number(ticket[1]) : null,
  }
}

/**
 * The board's command palette: Ctrl+F (⌘F on macOS) from any page, or the search button in the top
 * bar on a phone, opens one box over tickets, pages, settings and actions. Arrows move, Enter runs,
 * Escape closes and hands the focus back where it was. An empty box remembers what was picked last.
 */
export function CommandPalette() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { projectId, ticketId } = where(pathname)
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [active, setActive] = useState(0)
  const [recentKeys, setRecentKeys] = useState<string[]>([])
  const [newTicketOpen, setNewTicketOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const openRef = useRef(false)
  const restoreFocus = useRef<HTMLElement | null>(null)
  openRef.current = open

  // The project's stages and layout, for the ticket badges and the pages it has.
  const projectQuery = useQuery({
    queryKey: ['project', String(projectId)],
    queryFn: () => get<Project>(`/api/projects/${projectId}`),
    enabled: projectId !== null,
  })
  const project = projectQuery.data
  const stages = project?.stages ?? []
  const { data: projects } = useProjects()
  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: () => get<Me>('/api/me'),
    staleTime: Infinity,
  })

  // Every ticket, for the recents an empty box shows; the search itself uses the existing ticket search.
  const allTickets = useQuery({
    ...ticketsQuery(projectId ?? 0, 'root'),
    enabled: open && projectId !== null,
  })
  // `#12` searches the board for 12 (the server finds a ticket by its number); the rest of a query
  // such as `#12 deploy` is kept for the ranking, which then needs the title to match it too.
  const number = /^#?(\d+)(?:\s+(.+))?$/.exec(debounced)
  const ticketSearch = number ? number[1]! : debounced
  const found = useQuery({
    ...ticketsQuery(projectId ?? 0, 'root', ticketSearch),
    enabled: open && projectId !== null && ticketSearch !== '',
    placeholderData: keepSearchRows(projectId ?? 0, 'root'),
  })
  const ticketItems = (found.data ?? []).map((t) => ticketEntry(t, projectId!, stages, navigate))
  const allTicketItems = (allTickets.data ?? []).map((t) => ticketEntry(t, projectId!, stages, navigate))

  const startStop = useMutation({
    mutationFn: (what: 'start' | 'stop') =>
      post<{ results: RunOutcome[] }>(`/api/tickets/${ticketId}/runs/${what}`),
    onSuccess: ({ results }, what) => {
      const refused = results.filter((r) => !r.ok)
      if (refused.length)
        toast.warning(
          `${refused.length} not ${what === 'start' ? 'started' : 'stopped'}: ${refused
            .map((r) => `${r.name} (${r.reason})`)
            .join('; ')}`,
        )
      else if (what === 'stop' && !results.length) toast.info('Nothing was running')
      qc.invalidateQueries({ queryKey: ['ticket-runs'] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  const openPalette = useCallback(() => {
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setQuery('')
    setDebounced('')
    setActive(0)
    setOpen(true)
  }, [])

  const close = useCallback(() => {
    setOpen(false)
    // Base UI's dialog hands the focus back too; this makes sure it happens once the popup is gone.
    const back = restoreFocus.current
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        // An action that opened another dialog (New ticket) keeps the focus itself.
        if (back?.isConnected && !document.querySelector('[data-slot="dialog-content"][data-open]'))
          back.focus()
      }),
    )
  }, [])

  // Esc closes; the dialog's own close is the same path.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  // Ctrl+F and ⌘F open it from anywhere and keep the browser's find-in-page closed.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== 'f' ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey ||
        event.repeat
      )
        return
      event.preventDefault()
      event.stopPropagation()
      if (openRef.current) {
        input.current?.focus()
        input.current?.select()
      } else openPalette()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [openPalette])

  // The search waits a beat: typing a title does not send a request per key.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 180)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    setActive(0)
  }, [query])

  // Recents are this browser's, read after mount so the served page and the first client render agree.
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]')
      if (Array.isArray(saved))
        setRecentKeys(saved.filter((k): k is string => typeof k === 'string').slice(0, RECENTS_MAX))
    } catch {}
  }, [])

  const rememberKey = (key: string) => {
    const next = [key, ...recentKeys.filter((k) => k !== key)].slice(0, RECENTS_MAX)
    setRecentKeys(next)
    try {
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
    } catch {}
  }

  const select = (entry: Entry) => {
    rememberKey(entry.key)
    setOpen(false)
    // Let the palette go and the focus settle before an action opens another dialog.
    window.setTimeout(() => entry.run(), 0)
  }

  // The pages, settings and actions of where the box was opened.
  const staticItems: Entry[] = []
  if (projectId !== null) {
    for (const page of PROJECT_PAGES) {
      staticItems.push({
        key: `page:${projectId}:${page.key}`,
        kind: 'page',
        title: page.title,
        subtitle: page.subtitle,
        keywords: page.keywords,
        run: () => navigate({ to: page.to, params: { id: String(projectId) } }),
      })
    }
    for (const section of PROJECT_SETTINGS) {
      staticItems.push({
        key: `setting:${projectId}:${section.key}`,
        kind: 'setting',
        title: section.title,
        subtitle: section.subtitle,
        keywords: section.keywords,
        run: () =>
          navigate({
            to: '/projects/$id/settings',
            params: { id: String(projectId) },
            hash: section.hash,
          }),
      })
    }
    staticItems.push({
      key: `action:new-ticket:${projectId}`,
      kind: 'action',
      title: 'New ticket',
      subtitle: `Create a ticket in ${project?.name ?? 'this project'}`,
      keywords: ['create', 'add', 'ticket', 'lane', 'new'],
      run: () => setNewTicketOpen(true),
    })
    if (ticketId !== null) {
      staticItems.push(
        {
          key: `action:copy-ticket-link:${projectId}:${ticketId}`,
          kind: 'action',
          title: 'Copy ticket link',
          subtitle: 'Put this ticket’s address on the clipboard',
          keywords: ['url', 'share', 'clipboard'],
          run: () => {
            void copyText(
              `${window.location.origin}/projects/${projectId}/features/${ticketId}`,
              'Ticket link copied',
            )
          },
        },
        {
          key: `action:start-preview:${projectId}:${ticketId}`,
          kind: 'action',
          title: 'Start preview',
          subtitle: "Start the ticket's previews and jobs",
          keywords: ['run', 'preview', 'start', 'server'],
          run: () => startStop.mutate('start'),
        },
        {
          key: `action:stop-preview:${projectId}:${ticketId}`,
          kind: 'action',
          title: 'Stop preview',
          subtitle: "Stop the ticket's previews and jobs",
          keywords: ['run', 'preview', 'stop', 'server'],
          run: () => startStop.mutate('stop'),
        },
      )
    }
  }
  for (const page of GLOBAL_PAGES) {
    staticItems.push({
      key: `page:global:${page.key}`,
      kind: 'page',
      title: page.title,
      subtitle: page.subtitle,
      keywords: page.keywords,
      run: () => navigate({ to: page.to }),
    })
  }
  for (const section of BOARD_SETTINGS) {
    if (section.humanOnly && me?.agent) continue
    // The section is only on the page while sign-in is on; until that is known, leave it out.
    if (section.signInOnly && me?.authOff !== false) continue
    staticItems.push({
      key: `setting:global:${section.key}`,
      kind: 'setting',
      title: section.title,
      subtitle: section.subtitle,
      keywords: section.keywords,
      run: () => navigate({ to: '/settings', hash: section.hash }),
    })
  }
  for (const section of CONNECT_SECTIONS) {
    if (section.humanOnly && me?.agent) continue
    staticItems.push({
      key: `setting:global:connect-${section.key}`,
      kind: 'setting',
      title: section.title,
      subtitle: section.subtitle,
      keywords: section.keywords,
      run: () => navigate({ to: '/agents', hash: section.hash }),
    })
  }
  for (const p of projects ?? []) {
    staticItems.push({
      key: `action:switch-project:${p.id}`,
      kind: 'action',
      title: `Switch to ${p.name}`,
      subtitle: p.id === projectId ? 'Current project' : 'Open its Overview',
      keywords: ['project', 'switch', 'open', p.name],
      run: () => navigate({ to: '/projects/$id', params: { id: String(p.id) } }),
    })
  }

  const q = query.trim()
  const searching = q !== '' && (q !== debounced || found.isFetching)
  let groups: Group[]
  if (q === '') {
    const byKey = new Map([...staticItems, ...allTicketItems].map((item) => [item.key, item]))
    const recent = recentKeys.map((key) => byKey.get(key)).filter((item): item is Entry => item !== undefined)
    groups = recent.length
      ? [{ kind: 'recent', label: 'Recent', items: recent }]
      : groupItems(staticItems).map(asGroup)
  } else {
    groups = groupItems(rankItems([...ticketItems, ...staticItems], q)).map(asGroup)
  }
  const flat = groups.flatMap((group) => group.items)

  useEffect(() => {
    setActive((at) => (flat.length === 0 ? 0 : Math.min(at, flat.length - 1)))
  }, [flat.length])

  useEffect(() => {
    if (!open || !flat.length) return
    document.getElementById(`command-palette-option-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, open, flat.length])

  const move = (by: number) => {
    if (!flat.length) return
    setActive((at) => (at + by + flat.length) % flat.length)
  }

  return (
    <>
      <Tip content="Search the board (Ctrl+F)">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Search the board"
          onClick={() => (open ? input.current?.focus() : openPalette())}
        >
          <Search />
        </Button>
      </Tip>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next) setOpen(true)
          else close()
        }}
      >
        <DialogContent
          showCloseButton={false}
          initialFocus={input}
          className="top-[10vh] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
        >
          <DialogTitle className="sr-only">Search the board</DialogTitle>
          <DialogDescription className="sr-only">
            Search tickets, pages, settings and actions. Use the up and down keys to move, Enter to run one,
            and Escape to close.
          </DialogDescription>
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <Input
              ref={input}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  move(1)
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  move(-1)
                } else if (e.key === 'Enter') {
                  const entry = flat[active]
                  if (entry) {
                    e.preventDefault()
                    select(entry)
                  }
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  close()
                }
              }}
              role="combobox"
              aria-label="Search the board"
              aria-controls="command-palette-list"
              aria-expanded={open}
              aria-autocomplete="list"
              aria-activedescendant={flat.length ? `command-palette-option-${active}` : undefined}
              placeholder="Search tickets, pages, settings and actions…"
              className="h-11 rounded-none border-0 bg-transparent px-0 focus-visible:ring-0 dark:bg-transparent"
            />
            {searching && (
              <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close search"
              onClick={close}
              className="shrink-0"
            >
              <X />
            </Button>
          </div>
          <div
            id="command-palette-list"
            role="listbox"
            aria-label="Search results"
            className="max-h-[min(60vh,26rem)] overflow-x-hidden overflow-y-auto overscroll-contain p-1"
          >
            {flat.map((entry, index) => {
              const Icon = KIND_ICON[entry.kind]
              const group = groupOf(groups, entry)
              const newGroup = index === 0 || groupOf(groups, flat[index - 1]!) !== group
              return (
                <div key={entry.key}>
                  {newGroup && (
                    <div className="flex items-center gap-2 px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                      <span>{group.label}</span>
                      <span className="text-muted-foreground/70">{group.items.length}</span>
                    </div>
                  )}
                  <div
                    id={`command-palette-option-${index}`}
                    role="option"
                    aria-selected={index === active}
                    data-active={index === active || undefined}
                    className={cn(
                      'flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                      index === active ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/60',
                    )}
                    onMouseMove={() => {
                      if (index !== active) setActive(index)
                    }}
                    onClick={() => select(entry)}
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="truncate">
                        {entry.kind === 'ticket' && (
                          <span className="text-muted-foreground">#{entry.ticketId} </span>
                        )}
                        {entry.title}
                      </div>
                      {entry.subtitle && (
                        <div className="truncate text-xs text-muted-foreground">{entry.subtitle}</div>
                      )}
                    </div>
                    {entry.stage && (
                      <span
                        className={cn(
                          'shrink-0 rounded px-1.5 py-0.5 text-[11px] leading-none font-medium',
                          stageBadge(entry.stage),
                        )}
                      >
                        {entry.stage.name}
                      </span>
                    )}
                    {index === active && (
                      <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                  </div>
                </div>
              )
            })}
            {!flat.length && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground" role="status">
                {searching ? 'Searching…' : q ? `No matches for “${q}”.` : 'Type to search the board.'}
              </p>
            )}
          </div>
          <div className="flex items-center gap-4 border-t px-3 py-2 text-[11px] text-muted-foreground">
            <span>
              <kbd className="rounded border bg-muted px-1">↑</kbd>{' '}
              <kbd className="rounded border bg-muted px-1">↓</kbd> to move
            </span>
            <span>
              <kbd className="rounded border bg-muted px-1">↵</kbd> to open
            </span>
            <span>
              <kbd className="rounded border bg-muted px-1">esc</kbd> to close
            </span>
            <span className="ml-auto hidden sm:inline">
              <kbd className="rounded border bg-muted px-1">Ctrl</kbd>{' '}
              <kbd className="rounded border bg-muted px-1">F</kbd> anywhere
            </span>
          </div>
        </DialogContent>
      </Dialog>
      {projectId !== null && (
        <NewTicket
          projectId={String(projectId)}
          open={newTicketOpen}
          onOpenChange={setNewTicketOpen}
          trigger={false}
        />
      )}
    </>
  )
}

/** A ticket as the palette draws and runs it. */
function ticketEntry(
  ticket: TicketRow,
  projectId: number,
  stages: Project['stages'],
  navigate: ReturnType<typeof useNavigate>,
): Entry {
  const stage = stageOf(stages, ticket.status)
  return {
    key: `ticket:${projectId}:${ticket.id}`,
    kind: 'ticket',
    title: ticket.title,
    subtitle: [ticket.assignee, ...(ticket.tags ?? [])].filter(Boolean).join(' · ') || undefined,
    ticketId: ticket.id,
    keywords: [String(ticket.id), `#${ticket.id}`, ticket.assignee ?? '', ...(ticket.tags ?? [])],
    stage: { name: stage.name, color: stage.color, kind: stage.kind },
    run: () =>
      navigate({
        to: '/projects/$id/features/$ticketId',
        params: { id: String(projectId), ticketId: String(ticket.id) },
      }),
  }
}

const asGroup = (group: PaletteGroup<Entry>): Group => ({
  kind: group.kind,
  label: group.label,
  items: group.items,
})

/** The group an item is in (the one whose list holds it), for the header drawn above it. */
const groupOf = (groups: Group[], item: Entry) =>
  groups.find((group) => group.items.includes(item)) ?? groups[0]!
