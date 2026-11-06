import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadOptions } from 'nitro/builder'
import { loadEnv } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { readAuthMode, readPublicEntrance, readServedEntrance, StartupError } from './config'
import { adoptCheckedEnv, CHECKED_KEYS } from './devEnv'

/**
 * `vite dev` as vite.config.ts runs it: the checked keys adopted from Vite's loadEnv, then Nitro's own
 * `.env` loader as its Vite plugin calls it (c12, the files Vite reads for the mode). What process.env
 * holds after both is what the startup checks (vite.config.ts, startup.ts) and the board's runtime read.
 */

const PUBLIC = 'devbox.example-tailnet.ts.net'
const MODE = 'development'
// Every key a fixture names, so that none comes from the environment the tests run in.
const KEYS = [...CHECKED_KEYS, 'TAILNET_HOST_X', 'MODE_X', 'UNDEF_X']

const dirs: string[] = []
function project(dotenv: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-env-'))
  dirs.push(dir)
  fs.writeFileSync(path.join(dir, '.env'), dotenv)
  return dir
}

const checked = (e: Record<string, string | undefined>) =>
  Object.fromEntries(CHECKED_KEYS.map((key) => [key, e[key]]))

/** The shell's environment, then `vite dev` on `dir`: what loadEnv gives, and what process.env holds. */
async function viteDev(dir: string, shell: Record<string, string> = {}) {
  for (const key of KEYS) vi.stubEnv(key, shell[key])
  const expected = checked(loadEnv(MODE, dir, ''))
  adoptCheckedEnv(MODE, dir, new Map())
  const fileName = ['.env', '.env.local', `.env.${MODE}`, `.env.${MODE}.local`]
  await loadOptions({ rootDir: dir, dev: true }, { dotenv: { fileName } })
  return { expected, seen: checked(process.env) }
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('the checked keys under vite dev', () => {
  const cases: [string, string, Record<string, string | undefined>][] = [
    [
      'a reference to a key above',
      `TAILNET_HOST_X=${PUBLIC}\nPUBLIC_ORIGIN=https://\${TAILNET_HOST_X}\n`,
      { PUBLIC_ORIGIN: `https://${PUBLIC}` },
    ],
    [
      'a reference to a key below',
      `PUBLIC_ORIGIN=https://\${TAILNET_HOST_X}\nTAILNET_HOST_X=${PUBLIC}\n`,
      { PUBLIC_ORIGIN: `https://${PUBLIC}` },
    ],
    [
      'a $NAME reference',
      `TAILNET_HOST_X=${PUBLIC}\nPUBLIC_ORIGIN=https://$TAILNET_HOST_X\n`,
      { PUBLIC_ORIGIN: `https://${PUBLIC}` },
    ],
    [
      'an undefined name with a default',
      `PUBLIC_ORIGIN=https://\${UNDEF_X:-${PUBLIC}}\n`,
      { PUBLIC_ORIGIN: `https://${PUBLIC}` },
    ],
    [
      'an undefined name',
      `PUBLIC_ORIGIN=https://\${UNDEF_X}${PUBLIC}\n`,
      { PUBLIC_ORIGIN: `https://${PUBLIC}` },
    ],
    ['an undefined name alone', 'PUBLIC_ORIGIN=https://${UNDEF_X}\n', { PUBLIC_ORIGIN: 'https://' }],
    [
      'BOARD_ENV and AUTH by reference and default',
      'MODE_X=development\nBOARD_ENV=${MODE_X}\nAUTH=${UNDEF_X:-off}\n',
      { BOARD_ENV: 'development', AUTH: 'off' },
    ],
  ]

  for (const [name, dotenv, values] of cases)
    it(`are Vite's loadEnv values: ${name}`, async () => {
      const { expected, seen } = await viteDev(project(dotenv))
      expect(expected).toMatchObject(values)
      expect(seen).toEqual(expected)
    })

  it("leave the shell's values as they are, over .env's", async () => {
    const dir = project(`PUBLIC_ORIGIN=https://${PUBLIC}\nBOARD_ENV=production\nAUTH=on\n`)
    const shell = { PUBLIC_ORIGIN: '', BOARD_ENV: 'development', AUTH: 'off' }
    const { expected, seen } = await viteDev(dir, shell)
    expect(expected).toEqual(shell)
    expect(seen).toEqual(shell)
    // What `pnpm dev` does: its copy serves no entrance, whatever the board's .env says.
    expect(readPublicEntrance(process.env)).toBeNull()
    expect(readAuthMode(process.env).off).toBe(true)
  })

  it('give the checks and the guard the expanded entrance', async () => {
    await viteDev(project(`PUBLIC_ORIGIN=https://\${UNDEF_X:-${PUBLIC}}\n`))
    expect(readServedEntrance(process.env)).toEqual({ origin: `https://${PUBLIC}`, host: PUBLIC })
  })

  it('are refused as expanded when the board cannot trust them', async () => {
    for (const [dotenv, value] of [
      ['PUBLIC_ORIGIN=https://${UNDEF_X}\n', 'https://'],
      [`TAILNET_HOST_X=${PUBLIC}\nPUBLIC_ORIGIN=http://\${TAILNET_HOST_X}\n`, `http://${PUBLIC}`],
    ]) {
      await viteDev(project(dotenv!))
      const read = () => readPublicEntrance(process.env)
      expect(read).toThrow(StartupError)
      expect(read).toThrow(`got "${value}"`)
      vi.unstubAllEnvs()
    }
  })

  it('are read again from an edited .env when Vite restarts, not kept as if from the shell', async () => {
    const dir = project(`PUBLIC_ORIGIN=https://\${UNDEF_X:-${PUBLIC}}\n`)
    for (const key of KEYS) vi.stubEnv(key, undefined)
    const adopted = new Map<string, string>()
    adoptCheckedEnv(MODE, dir, adopted)
    expect(process.env.PUBLIC_ORIGIN).toBe(`https://${PUBLIC}`)
    fs.writeFileSync(path.join(dir, '.env'), 'PUBLIC_ORIGIN=https://other.example-tailnet.ts.net\n')
    adoptCheckedEnv(MODE, dir, adopted)
    expect(process.env.PUBLIC_ORIGIN).toBe('https://other.example-tailnet.ts.net')
    fs.writeFileSync(path.join(dir, '.env'), '')
    adoptCheckedEnv(MODE, dir, adopted)
    expect(process.env.PUBLIC_ORIGIN).toBeUndefined()
  })
})
