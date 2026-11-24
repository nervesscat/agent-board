import { useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Skeleton } from '#/components/ui/skeleton'
import { errorMessage, get, type WorkflowEffective } from '#/lib/api'
import type { Complexity } from '#/lib/constants'
import type { WorkflowPresetId } from '#/lib/workflow'

/** The query key of the text for a preset and complexity: a save drops all of them. */
export const readsKey = (projectId: string) => ['workflow-text', projectId] as const

/**
 * What the agents read: the exact text `get_workflow` serves for a ticket that follows the preset shown, at the
 * complexity shown (the text the ticket agent is handed, with each step's procedure). Closed until opened, and
 * read from the board only then.
 */
export function WhatAgentsRead({
  projectId,
  preset,
  complexity,
}: {
  projectId: string
  preset: WorkflowPresetId
  complexity: Complexity
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const { data, error } = useQuery({
    queryKey: [...readsKey(projectId), preset, complexity],
    queryFn: () =>
      get<WorkflowEffective>(
        `/api/projects/${projectId}/workflow/effective?preset=${preset}&complexity=${complexity}`,
      ),
    enabled: open,
  })
  return (
    <details
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="group rounded-lg border bg-card"
      data-reads
    >
      <summary className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden />
        {t('workflowReads.title')}
        <span className="text-xs font-normal text-muted-foreground">{t('workflowReads.hint')}</span>
      </summary>
      <div className="border-t p-3">
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(error)}
          </p>
        ) : data ? (
          <pre
            aria-label={t('workflowReads.textLabel')}
            tabIndex={0}
            className="max-h-[32rem] overflow-auto rounded-md bg-muted/50 p-3 font-mono text-xs leading-relaxed wrap-anywhere whitespace-pre-wrap"
          >
            {data.text}
          </pre>
        ) : (
          <Skeleton className="h-40 w-full" />
        )}
      </div>
    </details>
  )
}
