import { createFileRoute, redirect } from '@tanstack/react-router'

import { projectTabSearch } from '#/lib/settingsTabs'

// A project's settings are the project tab of the Settings page now; old links follow it there, keeping
// their #section. A link into the instructions history goes to the Instructions page, which has it.
export const Route = createFileRoute('/projects/$id/settings')({
  beforeLoad: ({ location, params }) => {
    if (location.hash === 'instructions-history')
      throw redirect({
        to: '/projects/$id/instructions',
        params,
        hash: 'instructions-history',
        replace: true,
      })
    throw redirect({
      to: '/settings',
      search: projectTabSearch(params.id),
      hash: location.hash || undefined,
      replace: true,
    })
  },
})
