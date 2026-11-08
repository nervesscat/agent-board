/**
 * The desktop app's updates as GET /api/updates answers them (src/server/updates.ts). Under the app, the
 * state its main process keeps (desktop/app/updates.mjs, UpdatesState there); a board run from a
 * checkout has no updater, and says how it is updated instead.
 */

export type UpdateStatus =
  /** This copy of the app cannot update itself (run unpacked, not from its installer or package). */
  | 'unsupported'
  /** Not checked yet. */
  | 'idle'
  | 'checking'
  /** No newer release is offered. */
  | 'none'
  /** `newest` is offered: Download and install. */
  | 'available'
  | 'downloading'
  /** Downloaded and checked; installing, then the app starts again as the new version. */
  | 'installing'
  /** Downloaded, but polkit could not install it: `manual` is the command to run. */
  | 'manual'
  | 'error'

export interface UpdateSettings {
  /** Check at start and every few hours. */
  autoCheck: boolean
  /** Offer pre-releases (`0.3.0-beta.1`) too. */
  prereleases: boolean
}

export interface DesktopUpdates {
  mode: 'desktop'
  /** The app's version. */
  installed: string
  packageType: 'nsis' | 'appimage' | 'deb' | 'rpm' | 'pacman' | null
  status: UpdateStatus
  /** The newer release offered, its notes as plain text; null when none is. */
  newest: { version: string; notes: string; date: string | null } | null
  progress: { percent: number; transferred: number; total: number } | null
  error: string | null
  /** The command that installs the downloaded package, and that file's absolute path. */
  manual: { command: string; file: string } | null
  checkedAt: string | null
  settings: UpdateSettings
}

export interface CheckoutUpdates {
  mode: 'checkout'
}

export type UpdatesState = DesktopUpdates | CheckoutUpdates

/** What the badge in the top bar and the Updates section's Download and install go by. */
export const updateOffered = (s: UpdatesState | undefined): s is DesktopUpdates & { newest: object } =>
  s?.mode === 'desktop' && s.newest !== null

/** The statuses the Updates section follows by reading the state again, about every second. */
export const UPDATE_IN_PROGRESS: UpdateStatus[] = ['checking', 'downloading', 'installing']
