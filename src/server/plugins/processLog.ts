import { definePlugin } from 'nitro'

import { logProcessEnd } from '../processLog'

// How the server ends leaves a line on stderr: the signal it was sent, an error that escaped, its exit.
export default definePlugin(() => {
  logProcessEnd()
})
