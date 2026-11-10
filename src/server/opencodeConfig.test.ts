import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_SUBAGENT_DEPTH,
  ancestorDirs,
  checkOpencodeConfig,
  experimentalDepth,
  globalConfigFiles,
  hasDeprecatedKey,
  hasExperimentalBlock,
  opencodeConfig,
  parseJsonc,
  projectConfigFiles,
  readOpencodeConfig,
  type ReadOptions,
  readyOpencodeConfig,
  setOpencodeConfig,
  systemConfigDir,
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
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: configHome }
  // The machine's own $OPENCODE_CONFIG would otherwise join every test's documents.
  delete env.OPENCODE_CONFIG
  return { configHome, env, file }
}

/** A config directory that is not there: the system-wide one, unless a test makes its own. */
const missingSystem = () => path.join(tmp(), 'system')

/** Reads a config with the machine's own system dir out of the way. */
const read = (opts: ReadOptions = {}) => readOpencodeConfig({ systemDir: missingSystem(), ...opts })

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
  })

  it('knows a document with an experimental block, even an empty or null one', () => {
    expect(hasExperimentalBlock({ experimental: { subagent_depth: 2 } })).toBe(true)
    expect(hasExperimentalBlock({ experimental: {} })).toBe(true)
    expect(hasExperimentalBlock({ experimental: null })).toBe(true)
    expect(hasExperimentalBlock({ experimental: false })).toBe(false)
    expect(hasExperimentalBlock({ subagent_depth: 3 })).toBe(false)
    expect(hasExperimentalBlock(null)).toBe(false)
  })

  it('knows a document that still sets the deprecated top-level key', () => {
    expect(hasDeprecatedKey({ subagent_depth: 3 })).toBe(true)
    expect(hasDeprecatedKey({ subagent_depth: 'three' })).toBe(true)
    expect(hasDeprecatedKey({ experimental: { subagent_depth: 2 } })).toBe(false)
    expect(hasDeprecatedKey(null)).toBe(false)
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
    const r = read({ env, projectDirs: [tmp()] })
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
    const r = read({ env, projectDirs: [] })
    expect(r).toMatchObject({ depth: 2, set: true, source: file, error: null })
  })

  it('ignores the deprecated top-level key, and names the document that still sets it', () => {
    const { env, file } = globalConfig('{ "subagent_depth": 3 }')
    expect(read({ env, projectDirs: [] })).toMatchObject({
      depth: 1,
      set: false,
      source: file,
      ignoredDeprecated: file,
    })
  })

  it('takes the last experimental block, as OpenCode does, not the highest', () => {
    const { env } = globalConfig(depthConfig(2))
    // A later project document with a lower depth overrides the global one.
    const lower = projectConfig(depthConfig(1))
    expect(read({ env, projectDirs: [lower.dir] })).toMatchObject({
      depth: 1,
      set: false,
      source: lower.file,
    })

    // A later document with an experimental block but no depth turns delegation off.
    const noDepth = projectConfig(JSON.stringify({ experimental: { todo: true } }))
    expect(read({ env, projectDirs: [noDepth.dir] })).toMatchObject({
      depth: DEFAULT_SUBAGENT_DEPTH,
      set: false,
      source: noDepth.file,
    })

    // And a higher later one still wins: the last block, not the highest.
    const higher = projectConfig(depthConfig(3), '.opencode/opencode.jsonc')
    expect(read({ env, projectDirs: [higher.dir] })).toMatchObject({
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
    expect(read({ env, projectDirs: [dir] })).toMatchObject({
      depth: 3,
      source: path.join(dir, 'opencode.jsonc'),
    })

    // The .opencode document comes after the root ones whatever their names.
    fs.mkdirSync(path.join(dir, '.opencode'))
    fs.writeFileSync(path.join(dir, '.opencode', 'opencode.json'), depthConfig(1))
    expect(read({ env, projectDirs: [dir] })).toMatchObject({
      depth: 1,
      source: path.join(dir, '.opencode', 'opencode.json'),
    })
  })

  it('ignores the deprecated key in a later document, and names it', () => {
    // The block in the global document decides; a later project's deprecated key has no effect.
    const global = globalConfig(depthConfig(2))
    const project = projectConfig('{ "subagent_depth": 1 }')
    expect(read({ env: global.env, projectDirs: [project.dir] })).toMatchObject({
      depth: 2,
      set: true,
      source: global.file,
      ignoredDeprecated: project.file,
    })

    // A block with no depth turns it off; the deprecated key in the same document changes nothing.
    const noDepth = globalConfig(JSON.stringify({ experimental: { todo: true } }))
    const both = projectConfig(JSON.stringify({ experimental: { todo: true }, subagent_depth: 3 }))
    expect(read({ env: noDepth.env, projectDirs: [both.dir] })).toMatchObject({
      depth: 1,
      set: false,
      source: both.file,
      ignoredDeprecated: both.file,
    })
  })

  it('names the config file it read even when it sets no depth', () => {
    const { env, file } = globalConfig('{ "theme": "system" }', true)
    expect(read({ env, projectDirs: [] })).toMatchObject({
      depth: 1,
      set: false,
      source: file,
    })
  })

  it('reports a malformed file instead of crashing, and keeps the other files', () => {
    const { env, file } = globalConfig('{ "experimental": ')
    const project = projectConfig(depthConfig(2))
    const r = read({ env, projectDirs: [project.dir] })
    expect(r.depth).toBe(2)
    expect(r.set).toBe(true)
    expect(r.source).toBe(project.file)
    expect(r.error).toContain(`Could not parse ${file}`)

    // Nothing readable at all: depth 1, the global file named, and the error still said.
    const broken = read({ env, projectDirs: [] })
    expect(broken).toMatchObject({ depth: 1, set: false, source: file })
    expect(broken.error).toContain(`Could not parse ${file}`)
  })

  it('reports a config it cannot open as a file', () => {
    const { env } = globalConfig('{}')
    const dir = path.join(env.XDG_CONFIG_HOME!, 'opencode', 'opencode.jsonc')
    fs.mkdirSync(dir, { recursive: true })
    const r = read({ env, projectDirs: [] })
    expect(r.error).toContain(`Could not read ${dir}`)
  })
})

