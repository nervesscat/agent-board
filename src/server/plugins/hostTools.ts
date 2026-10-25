import { definePlugin } from 'nitro'

import { checkHostTools } from '../hostTools'

// The tools the board runs (git, gh, claude, node, pnpm) are checked once as the server starts, in the
// background: startup does not wait for it, and GET /api/host-tools waits for it when asked before it ends.
export default definePlugin(() => {
  void checkHostTools()
})
