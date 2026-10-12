import { useQuery } from '@tanstack/react-query'
import { Link, useRouter } from '@tanstack/react-router'
import { AlarmClock, Bell, BellOff, TriangleAlert } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'

import { Button } from '#/components/ui/button'
import { get, type ReportDueList } from '#/lib/api'
import { cn } from '#/lib/utils'

/**
 * On every page: the projects whose report is due soon or missing, each linking to its Daily page,
 * and a browser notification once per project and period when its reminder starts. The board never
 * asks for notifications by itself: only the Notify me button does.
 */
export function ReportDueBanner() {
  const { data } = useQuery({
    queryKey: ['report-due'],
    queryFn: () => get<ReportDueList>('/api/report-due'),
    refetchInterval: 30_000,
  })
  const items = data?.items
  const permission = useNotificationPermission()
  const now = useNow(15_000)
  const router = useRouter()

  useEffect(() => {
    if (permission !== 'granted' || !items) return
    for (const d of items) {
      const key = `${d.projectId}:${d.period}`
      if (notified(key)) continue
      remember(key)
      try {
        const n = new Notification(`${d.project}: report ${d.state === 'due' ? 'due' : 'missing'}`, {
          body: `The ${d.cadence} report for ${d.label} is due at ${clock(d.dueAt)}.`,
          tag: `report-due-${key}`,
        })
        n.onclick = () => {
          window.focus()
          void router.navigate({ to: '/projects/$id/daily', params: { id: String(d.projectId) } })
        }
      } catch {
        // Some browsers (Chrome on Android) only notify from a service worker: the banner still says it.
      }
    }
  }, [items, permission, router])

  if (!items?.length) return null
  return (
    <section
      aria-label="Reports due"
      className="border-b border-amber-300/60 bg-amber-50 text-amber-950 dark:border-amber-400/20 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <div className="mx-auto flex max-w-7xl flex-col items-start gap-1.5 px-4 py-2 text-sm sm:flex-row sm:items-center sm:gap-4">
        <ul className="flex w-full min-w-0 flex-1 flex-wrap gap-x-5 gap-y-1">
          {items.map((d) => {
            const missing = d.state === 'missing' || now >= Date.parse(d.dueAt)
            const Icon = missing ? TriangleAlert : AlarmClock
            return (
              <li key={d.projectId} className="flex min-w-0 items-start gap-1.5">
                <Icon
                  className={cn(
                    'mt-0.5 size-4 shrink-0',
                    missing ? 'text-rose-600 dark:text-rose-400' : 'text-amber-600 dark:text-amber-400',
                  )}
                  aria-hidden
                />
                <Link
                  to="/projects/$id/daily"
                  params={{ id: String(d.projectId) }}
                  className="min-w-0 [overflow-wrap:anywhere] underline-offset-2 hover:underline"
                >
                  <span className="font-medium">{d.project}</span>
                  {missing
                    ? `: report missing, the shift ended at ${clock(d.dueAt)}`
                    : `: report due in ${left(Date.parse(d.dueAt) - now)}, at ${clock(d.dueAt)}`}
                </Link>
              </li>
            )
          })}
        </ul>
        <NotifyMe />
      </div>
    </section>
  )
}

/**
 * Asks the browser for notifications, only when clicked, and says how it stands once answered.
 * Nothing where the browser has no notifications.
 */
export function NotifyMe({ className }: { className?: string }) {
  const permission = useNotificationPermission()
  const [asking, setAsking] = useState(false)
  if (permission === 'unsupported') return null
  if (permission !== 'default')
    return (
      <span className={cn('flex items-center gap-1 text-xs opacity-80', className)}>
        {permission === 'granted' ? (
          <>
            <Bell className="size-3.5" aria-hidden /> Notifications on in this browser
          </>
        ) : (
          <>
            <BellOff className="size-3.5" aria-hidden /> Notifications blocked in this browser
          </>
        )}
      </span>
    )
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={className}
      disabled={asking}
      title="A browser notification when a report is due (while a board tab is open)"
      onClick={async () => {
        setAsking(true)
        try {
          await Notification.requestPermission()
        } finally {
          setAsking(false)
          for (const l of listeners) l()
        }
      }}
    >
      <Bell data-icon="inline-start" /> Notify me
    </Button>
  )
}

// The browser's notification permission, read live; whoever asks tells the others it may have moved.
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
const permissionNow = (): NotificationPermission | 'unsupported' =>
  typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
const useNotificationPermission = () =>
  useSyncExternalStore(subscribe, permissionNow, () => 'unsupported' as const)

// Which project and period this browser was notified about already. In localStorage, so a reload or
// another page does not notify again; in memory too, for when the storage cannot be used.
const KEY = 'report-due-notified'
const seen = new Set<string>()
function stored(): string[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
const notified = (key: string) => seen.has(key) || stored().includes(key)
function remember(key: string) {
  seen.add(key)
  try {
    localStorage.setItem(KEY, JSON.stringify([...stored().filter((k) => k !== key), key].slice(-100)))
  } catch {
    // Kept in memory, for this page only.
  }
}

/** The time now, again every `ms`. */
function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** "25 min", "1 h 20 min". */
function left(ms: number) {
  const minutes = Math.max(1, Math.ceil(ms / 60_000))
  const h = Math.floor(minutes / 60)
  return h ? `${h} h${minutes % 60 ? ` ${minutes % 60} min` : ''}` : `${minutes} min`
}
