import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ASSETS,
  BUILD_OUTPUTS,
  METADATA,
  REPO,
  ghCommands,
  metadataProblems,
  parseArgs,
  parseMetadata,
  releaseFiles,
  remoteTagProblem,
  sha512File,
  treeChanges,
} from './release.mjs'

/** The checkout these tests run in. */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
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

  it('publishes the four Linux packages under their versioned and their stable names', () => {
    expect(releaseFiles('linux', '0.2.0', all)).toEqual({
      files: [
        {
          what: 'AppImage',
          versioned: 'agent-board-0.2.0-x86_64.AppImage',
          stable: 'agent-board-x86_64.AppImage',
        },
        { what: 'deb', versioned: 'agent-board_0.2.0_amd64.deb', stable: 'agent-board_amd64.deb' },
        { what: 'rpm', versioned: 'agent-board-0.2.0.x86_64.rpm', stable: 'agent-board.x86_64.rpm' },
        { what: 'pacman', versioned: 'agent-board-0.2.0.pacman', stable: 'agent-board.pacman' },
      ],
      missing: [],
    })
  })

  it('lists every package that is missing: each is required', () => {
    expect(releaseFiles('linux', '1.0.0', () => false)).toEqual({
      files: [],
      missing: [
        'agent-board-1.0.0-x86_64.AppImage',
        'agent-board_1.0.0_amd64.deb',
        'agent-board-1.0.0.x86_64.rpm',
        'agent-board-1.0.0.pacman',
      ],
    })
    const made = new Set(['agent-board-0.2.0-x86_64.AppImage', 'agent-board_0.2.0_amd64.deb'])
    expect(releaseFiles('linux', '0.2.0', (f) => made.has(f)).missing).toEqual([
      'agent-board-0.2.0.x86_64.rpm',
      'agent-board-0.2.0.pacman',
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

  it('expects the versioned names desktop/package.mjs checks it made', () => {
    // package.mjs ends by checking each file it made, by name: `agent-board-${v}-x86_64.AppImage` and
    // the like on Linux, `agent-board-setup-${brand.version}.exe` on Windows.
    const script = fs
      .readFileSync(path.join(repoRoot, 'desktop', 'package.mjs'), 'utf8')
      .replaceAll('${brand.version}', '${v}')
    for (const a of Object.values(ASSETS).flat()) expect(script).toContain('`' + a.versioned('${v}') + '`')
  })

  it('uses the stable names the release workflow and docs/releasing.md use', () => {
    const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8')
    const docs = fs.readFileSync(path.join(repoRoot, 'docs', 'releasing.md'), 'utf8')
    for (const a of Object.values(ASSETS).flat()) {
      expect(workflow).toContain(a.stable)
      expect(docs).toContain(`https://github.com/${REPO}/releases/latest/download/${a.stable}`)
    }
  })
})

// latest-linux.yml as electron-builder 26 writes it for the four Linux packages (desktop/package.mjs),
// with made-up hashes and sizes.
const linuxMetadata = (/** @type {Record<string, string>} */ sha, version = '0.2.0') =>
  [
    `version: ${version}`,
    'files:',
    ...[
      `agent-board-${version}-x86_64.AppImage`,
      `agent-board_${version}_amd64.deb`,
      `agent-board-${version}.x86_64.rpm`,
      `agent-board-${version}.pacman`,
    ].flatMap((url) => [`  - url: ${url}`, `    sha512: ${sha[url] ?? 'none'}`, '    size: 123']),
    `path: agent-board-${version}-x86_64.AppImage`,
    `sha512: ${sha[`agent-board-${version}-x86_64.AppImage`] ?? 'none'}`,
    "releaseDate: '2026-11-08T10:00:00.000Z'",
    '',
  ].join('\n')

describe('the update metadata', () => {
  const sha = (/** @type {string} */ f) => `sha-of-${f}==`
  const good = linuxMetadata(
    Object.fromEntries(releaseFiles('linux', '0.2.0', all).files.map((f) => [f.versioned, sha(f.versioned)])),
  )

  it('is latest.yml on Windows and latest-linux.yml on Linux', () => {
    expect(METADATA).toEqual({ win32: 'latest.yml', linux: 'latest-linux.yml' })
  })

  it('reads the version and each file with its sha512', () => {
    expect(parseMetadata(good)).toEqual({
      version: '0.2.0',
      files: [
        { url: 'agent-board-0.2.0-x86_64.AppImage', sha512: 'sha-of-agent-board-0.2.0-x86_64.AppImage==' },
        { url: 'agent-board_0.2.0_amd64.deb', sha512: 'sha-of-agent-board_0.2.0_amd64.deb==' },
        { url: 'agent-board-0.2.0.x86_64.rpm', sha512: 'sha-of-agent-board-0.2.0.x86_64.rpm==' },
        { url: 'agent-board-0.2.0.pacman', sha512: 'sha-of-agent-board-0.2.0.pacman==' },
      ],
    })
    expect(
      parseMetadata("version: '1.0.0'\r\nfiles:\r\n  - url: 'a b.exe'\r\n    sha512: \"x\"\r\n"),
    ).toEqual({
      version: '1.0.0',
      files: [{ url: 'a b.exe', sha512: 'x' }],
    })
  })

  it('accepts metadata listing every package with its own sha512, so each package type finds its file', () => {
    expect(metadataProblems(good, { platform: 'linux', version: '0.2.0', sha512Of: sha })).toEqual([])
    const win = 'version: 0.2.0\nfiles:\n  - url: agent-board-setup-0.2.0.exe\n    sha512: s==\n    size: 1\n'
    expect(metadataProblems(win, { platform: 'win32', version: '0.2.0', sha512Of: () => 's==' })).toEqual([])
  })

  it('refuses a hash that is not the file’s, a package left out, another file or another version', () => {
    expect(
      metadataProblems(good, {
        platform: 'linux',
        version: '0.2.0',
        sha512Of: (f) => (f.endsWith('.deb') ? 'rebuilt==' : sha(f)),
      }),
    ).toEqual(['latest-linux.yml has another sha512 for agent-board_0.2.0_amd64.deb than the file has'])
    const noPacman = good.replace(/ {2}- url: agent-board-0\.2\.0\.pacman\n.*\n.*\n/, '')
    expect(metadataProblems(noPacman, { platform: 'linux', version: '0.2.0', sha512Of: sha })).toEqual([
      'latest-linux.yml does not list agent-board-0.2.0.pacman',
    ])
    const extra = good.replace('files:\n', 'files:\n  - url: agent-board-0.2.0.snap\n    sha512: x\n')
    expect(metadataProblems(extra, { platform: 'linux', version: '0.2.0', sha512Of: sha })).toEqual([
      'latest-linux.yml lists agent-board-0.2.0.snap, which is not published',
    ])
    expect(metadataProblems(good, { platform: 'linux', version: '0.3.0', sha512Of: sha })[0]).toBe(
      'latest-linux.yml is for version 0.2.0, not 0.3.0',
    )
  })

  it('hashes a file as electron-updater checks it: sha512, base64', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-sha-'))
    try {
      fs.writeFileSync(path.join(dir, 'f'), 'abc')
      expect(sha512File(path.join(dir, 'f'))).toBe(
        '3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==',
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is uploaded by the release workflow with the packages, which it publishes on a v* tag or by hand only', () => {
    const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8')
    // Each build job stages desktop/dist/release (scripts/release.mjs --stage-only) and uploads all of it.
    for (const name of Object.values(METADATA))
      expect(workflow).toContain(`test -f desktop/dist/release/${name}`)
    expect(workflow).toContain('gh release create "$TAG" release/*')
    expect(workflow).toContain('gh release upload "$TAG" release/* --clobber')
    const on = /^on:\n((?: {2}.*\n)+)/m.exec(workflow)?.[1]
    expect(on).toBe("  push:\n    tags: ['v*']\n  workflow_dispatch:\n")
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
    const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8')
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

describe('treeChanges', { timeout: 30_000 }, () => {
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
    expect(treeChanges(dir, { keep: true })).toEqual({
      ok: true,
      changes: [],
      eolOnly: ['routeTree.gen.ts'],
      buildOutputs: [],
    })
    expect(status(git)).toEqual([' M routeTree.gen.ts'])

    expect(treeChanges(dir)).toEqual({
      ok: true,
      changes: [],
      eolOnly: ['routeTree.gen.ts'],
      buildOutputs: [],
    })
    expect(status(git)).toEqual([])
    expect(treeChanges(dir)).toEqual({ ok: true, changes: [], eolOnly: [], buildOutputs: [] })
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
      buildOutputs: [],
    })
    expect(fs.readFileSync(path.join(dir, 'routeTree.gen.ts'), 'utf8')).toBe('a\nc\n')
    expect(status(git)).toEqual([' M routeTree.gen.ts', '?? new.ts'])
  })

  it('reports an untracked file even where git status is set not to show untracked files', () => {
    const git = repo()
    git('config', 'status.showUntrackedFiles', 'no')
    fs.writeFileSync(path.join(dir, 'new.ts'), 'n\n')
    // Plain `git status` hides it here.
    expect(status(git)).toEqual([])

    expect(treeChanges(dir)).toEqual({ ok: true, changes: ['?? new.ts'], eolOnly: [], buildOutputs: [] })
    expect(fs.existsSync(path.join(dir, 'new.ts'))).toBe(true)
  })

  // What `vite build` appends to src/routeTree.gen.ts (the repo keeps it out of git).
  const footer = [
    '',
    "import type { getRouter } from './router.tsx'",
    "import type { startInstance } from './start.ts'",
    "declare module '@tanstack/react-start' {",
    '  interface Register {',
    '    ssr: true',
    '    router: Awaited<ReturnType<typeof getRouter>>',
    '    config: Awaited<ReturnType<typeof startInstance.getOptions>>',
    '  }',
    '}',
    '',
  ].join('\n')

  /**
   * The repo with the real src/routeTree.gen.ts committed, as this checkout's HEAD has it: not the
   * working copy, which a local build leaves with its Register block appended.
   */
  function repoWithRouteTree() {
    const git = repo()
    const routeTree = execFileSync('git', ['show', 'HEAD:src/routeTree.gen.ts'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    fs.mkdirSync(path.join(dir, 'src'))
    fs.writeFileSync(path.join(dir, 'src', 'routeTree.gen.ts'), routeTree)
    git('add', '.')
    git('commit', '-q', '-m', 'route tree')
    return { git, routeTree }
  }

  it('puts back the route tree after a build, whatever the build changed in it', () => {
    expect(BUILD_OUTPUTS).toEqual(['src/routeTree.gen.ts'])
    const { git, routeTree } = repoWithRouteTree()
    const file = path.join(dir, 'src', 'routeTree.gen.ts')
    // The build: the same tree, with LF, and its Register block at the end.
    fs.writeFileSync(file, routeTree.replace(/\r\n/g, '\n').trimEnd() + '\n' + footer)
    expect(() => git('diff', '--quiet', '--', 'src/routeTree.gen.ts')).toThrow()
    expect(status(git)).toEqual([' M src/routeTree.gen.ts'])

    // --dry-run: not counted as a change, and left as it is.
    expect(treeChanges(dir, { keep: true })).toEqual({
      ok: true,
      changes: [],
      eolOnly: [],
      buildOutputs: ['src/routeTree.gen.ts'],
    })
    expect(status(git)).toEqual([' M src/routeTree.gen.ts'])

    expect(treeChanges(dir)).toEqual({
      ok: true,
      changes: [],
      eolOnly: [],
      buildOutputs: ['src/routeTree.gen.ts'],
    })
    expect(status(git)).toEqual([])
    expect(fs.readFileSync(file, 'utf8')).not.toContain('interface Register')
    // The next run (a re-run, --skip-build) finds the tree clean.
    expect(treeChanges(dir)).toEqual({ ok: true, changes: [], eolOnly: [], buildOutputs: [] })
  })

  it('still refuses a content change to any other file beside the rebuilt route tree', () => {
    const { git, routeTree } = repoWithRouteTree()
    fs.writeFileSync(path.join(dir, 'src', 'routeTree.gen.ts'), routeTree + footer)
    fs.writeFileSync(path.join(dir, 'other.ts'), 'y\r\n')
    // A route tree at another path is not the build's.
    fs.writeFileSync(path.join(dir, 'routeTree.gen.ts'), 'a\nc\n')

    expect(treeChanges(dir)).toEqual({
      ok: true,
      changes: [' M other.ts', ' M routeTree.gen.ts'],
      eolOnly: [],
      buildOutputs: ['src/routeTree.gen.ts'],
    })
    expect(status(git)).toEqual([' M other.ts', ' M routeTree.gen.ts'])
  })

  it('keeps a staged change to the route tree as a change', () => {
    const { git, routeTree } = repoWithRouteTree()
    fs.writeFileSync(path.join(dir, 'src', 'routeTree.gen.ts'), routeTree + '// edited\n')
    git('add', 'src/routeTree.gen.ts')

    expect(treeChanges(dir)).toMatchObject({
      ok: true,
      changes: ['M  src/routeTree.gen.ts'],
      buildOutputs: [],
    })
    expect(status(git)).toEqual(['M  src/routeTree.gen.ts'])
  })

  it('says when git status fails', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-tree-'))
    expect(treeChanges(path.join(dir, 'missing'))).toMatchObject({ ok: false })
  })
})

describe('remoteTagProblem', { timeout: 30_000 }, () => {
  let dir = ''
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  /** A clone of a bare origin, with two commits pushed: returns git in the clone and both shas. */
  function cloned() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-tag-'))
    const origin = path.join(dir, 'origin.git')
    const work = path.join(dir, 'work')
    execFileSync('git', ['init', '-q', '--bare', origin], { stdio: 'pipe' })
    execFileSync('git', ['init', '-q', work], { stdio: 'pipe' })
    const git = (/** @type {string[]} */ ...args) =>
      execFileSync('git', args, { cwd: work, stdio: 'pipe', encoding: 'utf8' }).trim()
    for (const [k, v] of [
      ['user.name', 't'],
      ['user.email', 't@t'],
      ['commit.gpgsign', 'false'],
      ['tag.gpgsign', 'false'],
    ])
      git('config', k, v)
    git('remote', 'add', 'origin', origin)
    git('commit', '-q', '--allow-empty', '-m', 'one')
    const first = git('rev-parse', 'HEAD')
    git('commit', '-q', '--allow-empty', '-m', 'two')
    const head = git('rev-parse', 'HEAD')
    git('push', '-q', 'origin', 'HEAD:refs/heads/main')
    return { git, work, first, head }
  }

  it('passes when the tag is not on origin, or is there at the commit', () => {
    const { git, work, head } = cloned()
    expect(remoteTagProblem(work, { tag: 'v0.1.0', sha: head })).toBeNull()
    git('tag', 'v0.1.0')
    git('push', '-q', 'origin', 'v0.1.0')
    expect(remoteTagProblem(work, { tag: 'v0.1.0', sha: head })).toBeNull()
  })

  it('refuses a lightweight tag on origin at another commit, unless forced', () => {
    const { git, work, first, head } = cloned()
    git('tag', 'v0.1.0', first)
    git('push', '-q', 'origin', 'v0.1.0')
    expect(remoteTagProblem(work, { tag: 'v0.1.0', sha: head })).toBe(
      `v0.1.0 is on origin at ${first.slice(0, 7)}, not ${head.slice(0, 7)} (--force to upload anyway)`,
    )
    expect(remoteTagProblem(work, { tag: 'v0.1.0', sha: head, force: true })).toBeNull()
  })

  it('compares an annotated tag by the commit it points to, not its own id', () => {
    const { git, work, first, head } = cloned()
    git('tag', '-a', 'v0.1.0', '-m', 'v0.1.0')
    git('tag', '-a', 'v0.2.0', '-m', 'v0.2.0', first)
    git('push', '-q', 'origin', 'v0.1.0', 'v0.2.0')
    // origin lists the tag object, which is not the commit.
    expect(git('ls-remote', 'origin', 'refs/tags/v0.1.0').split(/\s+/)[0]).not.toBe(head)

    expect(remoteTagProblem(work, { tag: 'v0.1.0', sha: head })).toBeNull()
    expect(remoteTagProblem(work, { tag: 'v0.2.0', sha: head })).toBe(
      `v0.2.0 is on origin at ${first.slice(0, 7)}, not ${head.slice(0, 7)} (--force to upload anyway)`,
    )
  })

  it('refuses when origin cannot be asked, forced or not', () => {
    const { git, work, head } = cloned()
    git('remote', 'set-url', 'origin', path.join(dir, 'nope.git'))
    for (const force of [false, true]) {
      expect(remoteTagProblem(work, { tag: 'v0.1.0', sha: head, force })).toMatch(
        /^git ls-remote origin failed, so v0\.1\.0 on origin could not be checked: [^\n]+$/,
      )
    }
  })
})
