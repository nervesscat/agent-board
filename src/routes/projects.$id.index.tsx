import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { layoutLabel } from '#/lib/layout'

import { Summary } from '#/components/Summary'

export const Route = createFileRoute('/projects/$id/')({ component: Overview })

function Overview() {
  const { t } = useTranslation()
  const { id } = Route.useParams()
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{layoutLabel('nav.overview', t)}</h1>
        <p className="text-sm text-muted-foreground">{t('projectNav.overviewText')}</p>
      </div>
      <Summary projectId={Number(id)} />
    </div>
  )
}
