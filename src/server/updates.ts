import { randomUUID } from 'node:crypto'

import type { UpdateSettings, UpdatesState } from '#/lib/updates'
import { HttpError } from './http'

/**
 * The desktop app's updates, for the update routes (api.ts). Under the app, the server is its child with
 * an IPC channel (desktop/app/main.mjs), and the app's main process holds the updater: these ask it over
 * that channel and pass its answer on. It says hello once the board answers; until it has, or with no
 * channel at all (a board run from a checkout: pnpm start, pnpm dev, a preview), the board is a
 * checkout's, which updates with `git pull` and `pnpm start`, and has nothing to check or install.
 *
 * The channel carries nothing but the board's own requests, and no address or secret is put in the
 * server's environment, which the runs and previews it starts inherit.
 */

/** Marks the messages of this exchange: the same in desktop/app/updates.mjs. */
export const BRIDGE = 'agent-board:updates'
/** How long the app has to answer a request. */
export const BRIDGE_TIMEOUT_MS = 10_000

/** What carries the messages: the process itself under the app; a stand-in in the tests. */
export interface DesktopChannel {
  send?: (message: unknown, callback?: (err: Error | null) => void) => boolean
  on(event: 'message', listener: (message: unknown) => void): unknown
}

type Op = 'state' | 'check' | 'install' | 'settings'
interface Pending {
  resolve: (state: UpdatesState) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Kept outside the module, like the host tools' check: the plugin that listens (plugins/desktopBridge.ts)
 * and the routes are bundled apart, each with its own copy of this module, and a hot reload evaluates
 * it again. The channel the app said hello on, the requests waiting for its answer, and the channels
 * listened on (once each).
 */
interface Kept {
  desktop: DesktopChannel | null
  pending: Map<string, Pending>
  listening: WeakSet<DesktopChannel>
}
const KEPT = Symbol.for('agent-board.desktopUpdates')
const kept = ((globalThis as { [KEPT]?: Kept })[KEPT] ??= {
  desktop: null,
  pending: new Map(),
  listening: new WeakSet(),
})
const pending = kept.pending

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/**
 * Listens on `channel` for the app's hello and answers. A process with no IPC channel (no `send`) has
 * no app to hear from. Called once as the server starts (plugins/desktopBridge.ts).
 */
export function listenForDesktop(channel: DesktopChannel = process as DesktopChannel) {
  if (typeof channel.send !== 'function' || kept.listening.has(channel)) return
  kept.listening.add(channel)
  channel.on('message', (message) => {
    if (!isRecord(message) || message.channel !== BRIDGE) return
    if (message.hello === true) {
      kept.desktop = channel
      return
    }
    const waiting = typeof message.id === 'string' ? pending.get(message.id) : undefined
    if (!waiting) return
    pending.delete(message.id as string)
    clearTimeout(waiting.timer)
    if (message.ok === true && isRecord(message.state))
      waiting.resolve(message.state as unknown as UpdatesState)
    else
      waiting.reject(
        new HttpError(
          typeof message.status === 'number' ? message.status : 500,
          typeof message.error === 'string' ? message.error : 'the desktop app refused the request',
        ),
      )
  })
}

function ask(channel: DesktopChannel, op: Op, body?: unknown): Promise<UpdatesState> {
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new HttpError(504, 'the desktop app did not answer about its updates'))
    }, BRIDGE_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    channel.send!({ channel: BRIDGE, id, op, body }, (err) => {
      if (!err) return
      pending.delete(id)
      clearTimeout(timer)
      reject(new HttpError(503, `the desktop app could not be reached: ${err.message}`))
    })
  })
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
  return kept.desktop ? ask(kept.desktop, 'state') : CHECKOUT
}

/** Starts a check; the state as it is then (checking). */
export async function checkForUpdates(): Promise<UpdatesState> {
  return kept.desktop ? ask(kept.desktop, 'check') : noUpdater()
}

/** Starts the download and install of the offered update; the state as it is then (downloading). */
export async function installUpdate(): Promise<UpdatesState> {
  return kept.desktop ? ask(kept.desktop, 'install') : noUpdater()
}

export async function changeUpdateSettings(change: Partial<UpdateSettings>): Promise<UpdatesState> {
  return kept.desktop ? ask(kept.desktop, 'settings', change) : noUpdater()
}
