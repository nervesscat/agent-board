import { definePlugin } from 'nitro'

import { listenForDesktop } from '../updates'

// Under the desktop app the server has an IPC channel to it, for the update routes (updates.ts): it
// listens for the app's hello from the start.
export default definePlugin(() => {
  listenForDesktop()
})
