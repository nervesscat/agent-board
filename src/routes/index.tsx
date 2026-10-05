import { createFileRoute } from '@tanstack/react-router'

import { Summary } from '#/components/Summary'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Home</h1>
        <p className="text-sm text-muted-foreground">
          Every project at a glance: what waits on you, what is in progress, what got done today and what is
          next.
        </p>
      </div>
      <Summary />
    </div>
  )
}
