import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { toast } from 'sonner'

import { AgentPicker } from '#/components/AgentPicker'
import { errorMessage, get, patch } from '#/lib/api'
import type { Settings } from '#/server/agents'

export const Route = createFileRoute('/settings')({ component: BoardSettings })

/** Board-wide preferences; each project's own settings live under the project. */
function BoardSettings() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['settings'], queryFn: () => get<Settings>('/api/settings') })
  const save = useMutation({
    mutationFn: (p: Partial<Settings>) => patch<Settings>('/api/settings', p),
    onSuccess: (s) => {
      qc.setQueryData(['settings'], s)
      qc.invalidateQueries({ queryKey: ['agent-setup'] })
      toast.success('Saved')
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  if (!data) return null
  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <section className="space-y-2">
        <h2 className="text-sm font-medium">Default agent CLI</h2>
        <p className="text-sm text-muted-foreground">
          The one{' '}
          <Link to="/agents" className="underline hover:text-foreground">
            Connect agents
          </Link>{' '}
          opens on, showing only its commands.
        </p>
        <AgentPicker value={data.defaultAgent} onChange={(defaultAgent) => save.mutate({ defaultAgent })} />
      </section>
    </div>
  )
}
