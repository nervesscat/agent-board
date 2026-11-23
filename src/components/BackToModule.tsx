import { Link, type LinkProps } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'

import { buttonVariants } from '#/components/ui/button'
import { LAST_MODULE, backTarget } from '#/lib/lastModule'
import { useProjects, useSelectedProject } from '#/lib/project'
import { useRemembered } from '#/lib/remembered'
import { cn } from 'cn'

/**
 * The first thing on Settings and Connect an agent, which sit outside every project: back to the page of
 * the selected project the browser was last on, or to the new project's Overview when the project was
 * changed since (`backTarget`).
 */
export function BackToModule() {
  const { isPending } = useProjects()
  const project = useSelectedProject()
  const last = useRemembered(LAST_MODULE)
  // Its row is always there, so the title does not move when the projects have loaded.
  const target = isPending ? null : backTarget(project, last)
  return (
    <div className="min-h-8">
      {target && (
        <Link
          {...({
            to: target.to,
            params: target.params,
            search: target.search,
            hash: target.hash,
          } as unknown as LinkProps)}
          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), '-ml-2.5 text-muted-foreground')}
        >
          <ArrowLeft />
          Back to {target.label}
        </Link>
      )}
    </div>
  )
}
