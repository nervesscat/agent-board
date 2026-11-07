import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  appendServerLog,
  exitLine,
  exitSentence,
  SERVER_LOG,
  spawnFailedLine,
  startLine,
} from './app/serverLog.mjs'

/** @type {string[]} */
const dirs = []
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-log-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const at = new Date('2026-11-04T20:33:47.853Z')

describe('the server log lines', () => {
  it('a start names the time and the pid', () => {
    expect(startLine({ pid: 5901, at })).toBe('2026-11-04T20:33:47.853Z server pid 5901 started')
  })

  it('an exit names the time, the pid, the signal, the code, the uptime and whether the app was quitting', () => {
    const startedAt = at.getTime() - 16_832_000
    expect(exitLine({ pid: 5901, code: null, signal: 'SIGKILL', startedAt, quitting: false, at })).toBe(
      '2026-11-04T20:33:47.853Z server pid 5901 exited signal=SIGKILL code=null uptime=16832s quitting=false',
    )
    expect(exitLine({ pid: 5901, code: 1, signal: null, startedAt: at.getTime(), quitting: true, at })).toBe(
      '2026-11-04T20:33:47.853Z server pid 5901 exited signal=null code=1 uptime=0s quitting=true',
    )
  })

  it('a server that could not be started says why', () => {
    expect(spawnFailedLine({ error: 'spawn ENOENT', at })).toBe(
      '2026-11-04T20:33:47.853Z server could not be started: spawn ENOENT',
    )
  })

  it('a real process killed by SIGKILL is logged by its signal', async () => {
    const startedAt = Date.now()
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    const ended = new Promise((resolve) =>
      child.on('exit', (code, signal) =>
        resolve(exitLine({ pid: child.pid, code, signal, startedAt, quitting: false })),
      ),
    )
    child.kill('SIGKILL')
    expect(await ended).toMatch(
      new RegExp(
        `^\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z server pid ${child.pid} exited signal=SIGKILL code=null uptime=\\d+s quitting=false$`,
      ),
    )
  })
})

describe('exitSentence', () => {
  it('names the signal that killed it, else its code, and the time', () => {
    const time = at.toLocaleTimeString()
    expect(exitSentence(null, 'SIGKILL', at)).toBe(`It was killed by SIGKILL at ${time}.`)
    expect(exitSentence(3, null, at)).toBe(`It exited with code 3 at ${time}.`)
    expect(exitSentence(0, null, at)).toBe(`It exited with code 0 at ${time}.`)
    expect(exitSentence(null, null, at)).toBe(`It exited at ${time}.`)
  })
})

describe('appendServerLog', () => {
  it('appends a line each time', () => {
    const dir = tmp()
    expect(appendServerLog(dir, 'one')).toBe(true)
    expect(appendServerLog(dir, 'two')).toBe(true)
    expect(fs.readFileSync(path.join(dir, SERVER_LOG), 'utf8')).toBe('one\ntwo\n')
  })

  it('moves a full log to desktop.log.1, the older one going, so it stays bounded', () => {
    const dir = tmp()
    const file = path.join(dir, SERVER_LOG)
    for (let i = 0; i < 50; i++) appendServerLog(dir, `line ${i} ${'x'.repeat(20)}`, 100)
    expect(fs.statSync(file).size).toBeLessThan(100 + 40)
    expect(fs.statSync(`${file}.1`).size).toBeLessThan(100 + 40)
    expect(fs.readdirSync(dir).sort()).toEqual([SERVER_LOG, `${SERVER_LOG}.1`])
    expect(fs.readFileSync(file, 'utf8').trim().split('\n').at(-1)).toMatch(/^line 49 /)
  })

  it('a log that cannot be written is no failure', () => {
    const dir = tmp()
    const notAFolder = path.join(dir, 'file')
    fs.writeFileSync(notAFolder, '')
    expect(appendServerLog(notAFolder, 'line')).toBe(false)
    expect(appendServerLog(path.join(dir, 'missing', 'logs'), 'line')).toBe(false)
  })
})
