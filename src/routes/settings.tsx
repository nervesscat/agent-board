import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { AgentIdentities } from '#/components/AgentIdentities'
import { AgentPicker } from '#/components/AgentPicker'
import { Devices } from '#/components/Devices'
import { TailnetEntrance } from '#/components/TailnetEntrance'
import { PreviewLimitEditor } from '#/components/Preview'
import { Updates } from '#/components/Updates'
import { Tabs, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { errorMessage, get, type Me, patch } from '#/lib/api'
import { useAnchor, useReveal } from '#/lib/reveal'
import { THEMES, THEME_LABEL, readTheme, setTheme, type Theme } from '#/lib/theme'
import type { Settings } from '#/server/agents'

export const Route = createFileRoute('/settings')({ component: BoardSettings })

/** Board-wide preferences; each project's own settings live under the project. */
function BoardSettings() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['settings'], queryFn: () => get<Settings>('/api/settings') })
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => get<Me>('/api/me'), staleTime: Infinity })
  // A link into a section (#theme, #previews …) lands on it on an in-app navigation too.
  useReveal(useAnchor(), { ready: data !== undefined && me !== undefined })
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
      <section id="default-agent" className="scroll-mt-16 space-y-2">
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
      <Theme />
      <section id="previews" className="scroll-mt-16 space-y-2">
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
      {me && !me.agent && (
        <div id="agent-roles" className="scroll-mt-16">
          <AgentIdentities />
        </div>
      )}
      {/* The tailnet entrance is the human's; with sign-in off it shows why it cannot be saved there. */}
      {me && !me.agent && (
        <div id="tailnet" className="scroll-mt-16">
          <TailnetEntrance />
        </div>
      )}
      {/* With sign-in off (test mode, AUTH=off) there are no passkeys to show. */}
      {me && !me.authOff && !me.agent && (
        <div id="devices" className="scroll-mt-16">
          <Devices />
        </div>
      )}
    </div>
  )
}

/**
 * The board's colour scheme: the system's unless this browser picked light or dark. It follows the
 * system's changes while the system's is picked (src/lib/theme.ts).
 */
function Theme() {
  const [theme, pick] = useState<Theme>('system')
  useEffect(() => {
    const saved = readTheme()
    pick(saved)
    setTheme(saved)
  }, [])
  return (
    <section id="theme" className="scroll-mt-16 space-y-2">
      <h2 className="text-sm font-medium">Theme</h2>
      <p className="text-sm text-muted-foreground">
        Follows your system by default. The choice is kept in this browser, not on the board.
      </p>
      <Tabs
        value={theme}
        onValueChange={(value) => {
          const next = THEMES.find((t) => t === value) ?? 'system'
          pick(next)
          setTheme(next)
        }}
      >
        <TabsList aria-label="Theme">
          {THEMES.map((value) => (
            <TabsTrigger key={value} value={value}>
              {THEME_LABEL[value]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </section>
  )
}
