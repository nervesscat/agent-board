import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { boardAddress, readDotenv } from './dotenv.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-dotenv-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

let files = 0
/** Where the board listens by a .env of these lines, ending in `eol`. */
function addressOf(lines, eol = '\n') {
  const file = path.join(tmp, `${++files}.env`)
  fs.writeFileSync(file, lines.map((l) => `${l}${eol}`).join(''))
  return boardAddress(readDotenv(file))
}

describe("the board's address from .env (pnpm start, pnpm tailnet)", () => {
  it('is 127.0.0.1:47100 when .env sets neither, or sets them empty', () => {
    expect(boardAddress(readDotenv(path.join(tmp, 'none.env')))).toEqual({ port: 47100, host: '127.0.0.1' })
    expect(addressOf([])).toEqual({ port: 47100, host: '127.0.0.1' })
    expect(addressOf(['PORT=', 'HOST='])).toEqual({ port: 47100, host: '127.0.0.1' })
  })

  it('reads the values bare: no inline comment, no quotes, LF or CRLF', () => {
    for (const eol of ['\n', '\r\n']) {
      const label = JSON.stringify(eol)
      expect(addressOf(['PORT=47100 # the live board', 'HOST=127.0.0.1 # loopback'], eol), label).toEqual({
        port: 47100,
        host: '127.0.0.1',
      })
      expect(addressOf(['PORT="47123" # quoted', "HOST='localhost'"], eol), label).toEqual({
        port: 47123,
        host: 'localhost',
      })
      expect(addressOf(['  PORT = 47124  ', 'HOST=::1'], eol), label).toEqual({ port: 47124, host: '::1' })
    }
  })
})
