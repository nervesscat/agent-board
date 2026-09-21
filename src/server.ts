import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { createServerEntry } from '@tanstack/react-start/server-entry'

import { startScheduler } from '#/server/scheduler'

// The server entry is the one module that only ever runs in the Node process, so boot-time work lives here.
startScheduler()

const fetch = createStartHandler(defaultStreamHandler)

export default createServerEntry({ fetch })
