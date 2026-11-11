import { definePlugin } from 'nitro'

import { startPreviewUpgradeBridge, stopPreviewUpgradeBridge } from '../previewUpgradeBridge'
import { installPreviewUpgradeHook } from '../previewUpgradeInstall'

// A preview's WebSocket under `/p/` is proxied like its HTTP (previewProxy.ts): the bridge first (it must be
// created before the wrapper below, so the wrapper does not also see it), then the board's own server.
export default definePlugin((nitroApp) => {
  startPreviewUpgradeBridge()
  installPreviewUpgradeHook()
  nitroApp.hooks.hook('close', stopPreviewUpgradeBridge)
})
