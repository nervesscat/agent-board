import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ASSETS, REPO, ghCommands, parseArgs, releaseFiles, treeChanges } from './release.mjs'

const all = () => true

describe('releaseFiles', () => {
  it('publishes the Windows installer under its versioned and its stable name', () => {
    expect(releaseFiles('win32', '0.1.0', all)).toEqual({
      files: [
        {
          what: 'Windows installer',
          versioned: 'agent-board-setup-0.1.0.exe',
          stable: 'agent-board-setup-x64.exe',
        },
      ],
      missing: [],
    })
  })

  it('publishes every Linux package that was made, and needs the AppImage and the .deb', () => {
    const made = new Set(['agent-board-0.2.0-x86_64.AppImage', 'agent-board_0.2.0_amd64.deb'])
    const { files, missing } = releaseFiles('linux', '0.2.0', (f) => made.has(f))
    expect(files.map((f) => [f.versioned, f.stable])).toEqual([
      ['agent-board-0.2.0-x86_64.AppImage', 'agent-board-x86_64.AppImage'],
      ['agent-board_0.2.0_amd64.deb', 'agent-board_amd64.deb'],
    ])
    expect(missing).toEqual([])

    const all4 = releaseFiles('linux', '0.2.0', all).files.map((f) => f.stable)
    expect(all4).toEqual([
      'agent-board-x86_64.AppImage',
      'agent-board_amd64.deb',
      'agent-board.x86_64.rpm',
      'agent-board.pacman',
    ])
  })

  it('lists a required file that is missing, and leaves out an optional one', () => {
    expect(releaseFiles('linux', '1.0.0', () => false).missing).toEqual([
      'agent-board-1.0.0-x86_64.AppImage',
      'agent-board_1.0.0_amd64.deb',
    ])
    expect(releaseFiles('win32', '1.0.0', () => false).missing).toEqual(['agent-board-setup-1.0.0.exe'])
  })

  it('refuses a platform the app is not packaged on', () => {
    expect(() => releaseFiles('darwin', '0.1.0', all)).toThrow(/Windows or Linux, not darwin/)
  })

  it('names no stable file twice, and none with a version in it', () => {
    const stable = Object.values(ASSETS)
      .flat()
      .map((a) => a.stable)
    expect(new Set(stable).size).toBe(stable.length)
    for (const name of stable) expect(name).not.toMatch(/\d+\.\d+\.\d+/)
  })

  it('uses the stable names the release workflow and docs/releasing.md use', () => {
    const workflow = fs.readFileSync(path.resolve('.github/workflows/release.yml'), 'utf8')
    const docs = fs.readFileSync(path.resolve('docs/releasing.md'), 'utf8')
    for (const a of Object.values(ASSETS).flat()) {
      expect(workflow).toContain(a.stable)
      expect(docs).toContain(`https://github.com/${REPO}/releases/latest/download/${a.stable}`)
    }
  })
})

describe('ghCommands', () => {
  const base = { tag: 'v0.1.0', version: '0.1.0', sha: 'abc123', uploads: ['a.exe', 'b.exe'] }

  it('creates the release at the commit when it does not exist yet', () => {
    expect(ghCommands({ ...base, exists: false })).toEqual([
      [
        'release',
        'create',
        'v0.1.0',
        'a.exe',
        'b.exe',
        '--repo',
        REPO,
        '--target',
        'abc123',
        '--title',
        'CrossBoard 0.1.0',
        '--generate-notes',
      ],
    ])
  })

  it('creates a version with a suffix as a pre-release, and only that', () => {
    const [create] = ghCommands({ ...base, tag: 'v0.2.0-beta.1', version: '0.2.0-beta.1', exists: false })
    expect(create.at(-1)).toBe('--prerelease')
    expect(create).toContain('CrossBoard 0.2.0-beta.1')
    expect(ghCommands({ ...base, exists: false })[0]).not.toContain('--prerelease')
    expect(
      ghCommands({ ...base, tag: 'v0.2.0-beta.1', version: '0.2.0-beta.1', exists: true })[0],
    ).not.toContain('--prerelease')
  })

  it('makes the release workflow publish a version with a suffix as a pre-release too', () => {
    const workflow = fs.readFileSync(path.resolve('.github/workflows/release.yml'), 'utf8')
    expect(workflow).toMatch(/"\$VERSION" == \*-\* \]\]; then prerelease=\(--prerelease\)/)
    expect(workflow).toMatch(/gh release create .*"\$\{prerelease\[@\]\}"/)
  })

  it('adds to an existing release, replacing files of the same name', () => {
    expect(ghCommands({ ...base, exists: true })).toEqual([
      ['release', 'upload', 'v0.1.0', 'a.exe', 'b.exe', '--clobber', '--repo', REPO],
    ])
  })
})

