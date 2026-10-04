import { definePlugin } from 'nitro'

import { startUploadSweep } from '../unattached'

// Unattached uploads older than a day are deleted in the background, hourly, never inside a request.
export default definePlugin((nitroApp) => {
  const stop = startUploadSweep()
  nitroApp.hooks.hook('close', stop)
})