describe('the system-wide config', () => {
  it('builds its path per platform, with the ProgramData fallback', () => {
    expect(systemConfigDir('win32', { ProgramData: 'D:\\Corp' })).toBe('D:\\Corp\\opencode')
    expect(systemConfigDir('win32', {})).toBe('C:\\ProgramData\\opencode')
    expect(systemConfigDir('win32', { PROGRAMDATA: 'E:\\Data' })).toBe('E:\\Data\\opencode')
    expect(systemConfigDir('darwin', {})).toBe('/Library/Application Support/opencode')
    expect(systemConfigDir('linux', {})).toBe('/etc/opencode')
    expect(systemConfigDir('freebsd', {})).toBe('/etc/opencode')
  })

  it('outranks project config, down and up', () => {
    const system = tmp()
    const systemJson = path.join(system, 'opencode.json')
    const systemJsonc = path.join(system, 'opencode.jsonc')
    const global = globalConfig(depthConfig(2))
    const project = projectConfig(depthConfig(3))
    const opts = { env: global.env, projectDirs: [project.dir], systemDir: system }

    fs.writeFileSync(systemJson, depthConfig(1))
    expect(readOpencodeConfig(opts)).toMatchObject({ depth: 1, set: false, source: systemJson })

    fs.writeFileSync(systemJsonc, depthConfig(4))
    expect(readOpencodeConfig(opts)).toMatchObject({ depth: 4, set: true, source: systemJsonc })

    // Even a system block without a depth wins: it is the last block OpenCode reads.
    fs.rmSync(systemJsonc)
    fs.writeFileSync(systemJson, JSON.stringify({ experimental: { todo: true } }))
    expect(readOpencodeConfig(opts)).toMatchObject({ depth: 1, set: false, source: systemJson })
  })

  it('is not an error when its folder is missing, or is a file', () => {
    const global = globalConfig(depthConfig(2))
    const missing = path.join(tmp(), 'missing')
    expect(readOpencodeConfig({ env: global.env, projectDirs: [], systemDir: missing })).toMatchObject({
      depth: 2,
      error: null,
    })

    const asFile = path.join(tmp(), 'system')
    fs.writeFileSync(asFile, 'not a folder')
    expect(readOpencodeConfig({ env: global.env, projectDirs: [], systemDir: asFile })).toMatchObject({
      depth: 2,
      error: null,
    })
  })
})

