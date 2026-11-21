import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { Summary } from '#/components/Summary'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  const { t } = useTranslation()
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('shell.home')}</h1>
        <p className="text-sm text-muted-foreground">{t('projectNav.homeText')}</p>
      </div>
      <Summary />
    </div>
  )
}