describe('parseArgs', () => {
  it('reads the flags and refuses others', () => {
    expect(parseArgs(['--dry-run', '--skip-build'])).toMatchObject({
      dryRun: true,
      skipBuild: true,
      stageOnly: false,
      force: false,
    })
    expect(() => parseArgs(['--publish'])).toThrow(/unknown argument --publish/)
  })
})

describe('treeChanges', () => {
  let dir = ''
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  /** A repo with core.autocrlf, as on Windows: a file committed from CRLF is stored with LF. */
  function repo() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-tree-'))
    const git = (/** @type {string[]} */ ...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
    git('init', '-q')
    git('config', 'core.autocrlf', 'true')
    git('config', 'user.name', 't')
    git('config', 'user.email', 't@t')
    git('config', 'commit.gpgsign', 'false')
    fs.writeFileSync(path.join(dir, 'routeTree.gen.ts'), 'a\r\nb\r\n')
    fs.writeFileSync(path.join(dir, 'other.ts'), 'x\r\n')
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    return git
  }
  const status = (/** @type {(...a: string[]) => Buffer} */ git) =>
    git('status', '--porcelain').toString().split('\n').filter(Boolean)

  it('puts back a file whose only change is its line endings, and calls the tree clean', () => {
    const git = repo()
    // What the build does: the same content, written with LF.
    fs.writeFileSync(path.join(dir, 'routeTree.gen.ts'), 'a\nb\n')
    expect(status(git)).toEqual([' M routeTree.gen.ts'])

    // --dry-run: not counted as a change, and left as it is.
    expect(treeChanges(dir, { keep: true })).toEqual({ ok: true, changes: [], eolOnly: ['routeTree.gen.ts'] })
    expect(status(git)).toEqual([' M routeTree.gen.ts'])

    expect(treeChanges(dir)).toEqual({ ok: true, changes: [], eolOnly: ['routeTree.gen.ts'] })
    expect(status(git)).toEqual([])
    expect(treeChanges(dir)).toEqual({ ok: true, changes: [], eolOnly: [] })
  })

  it('still reports, and keeps, a real change', () => {
    const git = repo()
    fs.writeFileSync(path.join(dir, 'routeTree.gen.ts'), 'a\nc\n')
    fs.writeFileSync(path.join(dir, 'other.ts'), 'x\n')
    fs.writeFileSync(path.join(dir, 'new.ts'), 'n\n')

    expect(treeChanges(dir)).toEqual({
      ok: true,
      changes: [' M routeTree.gen.ts', '?? new.ts'],
      eolOnly: ['other.ts'],
    })
    expect(fs.readFileSync(path.join(dir, 'routeTree.gen.ts'), 'utf8')).toBe('a\nc\n')
    expect(status(git)).toEqual([' M routeTree.gen.ts', '?? new.ts'])
  })

  it('says when git status fails', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-tree-'))
    expect(treeChanges(path.join(dir, 'missing'))).toMatchObject({ ok: false })
  })
})
