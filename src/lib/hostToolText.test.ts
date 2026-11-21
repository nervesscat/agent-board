import os from 'node:os'

import { describe, expect, it } from 'vitest'

import { createI18n } from '#/i18n'
import type { HostTool } from '#/lib/api'
import { toolEntry, type Probe } from '#/server/hostTools'

import { hostToolText } from './hostToolText'

const en = createI18n('en').t
const es = createI18n('es').t

/** A tool as the server writes it, from the probe the board's own check would make. */
const entry = (name: Parameters<typeof toolEntry>[0], probe: Probe, extra = {}) =>
  toolEntry(name, probe, {
    env: { HOME: '/home/x' },
    platform: 'linux',
    claudeBin: 'claude',
    ...extra,
  }) as HostTool

const MISSING = ['git', 'gh', 'claude', 'node', 'pnpm'] as const

const SIGNED_OUT = { signedIn: false, authOutput: 'You are not logged into any GitHub hosts' }
// A folder gh would read its config from: there, a failed check is gh signed out.
const WITH_CONFIG = { env: { GH_CONFIG_DIR: os.tmpdir() } }

describe('the missing-tools banner follows the interface language', () => {
  it('writes every line in English as the server wrote it', () => {
    const tools: HostTool[] = [
      ...MISSING.map((n) => entry(n, { path: null })),
      entry('gh', {
        path: '/usr/bin/gh',
        version: '2.30.0',
        signedIn: false,
        authOutput: 'unknown flag: --active',
      }),
      entry('gh', { path: '/usr/bin/gh', version: '2.60.0', ...SIGNED_OUT }, WITH_CONFIG),
    ]
    for (const tool of tools) {
      const text = hostToolText(tool, en)
      expect(text, tool.name).toEqual({
        problem: tool.problem ?? '',
        breaks: tool.breaks,
        fix: tool.fix ?? '',
      })
    }
  })

  it('translates every line the server can write for a missing tool, and keeps the names and paths', () => {
    for (const name of MISSING) {
      const tool = entry(name, { path: null })
      const text = hostToolText(tool, es)
      expect(text.problem, name).not.toBe(tool.problem)
      expect(text.breaks, name).not.toBe(tool.breaks)
      expect(text.fix, name).not.toBe(tool.fix)
    }
    const claude = hostToolText(entry('claude', { path: null }, { claudeBin: '/opt/claude' }), es)
    expect(claude.problem).toBe('no se encontró claude: CLAUDE_BIN es /opt/claude')
    expect(hostToolText(entry('git', { path: null }), es).problem).toBe(
      'git no se encontró en el PATH del tablero',
    )
  })

  it('translates a gh that is signed out, too old, or has no config to read', () => {
    const signedOut = entry('gh', { path: '/usr/bin/gh', version: '2.60.0', ...SIGNED_OUT }, WITH_CONFIG)
    expect(hostToolText(signedOut, es)).toMatchObject({ problem: 'gh no tiene la sesión iniciada' })
    expect(hostToolText(signedOut, es).fix).toBe(
      'ejecuta gh auth login en esta máquina, luego pulsa Comprobar de nuevo',
    )
    const tooOld = entry('gh', {
      path: '/usr/bin/gh',
      version: '2.30.0',
      signedIn: false,
      authOutput: 'unknown flag: --active',
    })
    expect(tooOld.problem).toMatch(/too old/)
    expect(hostToolText(tooOld, es).problem).toBe(
      'gh 2.30.0 es demasiado antiguo para esta comprobación: no conoce --active',
    )
    expect(hostToolText(tooOld, es).breaks).toBe(
      'la comprobación del tablero de que gh tiene la sesión iniciada',
    )
    const noConfig = entry('gh', { path: '/usr/bin/gh', ...SIGNED_OUT }, { env: {} })
    expect(noConfig.problem).toMatch(/^gh cannot find its config/)
    expect(hostToolText(noConfig, es).problem).toMatch(/^gh no encuentra su configuración/)
    expect(hostToolText(noConfig, es).fix).toMatch(/^inicia el tablero con HOME/)
  })

  it('shows a line it does not know as the server wrote it', () => {
    const odd: HostTool = {
      ...entry('git', { path: null }),
      problem: 'something new',
      breaks: 'a new thing',
      fix: 'do it',
    }
    expect(hostToolText(odd, es)).toEqual({ problem: 'something new', breaks: 'a new thing', fix: 'do it' })
  })
})