describe('$OPENCODE_CONFIG', () => {
  it('loads after the global config and before project configs', () => {
    const global = globalConfig(depthConfig(2))
    const explicit = path.join(tmp(), 'explicit.json')
    fs.writeFileSync(explicit, depthConfig(3))
    const project = projectConfig(depthConfig(1))
    const opts = { env: { ...global.env, OPENCODE_CONFIG: explicit }, projectDirs: [project.dir] }

    // The project document comes after the explicit file, so it wins.
    expect(read(opts)).toMatchObject({ depth: 1, source: project.file })
    fs.rmSync(project.file)
    // With no project change, the explicit file beats the global one.
    expect(read(opts)).toMatchObject({ depth: 3, source: explicit })
  })

  it('skips a file that is not there, without an error', () => {
    const global = globalConfig(depthConfig(2))
    expect(
      read({
        env: { ...global.env, OPENCODE_CONFIG: path.join(tmp(), 'nope.json') },
        projectDirs: [],
      }),
    ).toMatchObject({ depth: 2, source: global.file, error: null })
  })
})

describe('project configs up the tree', () => {
  it('reads farthest to closest, direct files then .opencode folders', () => {
    const root = tmp()
    const repo = path.join(root, 'a', 'b')
    fs.mkdirSync(repo, { recursive: true })
    const rootJson = path.join(root, 'opencode.json')
    const aJson = path.join(root, 'a', 'opencode.json')
    const repoJson = path.join(repo, 'opencode.json')
    const rootDot = path.join(root, '.opencode', 'opencode.json')
    const repoDot = path.join(repo, '.opencode', 'opencode.json')
    fs.writeFileSync(rootJson, depthConfig(5))
    fs.writeFileSync(aJson, depthConfig(6))
    fs.writeFileSync(repoJson, depthConfig(7))
    const env = globalConfig(depthConfig(2)).env
    expect(read({ env, projectDirs: [repo] })).toMatchObject({ depth: 7, source: repoJson })

    // Every .opencode folder is read after every direct file: a farther one wins over a closer direct file.
    fs.mkdirSync(path.dirname(rootDot), { recursive: true })
    fs.writeFileSync(rootDot, depthConfig(3))
    expect(read({ env, projectDirs: [repo] })).toMatchObject({ depth: 3, source: rootDot })

    // A closer .opencode folder wins over a farther one.
    fs.mkdirSync(path.dirname(repoDot), { recursive: true })
    fs.writeFileSync(repoDot, depthConfig(4))
    expect(read({ env, projectDirs: [repo] })).toMatchObject({ depth: 4, source: repoDot })

    // Direct files in one folder are read .json then .jsonc.
    const other = tmp()
    fs.writeFileSync(path.join(other, 'opencode.json'), depthConfig(1))
    fs.writeFileSync(path.join(other, 'opencode.jsonc'), depthConfig(9))
    expect(read({ env, projectDirs: [other] })).toMatchObject({
      depth: 9,
      source: path.join(other, 'opencode.jsonc'),
    })
  })

  it('orders the files the way OpenCode does', () => {
    const root = tmp()
    const repo = path.join(root, 'a', 'b')
    const files = projectConfigFiles(repo)
    const index = (file: string) => files.indexOf(file)
    const rootJson = index(path.join(root, 'opencode.json'))
    const aJson = index(path.join(root, 'a', 'opencode.json'))
    const repoJson = index(path.join(repo, 'opencode.json'))
    const rootDot = index(path.join(root, '.opencode', 'opencode.json'))
    const repoDot = index(path.join(repo, '.opencode', 'opencode.json'))
    for (const i of [rootJson, aJson, repoJson, rootDot, repoDot]) expect(i).toBeGreaterThanOrEqual(0)
    expect(rootJson).toBeLessThan(aJson)
    expect(aJson).toBeLessThan(repoJson)
    expect(repoJson).toBeLessThan(rootDot)
    expect(rootDot).toBeLessThan(repoDot)
    expect(ancestorDirs(repo).at(-1)).toBe(repo)
    expect(ancestorDirs(repo)[0]).toBe(path.parse(repo).root)
  })
})

describe('the last check', () => {
  it('keeps what it read until checked again', () => {
    const { env, file } = globalConfig(depthConfig(2))
    const options = { env, systemDir: missingSystem() }
    const first = checkOpencodeConfig([], options)
    expect(first).toMatchObject({ depth: 2, set: true, source: file })
    expect(opencodeConfig()).toEqual(first)
    // Ready reuses the kept result rather than reading again.
    expect(readyOpencodeConfig([], options)).toEqual(first)
    setOpencodeConfig(null)
    expect(opencodeConfig()).toBeNull()
    expect(readyOpencodeConfig([], options).checkedAt >= first.checkedAt).toBe(true)
  })
})
