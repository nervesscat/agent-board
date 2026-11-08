import { randomUUID } from 'node:crypto'

import type { UpdateSettings, UpdatesState } from '#/lib/updates'
import { HttpError } from './http'

/**
 * The desktop app's updates, for the update routes (api.ts). Under the app, the server is its child with
 * an IPC channel (desktop/app/main.mjs), and the app's main process holds the updater: these ask it over
 * that channel and pass its answer on. It says hello once the board answers, so a request can come
 * before it (the page polls through a restart of the server): one that does waits for the hello, up to
 * HELLO_WAIT_MS. With no channel at all (a board run from a checkout: pnpm start, pnpm dev, a preview),
 * or no hello by then, the board is a checkout's, which updates with `git pull` and `pnpm start`, and
 * has nothing to check or install.
 *
 * The channel carries nothing but the board's own requests, and no address or secret is put in the
 * server's environment, which the runs and previews it starts inherit.
 */

/** Marks the messages of this exchange: the same in desktop/app/updates.mjs. */
export const BRIDGE = 'agent-board:updates'
/** How long the app has to answer a request. */
export const BRIDGE_TIMEOUT_MS = 10_000
/**
 * How long a request that comes before the app's hello waits for it. The app greets as soon as the
 * server answers its health check (every 250 ms), so this is ample; a server with a channel but no app
 * on it (the benchmark's) is delayed this once, then answers as a checkout's at once.
 */
export const HELLO_WAIT_MS = 3_000

/** What carries the messages: the process itself under the app; a stand-in in the tests. */
export interface DesktopChannel {
  send?: (message: unknown, callback?: (err: Error | null) => void) => boolean
  on(event: 'message', listener: (message: unknown) => void): unknown
  /** The IPC channel's handle (process.channel), which a 'message' listener keeps ref'd. */
  channel?: { unref(): void }
}

type Op = 'state' | 'check' | 'install' | 'settings'
interface Pending {
  resolve: (state: UpdatesState) => void
  /**
   * Refuses the request with the app's status and message. Made by ask(), in the copy of this module
   * the routes use, so the HttpError it throws is the class the routes' api() wrapper checks for: the
   * listener (the plugin's copy) does not build one, which that check would miss.
   */
  refuse: (status: number, message: string) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Kept outside the module, like the host tools' check: the plugin that listens (plugins/desktopBridge.ts)
 * and the routes are bundled apart, each with its own copy of this module, and a hot reload evaluates
 * it again. The channel the app said hello on, the requests waiting for its answer, and the channels
 * listened on (once each); whether any has been (the server may yet hear from an app), the wait for the
 * hello that requests share, and whether that wait ran out.
 */
interface Kept {
  desktop: DesktopChannel | null
  pending: Map<string, Pending>
  listening: WeakSet<DesktopChannel>
  listened: boolean
  greeting: { promise: Promise<void>; greeted: () => void } | null
  gaveUp: boolean
}
const KEPT = Symbol.for('agent-board.desktopUpdates')
const kept = ((globalThis as { [KEPT]?: Kept })[KEPT] ??= {
  desktop: null,
  pending: new Map(),
  listening: new WeakSet(),
  listened: false,
  greeting: null,
  gaveUp: false,
})
const pending = kept.pending

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/**
 * Listens on `channel` for the app's hello and answers. A process with no IPC channel (no `send`) has
 * no app to hear from. Called once as the server starts (plugins/desktopBridge.ts).
 *
 * Listening does not keep the process alive: a 'message' listener refs the IPC channel, and the server
 * ends on SIGTERM by closing what it holds and letting the event loop empty (Nitro's graceful
 * shutdown), so with the channel ref'd it would stay until the app kills it. A request waiting for its
 * answer is held by its timer; one waiting for the hello is not.
 */
export function listenForDesktop(channel: DesktopChannel = process as DesktopChannel) {
  if (typeof channel.send !== 'function' || kept.listening.has(channel)) return
  kept.listening.add(channel)
  kept.listened = true
  // The server ends on SIGTERM by closing its HTTP server, which waits for the requests in flight: one
  // waiting for the hello would hold it for HELLO_WAIT_MS, so the wait ends with the shutdown too.
  process.once('SIGTERM', endHelloWait)
  channel.on('message', (message) => {
    if (!isRecord(message) || message.channel !== BRIDGE) return
    if (message.hello === true) {
      kept.desktop = channel
      kept.greeting?.greeted()
      return
    }
    const waiting = typeof message.id === 'string' ? pending.get(message.id) : undefined
    if (!waiting) return
    pending.delete(message.id as string)
    clearTimeout(waiting.timer)
    if (message.ok === true && isRecord(message.state))
      waiting.resolve(message.state as unknown as UpdatesState)
    else
      waiting.refuse(
        typeof message.status === 'number' ? message.status : 500,
        typeof message.error === 'string' ? message.error : 'the desktop app refused the request',
      )
  })
  channel.channel?.unref()
}

function ask(channel: DesktopChannel, op: Op, body?: unknown): Promise<UpdatesState> {
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new HttpError(504, 'the desktop app did not answer about its updates'))
    }, BRIDGE_TIMEOUT_MS)
    pending.set(id, {
      resolve,
      refuse: (status, message) => reject(new HttpError(status, message)),
      timer,
    })
    channel.send!({ channel: BRIDGE, id, op, body }, (err) => {
      if (!err) return
      pending.delete(id)
      clearTimeout(timer)
      reject(new HttpError(503, `the desktop app could not be reached: ${err.message}`))
    })
  })
}

/** Ends the wait for the hello for everyone: the server is stopping, and the app is not coming. */
function endHelloWait() {
  kept.gaveUp = true
  kept.greeting?.greeted()
}

/**
 * The channel the app said hello on, once it has; null for a checkout's board. Before the hello, with a
 * channel listened on, waits for it: all such requests share one wait, ended by the hello or after
 * HELLO_WAIT_MS, and once that ran out without one, nobody waits again.
 */
async function desktopApp(): Promise<DesktopChannel | null> {
  if (kept.desktop || !kept.listened || kept.gaveUp) return kept.desktop
  if (!kept.greeting) {
    let greeted!: () => void
    const promise = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        kept.gaveUp = true
        resolve()
      }, HELLO_WAIT_MS)
      // The process may end while a request waits (on SIGTERM, say): the wait does not keep it.
      timer.unref()
      greeted = () => {
        clearTimeout(timer)
        resolve()
      }
    })
    kept.greeting = { promise, greeted }
    void promise.then(() => (kept.greeting = null))
  }
  await kept.greeting.promise
  return kept.desktop
}

const CHECKOUT: UpdatesState = { mode: 'checkout' }

/** The checkout's answer to a check, an install or a change of the update settings. */
function noUpdater(): never {
  throw new HttpError(
    409,
    'this board runs from a checkout, which has no updater: git pull on main there, then pnpm start',
  )
}

export async function updatesState(): Promise<UpdatesState> {
  const app = await desktopApp()
  return app ? ask(app, 'state') : CHECKOUT
}

/** Starts a check; the state as it is then (checking). */
export async function checkForUpdates(): Promise<UpdatesState> {
  const app = await desktopApp()
  return app ? ask(app, 'check') : noUpdater()
}

/** Starts the download and install of the offered update; the state as it is then (downloading). */
export async function installUpdate(): Promise<UpdatesState> {
  const app = await desktopApp()
  return app ? ask(app, 'install') : noUpdater()
}

export async function changeUpdateSettings(change: Partial<UpdateSettings>): Promise<UpdatesState> {
  const app = await desktopApp()
  return app ? ask(app, 'settings', change) : noUpdater()
}
