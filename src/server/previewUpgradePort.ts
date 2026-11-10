import fs from 'node:fs'
import path from 'node:path'

import { config } from './config'

/**
 * Where the board tells `vite dev`'s process the loopback port its preview-upgrade bridge listens on. The
 * board itself runs in Nitro's worker, whose memory Vite's process cannot read, and a preview's sign-in
 * gate and run state live there: the Vite process forwards an upgrade to the bridge rather than asking the
 * board's database itself. Nothing but the port is written, and only loopback may connect to it.
 */
export const upgradePortFile = () => path.join(config.dataDir, 'preview-upgrade.json')

/** The bridge's port, or null when the board has not written one (yet, or any more). */
export function readUpgradePort(): number | null {
  try {
    const saved = JSON.parse(fs.readFileSync(upgradePortFile(), 'utf8')) as { port?: unknown }
    const port = saved.port
    return typeof port === 'number' && Number.isInteger(port) && port > 0 ? port : null
  } catch {
    return null
  }
}

/** Writes the port at once and whole, so a reader never sees half a file. */
export function writeUpgradePort(port: number) {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true })
    const file = upgradePortFile()
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ port }), { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch (err) {
    console.error('could not write the preview upgrade port:', err)
  }
}

/** Clears the file a previous bridge left: only when it is this bridge's own port. */
export function clearUpgradePort(port: number) {
  try {
    if (readUpgradePort() === port) fs.unlinkSync(upgradePortFile())
  } catch {
    // gone already
  }
}
