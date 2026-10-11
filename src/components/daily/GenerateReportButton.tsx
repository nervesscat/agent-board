import { Sparkles } from 'lucide-react'

import { Button } from '#/components/ui/button'
import type { ReportList } from '#/lib/api'

/**
 * Asks claude for the report of `period` (from the prompt, the template and the period's activity),
 * stored as a new version. `period` is null while the project has no period to report (cadence off);
 * `list` is the card's report list, with `generating` and `generateError`.
 */
export function GenerateReportButton({
  projectId: _projectId,
  period: _period,
  list: _list,
}: {
  projectId: number
  period: string | null
  list: ReportList | undefined
}) {
  return (
    <Button type="button" variant="outline" size="xs" disabled title="Not available yet">
      <Sparkles data-icon="inline-start" /> Generate with claude
    </Button>
  )
}
