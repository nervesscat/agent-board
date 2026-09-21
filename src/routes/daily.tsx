import { createFileRoute } from '@tanstack/react-router'

import { DailyView } from '#/components/DailyView'

export const Route = createFileRoute('/daily')({ component: () => <DailyView /> })
