import { definePlugin } from 'nitro'

import { stopWatching, sweepResumes } from '../resume'

// A resume the board started before it stopped goes on (its process is detached): rows whose process is
// gone are closed, the ones still running are watched and timed out again.
export default definePlugin((nitroApp) => {
  sweepResumes()
  nitroApp.hooks.hook('close', stopWatching)
})
