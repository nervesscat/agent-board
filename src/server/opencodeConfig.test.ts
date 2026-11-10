import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_SUBAGENT_DEPTH,
  checkOpencodeConfig,
  globalConfigFiles,
  opencodeConfig,
  parseJsonc,
  readOpencodeConfig,
  readyOpencodeConfig,
  setOpencodeConfig,
  subagentDepth,
} from './opencodeConfig'

// Each test reads a config of its own: XDG_CONFIG_HOME under a throwaway folder, project dirs as given.
const dirs: string[] = []
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-opencode-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  setOpencodeConfig(null)
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** An XDG config folder holding `opencode/opencode.json` (or `.jsonc` when `jsonc`) with `body`. */
function globalConfig(body: string, jsonc = false) {
  const configHome = tmp()
  const dir = path.join(configHome, 'opencode')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, jsonc ? 'opencode.jsonc' : 'opencode.json')
  fs.writeFileSync(file, body)
  const env = { ...process.env, XDG_CONFIG_HOME: configHome }
  return { configHome, env, file }
}

/** A project checkout with one of OpenCode's config files. */
function projectConfig(body: string, at = 'opencode.json') {
  const dir = tmp()
  fs.mkdirSync(path.dirname(path.join(dir, at)), { recursive: true })
  fs.writeFileSync(path.join(dir, at), body)
  return { dir, file: path.join(dir, at) }
}

const depthConfig = (depth: number) => JSON.stringify({ experimental: { subagent_depth: depth } })

describe('the config files', () => {
  it('reads the global folder from XDG_CONFIG_HOME, json then jsonc', () => {
    const { configHome, env } = globalConfig('{}')
    expect(globalConfigFiles(env)).toEqual([
      path.join(configHome, 'opencode', 'opencode.json'),
      path.join(configHome, 'opencode', 'opencode.jsonc'),
    ])
  })
})

describe('the depth a config sets', () => {
  it('takes experimental.subagent_depth, else the deprecated top-level key', () => {
    expect(subagentDepth({ experimental: { subagent_depth: 2 } })).toBe(2)
    expect(subagentDepth({ subagent_depth: 3 })).toBe(3)
    // The current key wins over the deprecated one in the same file.
    expect(subagentDepth({ experimental: { subagent_depth: 2 }, subagent_depth: 4 })).toBe(2)
    expect(subagentDepth({ experimental: { subagent_depth: 0 } })).toBeNull()
    expect(subagentDepth({ experimental: { subagent_depth: '2' } })).toBeNull()
    expect(subagentDepth({ experimental: { subagent_depth: 1.5 } })).toBeNull()
    expect(subagentDepth({})).toBeNull()
    expect(subagentDepth(null)).toBeNull()
  })
})

describe('parseJsonc', () => {
  it('drops line and block comments and trailing commas, never touching a string', () => {
    const text = `{
      // the current key
      "experimental": { "subagent_depth": 2, },
      /* the deprecated one:
         "subagent_depth": 4 */
      "note": "a,} // not a comment", // after a string
    }`
    expect(parseJsonc(text)).toEqual({
      experimental: { subagent_depth: 2 },
      note: 'a,} // not a comment',
    })
  })

  it('rejects what is not JSON, as JSON.parse does', () => {
    expect(() => parseJsonc('{ "experimental": ')).toThrow()
  })
})

describe('reading the effective depth', () => {
  it('is 1 when no config exists, and names the global file to add it to', () => {
    const { env, file } = globalConfig('{}')
    fs.rmSync(file)
    const r = readOpencodeConfig({ env, projectDirs: [tmp()] })
    expect(r).toMatchObject({ depth: DEFAULT_SUBAGENT_DEPTH, set: false, source: file, error: null })
    expect(Date.parse(r.checkedAt)).not.toBeNaN()
  })

  it('reads jsonc with comments and trailing commas, from the file it came from', () => {
    const { env, file } = globalConfig(
      `{
        // OpenCode's config may carry comments
        "experimental": { "subagent_depth": 2 },
      }`,
      true,
    )
    const r = readOpencodeConfig({ env, projectDirs: [] })
    expect(r).toMatchObject({ depth: 2, set: true, source: file, error: null })
  })

  it('reads the deprecated top-level key', () => {
    const { env, file } = globalConfig('{ "subagent_depth": 3 }')
    expect(readOpencodeConfig({ env, projectDirs: [] })).toMatchObject({
      depth: 3,
      set: true,
      source: file,
    })
  })

  it('lets a project config override the global one, and never lowers the depth', () => {
    const { env, file: globalFile } = globalConfig(depthConfig(2))
    const project = projectConfig(depthConfig(3), '.opencode/opencode.jsonc')
    const r = readOpencodeConfig({ env, projectDirs: [project.dir] })
    expect(r).toMatchObject({ depth: 3, set: true, source: project.file })

    // A project that sets 1 does not turn off what the global config turns on; the highest wins.
    const lower = projectConfig(depthConfig(1))
    const high = readOpencodeConfig({ env, projectDirs: [lower.dir] })
    expect(high).toMatchObject({ depth: 2, set: true, source: globalFile })
  })

  it('names the config file it read even when it sets no depth', () => {
    const { env, file } = globalConfig('{ "theme": "system" }', true)
    expect(readOpencodeConfig({ env, projectDirs: [] })).toMatchObject({
      depth: 1,
      set: false,
      source: file,
    })
  })

  it('reports a malformed file instead of crashing, and keeps the other files', () => {
    const { env, file } = globalConfig('{ "experimental": ')
    const project = projectConfig(depthConfig(2))
    const r = readOpencodeConfig({ env, projectDirs: [project.dir] })
    expect(r.depth).toBe(2)
    expect(r.set).toBe(true)
    expect(r.source).toBe(project.file)
    expect(r.error).toContain(`Could not parse ${file}`)

    // Nothing readable at all: depth 1, the global file named, and the error still said.
    const broken = readOpencodeConfig({ env, projectDirs: [] })
    expect(broken).toMatchObject({ depth: 1, set: false, source: file })
    expect(broken.error).toContain(`Could not parse ${file}`)
  })

  it('reports a config it cannot open as a file', () => {
    const { env } = globalConfig('{}')
    const dir = path.join(env.XDG_CONFIG_HOME!, 'opencode', 'opencode.jsonc')
    fs.mkdirSync(dir, { recursive: true })
    const r = readOpencodeConfig({ env, projectDirs: [] })
    expect(r.error).toContain(`Could not read ${dir}`)
  })
})

describe('the last check', () => {
  it('keeps what it read until checked again', () => {
    const { configHome, file } = globalConfig(depthConfig(2))
    const previous = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = configHome
    try {
      const first = checkOpencodeConfig([])
      expect(first).toMatchObject({ depth: 2, set: true, source: file })
      expect(opencodeConfig()).toEqual(first)
      // Ready reuses the kept result rather than reading again.
      expect(readyOpencodeConfig([])).toEqual(first)
      setOpencodeConfig(null)
      expect(opencodeConfig()).toBeNull()
      expect(readyOpencodeConfig([]).checkedAt >= first.checkedAt).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous
    }
  })
})
