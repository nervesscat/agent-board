import { definePlugin } from 'nitro'

import { seedRuns } from '../runConfig'

// A checkout of the board that was never given its preview run gets it as the server starts (once per
// repo: one the human deleted stays deleted).
export default definePlugin(() => {
  seedRuns()
})
