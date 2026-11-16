import { definePlugin } from 'nitro'

import { installKeepAlive } from '../keepAlive'

// Before the server is created: the built board's HTTP server and the dev worker's are made after this runs.
export default definePlugin(() => {
  installKeepAlive()
})
