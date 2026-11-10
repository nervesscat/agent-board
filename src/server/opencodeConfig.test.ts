import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_SUBAGENT_DEPTH,
  checkOpencodeConfig,
  deprecatedDepth,
  experimentalDepth,
  globalConfigFiles,
  hasExperimentalBlock,
  opencodeConfig,
  parseJsonc,
  readOpencodeConfig,
  readyOpencodeConfig,
  setOpencodeConfig,
  validDepth,
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
  it('reads a whole depth from the experimental block or the deprecated key', () => {
    expect(validDepth(2)).toBe(2)
    expect(validDepth(0)).toBe(0)
    expect(validDepth(-1)).toBeNull()
    expect(validDepth(1.5)).toBeNull()
    expect(validDepth('2')).toBeNull()
    expect(experimentalDepth({ experimental: { subagent_depth: 2 } })).toBe(2)
    expect(experimentalDepth({ experimental: { todo: true } })).toBeNull()
    expect(experimentalDepth({ subagent_depth: 3 })).toBeNull()
    expect(deprecatedDepth({ subagent_depth: 3 })).toBe(3)
    expect(deprecatedDepth({ experimental: { subagent_depth: 2 } })).toBeNull()
  })

  it('knows a document with an experimental block, even an empty or null one', () => {
    expect(hasExperimentalBlock({ experimental: { subagent_depth: 2 } })).toBe(true)
    expect(hasExperimentalBlock({ experimental: {} })).toBe(true)
    expect(hasExperimentalBlock({ experimental: null })).toBe(true)
    expect(hasExperimentalBlock({ experimental: false })).toBe(false)
    expect(hasExperimentalBlock({ subagent_depth: 3 })).toBe(false)
    expect(hasExperimentalBlock(null)).toBe(false)
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

  it('reads the deprecated top-level key when no document has an experimental block', () => {
    const { env, file } = globalConfig('{ "subagent_depth": 3 }')
    expect(readOpencodeConfig({ env, projectDirs: [] })).toMatchObject({
      depth: 3,
      set: true,
      source: file,
    })
  })

  it('takes the last experimental block, as OpenCode does, not the highest', () => {
    const { env } = globalConfig(depthConfig(2))
    // A later project document with a lower depth overrides the global one.
    const lower = projectConfig(depthConfig(1))
    expect(readOpencodeConfig({ env, projectDirs: [lower.dir] })).toMatchObject({
      depth: 1,
      set: false,
      source: lower.file,
    })

    // A later document with an experimental block but no depth turns delegation off.
    const noDepth = projectConfig(JSON.stringify({ experimental: { todo: true } }))
    expect(readOpencodeConfig({ env, projectDirs: [noDepth.dir] })).toMatchObject({
      depth: DEFAULT_SUBAGENT_DEPTH,
      set: false,
      source: noDepth.file,
    })

    // And a higher later one still wins: the last block, not the highest.
    const higher = projectConfig(depthConfig(3), '.opencode/opencode.jsonc')
    expect(readOpencodeConfig({ env, projectDirs: [higher.dir] })).toMatchObject({
      depth: 3,
      set: true,
      source: higher.file,
    })
  })

  it('follows the merge order: json then jsonc, root then .opencode', () => {
    const { env } = globalConfig(depthConfig(2))
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'opencode.json'), depthConfig(2))
    fs.writeFileSync(path.join(dir, 'opencode.jsonc'), depthConfig(3))
    expect(readOpencodeConfig({ env, projectDirs: [dir] })).toMatchObject({
      depth: 3,
      source: path.join(dir, 'opencode.jsonc'),
    })

    // The .opencode document comes after the root ones whatever their names.
    fs.mkdirSync(path.join(dir, '.opencode'))
    fs.writeFileSync(path.join(dir, '.opencode', 'opencode.json'), depthConfig(1))
    expect(readOpencodeConfig({ env, projectDirs: [dir] })).toMatchObject({
      depth: 1,
      source: path.join(dir, '.opencode', 'opencode.json'),
    })
  })

  it('does not use the deprecated key when any document defines an experimental block', () => {
    // The block in the global document wins over a later project's deprecated key: OpenCode ignores it.
    const global = globalConfig(JSON.stringify({ experimental: { todo: true } }))
    const project = projectConfig('{ "subagent_depth": 3 }')
    expect(readOpencodeConfig({ env: global.env, projectDirs: [project.dir] })).toMatchObject({
      depth: 1,
      set: false,
      source: global.file,
    })

    // Even in the same document, the block (with no depth) is what OpenCode reads.
    const both = projectConfig(JSON.stringify({ experimental: { todo: true }, subagent_depth: 3 }))
    expect(readOpencodeConfig({ env: global.env, projectDirs: [both.dir] })).toMatchObject({
      depth: 1,
      source: both.file,
    })
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
