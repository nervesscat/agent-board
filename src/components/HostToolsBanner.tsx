import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, TriangleAlert, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { Tip } from '#/components/ui/tooltip'
import { errorMessage, get, type HostTools, post } from '#/lib/api'
import { useHydrated } from '#/lib/useHydrated'

/**
 * On every page, while a tool the board runs is missing on its machine (or gh is signed out): each one,
 * what it breaks and how to fix it. Optional tools stay out: claude only writes the board's own reports,
 * which the Reports page asks for and explains there. Each can be dismissed on its own until the next
 * check (Check again, or the board's restart) finds it still missing; one found again goes away.
 */
export function HostToolsBanner() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: ['host-tools'],
    queryFn: () => get<HostTools>('/api/host-tools'),
    staleTime: 60_000,
  })
  const check = useMutation({
    mutationFn: () => post<HostTools>('/api/host-tools/check'),
    onSuccess: (r) => queryClient.setQueryData(['host-tools'], r),
    onError: (err) => toast.error(errorMessage(err)),
  })
  const [dismissed, setDismissed] = useState<Dismissed>({})
  useEffect(() => setDismissed(readDismissed()), [])
  // Read after mount: the check can answer before React has hydrated the page.
  const hydrated = useHydrated()

  // Not what the human is looking at: an optional tool's absence is told where that tool is used.
  const shown = (data?.tools ?? []).filter(
    (tool) => !tool.ok && !tool.optional && dismissed[tool.name] !== data!.checkedAt,
  )
  if (!hydrated || !data || !shown.length) return null
  const dismiss = (name: string) => {
    const next = { ...dismissed, [name]: data.checkedAt }
    setDismissed(next)
    writeDismissed(next)
  }
  return (
    <section
      aria-label={t('hostTools.section')}
      className="border-b border-rose-300/60 bg-rose-50 text-rose-950 dark:border-rose-400/20 dark:bg-rose-950/40 dark:text-rose-100"
    >
      <div className="mx-auto flex max-w-7xl flex-col items-start gap-1.5 px-4 py-2 text-sm sm:flex-row sm:gap-4">
        <ul className="flex w-full min-w-0 flex-1 flex-col gap-1">
          {shown.map((tool) => (
            <li key={tool.name} className="flex min-w-0 items-start gap-1.5">
              <TriangleAlert
                className="mt-0.5 size-4 shrink-0 text-rose-600 dark:text-rose-400"
                aria-hidden
              />
              <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                <Trans
                  i18nKey="hostTools.line"
                  values={{ problem: tool.problem, breaks: tool.breaks, fix: tool.fix }}
                  components={{ strong: <span className="font-medium" /> }}
                />
              </p>
              <Tip content={t('hostTools.dismissTip', { name: tool.name })}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0"
                  aria-label={t('hostTools.dismissAria', { name: tool.name })}
                  onClick={() => dismiss(tool.name)}
                >
                  <X />
                </Button>
              </Tip>
            </li>
          ))}
        </ul>
        <Tip content={t('hostTools.recheckTip')}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            aria-label={t('hostTools.recheckAria')}
            disabled={check.isPending}
            onClick={() => check.mutate()}
          >
            <RefreshCw data-icon="inline-start" className={check.isPending ? 'animate-spin' : ''} />{' '}
            {t('connect.checkAgain')}
          </Button>
        </Tip>
      </div>
    </section>
  )
}

/** Per tool, the check (its `checkedAt`) it was dismissed for. */
type Dismissed = Record<string, string>

// In localStorage, so a reload or another page keeps it hidden; in memory alone when the storage
// cannot be used.
const KEY = 'host-tools-dismissed'
function readDismissed(): Dismissed {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string'),
    )
  } catch {
    return {}
  }
}
function writeDismissed(d: Dismissed) {
  try {
    localStorage.setItem(KEY, JSON.stringify(d))
  } catch {
    // Kept in memory, for this page only.
  }
}
