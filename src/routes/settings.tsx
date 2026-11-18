import { createFileRoute, useLocation, useNavigate, useRouter } from '@tanstack/react-router'
import { useEffect } from 'react'

import { BoardSettings } from '#/components/BoardSettings'
import { ProjectSettings } from '#/components/ProjectSettings'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { currentProjectId, rememberCurrentProject, useProjects } from '#/lib/project'
import { whenArrived } from '#/lib/remembered'
import {
  type SettingsTab,
  projectTabSearch,
  resolveSettings,
  tabOwning,
  validateSettingsSearch,
} from '#/lib/settingsTabs'
import { useHydrated } from '#/lib/useHydrated'

export const Route = createFileRoute('/settings')({
  validateSearch: validateSettingsSearch,
  component: Settings,
})

/**
 * The one Settings page: the board's own settings, and (when there is a current project: the one in
 * the address, else the one this browser was last in) that project's, each in a tab. The tab is in the
 * address, and so is the project of the project tab.
 */
function Settings() {
  const search = Route.useSearch()
  const navigate = useNavigate()
  const router = useRouter()
  const hash = useLocation({ select: (l) => l.hash })
  const { data: projects, isPending } = useProjects()
  // The remembered project is the browser's: read after mount, so the first render matches the server's.
  const hydrated = useHydrated()
  const ready = hydrated && !isPending
  const list = projects ?? []
  const resolved = ready
    ? resolveSettings(
        search,
        hash,
        Number(currentProjectId(list.map((p) => p.id))) || undefined,
        list.map((p) => p.id),
      )
    : null
  const project = list.find((p) => p.id === resolved?.project)
  // Until the projects are known the board's tab shows, unless the address asks for the project's. The
  // first render goes by the search alone (the server never sees the #hash); the hash counts after mount.
  const tab: SettingsTab | null = resolved
    ? resolved.tab
    : search.tab === 'project' || (hydrated && tabOwning(hash) === 'project')
      ? null
      : 'board'
  const correct = resolved?.correct
  // The project the address names is the browser's current one from now on: the Board tab, whose address
  // names none, keeps offering it.
  const named = resolved?.project != null && search.project === resolved.project ? resolved.project : null
  useEffect(() => {
    if (named !== null) rememberCurrentProject(named)
  }, [named])
  // An address that says what is not so (a project that is gone, a section of the other tab) is put right,
  // keeping its #section.
  useEffect(() => {
    if (!correct) return
    return whenArrived(router, () => {
      void navigate({ to: '/settings', search: correct, hash: hash || undefined, replace: true })
    })
  }, [correct, hash, navigate, router])
  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <Tabs
        value={tab ?? 'board'}
        onValueChange={(value) => {
          if (value === 'project' && project)
            void navigate({ to: '/settings', search: projectTabSearch(project.id) })
          else if (value === 'board') void navigate({ to: '/settings', search: {} })
        }}
      >
        <TabsList aria-label="Settings" activateOnFocus className="max-w-full">
          <TabsTrigger value="board">Board</TabsTrigger>
          {project && (
            <TabsTrigger value="project" className="min-w-0">
              <span className="truncate">This project: {project.name}</span>
            </TabsTrigger>
          )}
        </TabsList>
        {tab === 'board' && (
          <TabsContent value="board">
            <BoardSettings />
          </TabsContent>
        )}
        {tab === 'project' && project && (
          <TabsContent value="project">
            <ProjectSettings id={String(project.id)} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}
