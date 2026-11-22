import { definePlugin } from 'nitro'

import { startAlertEvaluator } from '../alerts/evaluate'
import { authMode } from '../config'

// The alert checks run in the background, shortly after start and then every minute, never inside a
// request. A test-mode board runs none: its tests call the evaluator themselves.
export default definePlugin((nitroApp) => {
  if (authMode().boardEnv === 'test') return
  const stop = startAlertEvaluator()
  nitroApp.hooks.hook('close', stop)
})
