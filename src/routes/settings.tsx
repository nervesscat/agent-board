import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { toast } from 'sonner'

import { AgentIdentities } from '#/components/AgentIdentities'
import { AgentPicker } from '#/components/AgentPicker'
import { Devices } from '#/components/Devices'
import { PreviewLimitEditor } from '#/components/Preview'
import { Updates } from '#/components/Updates'
import { errorMessage, get, type Me, patch } from '#/lib/api'
import type { Settings } from '#/server/agents'

export const Route = createFileRoute('/settings')({ component: BoardSettings })

/** Board-wide preferences; each project's own settings live under the project. */
function BoardSettings() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['settings'], queryFn: () => get<Settings>('/api/settings') })
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => get<Me>('/api/me'), staleTime: Infinity })
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
            Connect an agent
          </Link>{' '}
          opens on, showing only its commands.
        </p>
        <AgentPicker value={data.defaultAgent} onChange={(defaultAgent) => save.mutate({ defaultAgent })} />
      </section>
      <section className="space-y-2">
        <h2 className="text-sm font-medium">Previews</h2>
        <p className="text-sm text-muted-foreground">
          How many previews the board builds and runs at once, in every project (1 to 32). Each is a whole
          board with its own copy of the data; a start beyond the limit is refused. A project's Previews page
          shows how many are in use.
        </p>
        <PreviewLimitEditor key={data.previewLimit} id="settings-preview-limit" limit={data.previewLimit} />
      </section>
      {/* The app's updates are the human's: an agent never sees them here, and their routes refuse one. */}
      {me && !me.agent && <Updates />}
      {/* The agents' roles are the human's call: an agent never sees them here. */}
      {me && !me.agent && <AgentIdentities />}
      {/* With sign-in off (test mode, AUTH=off) there are no passkeys to show. */}
      {me && !me.authOff && !me.agent && <Devices />}
    </div>
  )
}
