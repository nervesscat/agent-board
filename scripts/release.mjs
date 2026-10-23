#!/usr/bin/env node
// Publishes the desktop app's installers to a GitHub Release from this machine, with or without
// GitHub Actions (docs/releasing.md):
//
//   pnpm release --dry-run      # what it would build, copy and upload, and the gh commands; changes nothing
//   pnpm release                # pnpm desktop:package, then create the release v<version> or add to it
//   pnpm release --skip-build   # the same with the installers already in desktop/dist
//   pnpm release --stage-only   # build and copy to desktop/dist/release only (the release workflow's step)
//
// It packages for the platform it runs on (the Windows installer on Windows, the Linux packages on
// Linux), copies each file to desktop/dist/release under its versioned name and under a stable,
// versionless one, so https://github.com/nervesscat/agent-board/releases/latest/download/<stable name>
// always reaches the newest, and uploads both. The tag is v<version> of desktop/app/package.json, at
// the commit checked out here, which must be clean and on origin. The release is created by the first
// run (whichever platform), and the next run on the other platform uploads to the same release
// (`gh release upload --clobber`). A tag already on origin at another commit is refused unless
// --force. `gh` must be signed in with write access to the repo.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = 'nervesscat/agent-board'

/**
 * Every file a platform's `pnpm desktop:package` makes, by its versioned name (desktop/package.mjs) and
 * the stable name it is also published under. The workflow (.github/workflows/release.yml) and
 * docs/releasing.md list the same stable names. An optional file is published when it was made.
 */
export const ASSETS = {
  win32: [
    {
      what: 'Windows installer',
      versioned: (v) => `agent-board-setup-${v}.exe`,
      stable: 'agent-board-setup-x64.exe',
      required: true,
    },
  ],
  linux: [
    {
      what: 'AppImage',
      versioned: (v) => `agent-board-${v}-x86_64.AppImage`,
      stable: 'agent-board-x86_64.AppImage',
      required: true,
    },
    {
      what: 'deb',
      versioned: (v) => `agent-board_${v}_amd64.deb`,
      stable: 'agent-board_amd64.deb',
      required: true,
    },
    {
      what: 'rpm',
      versioned: (v) => `agent-board-${v}.x86_64.rpm`,
      stable: 'agent-board.x86_64.rpm',
      required: false,
    },
    {
      what: 'pacman',
      versioned: (v) => `agent-board-${v}.pacman`,
      stable: 'agent-board.pacman',
      required: false,
    },
  ],
}

/**
 * The files to publish for a platform and version: each made file under both names. `exists` says
 * whether a versioned file is in the dist folder; a required one that is not is listed in `missing`.
 * @param {string} platform
 * @param {string} version
 * @param {(file: string) => boolean} exists
 */
export function releaseFiles(platform, version, exists) {
  const assets = ASSETS[/** @type {keyof typeof ASSETS} */ (platform)]
  if (!assets) throw new Error(`the app is packaged on Windows or Linux, not ${platform}`)
  const files = []
  const missing = []
  for (const a of assets) {
    const versioned = a.versioned(version)
    if (exists(versioned)) files.push({ what: a.what, versioned, stable: a.stable })
    else if (a.required) missing.push(versioned)
  }
  return { files, missing }
}

/**
 * The gh commands that publish `uploads` (file paths) to the release of `tag`: create it at `sha` when
 * it does not exist yet, else add to it, replacing files of the same name.
 * @param {{ tag: string, version: string, sha: string, exists: boolean, uploads: string[] }} o
 */
export function ghCommands({ tag, version, sha, exists, uploads }) {
  if (exists) return [['release', 'upload', tag, ...uploads, '--clobber', '--repo', REPO]]
  return [
    [
      'release',
      'create',
      tag,
      ...uploads,
      '--repo',
      REPO,
      '--target',
      sha,
      '--title',
      `CrossBoard ${version}`,
      '--generate-notes',
    ],
  ]
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const known = new Set(['--dry-run', '--skip-build', '--stage-only', '--force', '--help'])
  for (const a of argv) if (!known.has(a)) throw new Error(`unknown argument ${a}`)
  return {
    dryRun: argv.includes('--dry-run'),
    skipBuild: argv.includes('--skip-build'),
    stageOnly: argv.includes('--stage-only'),
    force: argv.includes('--force'),
    help: argv.includes('--help'),
  }
}

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`release: ${message}`)
  process.exit(1)
}

/** A shell-style line for a command, to print. @param {string} cmd @param {string[]} args */
const show = (cmd, args) => [cmd, ...args.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a))].join(' ')

/**
 * Runs a command and returns its output; with `inherit`, on this terminal.
 * @param {string} cmd @param {string[]} args @param {{ cwd: string, inherit?: boolean }} o
 */
function run(cmd, args, { cwd, inherit = false }) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe' })
  if (res.error) return { ok: false, out: '', err: res.error.message }
  return { ok: res.status === 0, out: (res.stdout ?? '').trim(), err: (res.stderr ?? '').trim() }
}

function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    fail(`${err instanceof Error ? err.message : err} (--help lists the flags)`)
  }
  if (opts.help) {
    console.log(
      'usage: pnpm release [--dry-run] [--skip-build] [--stage-only] [--force]\n' +
        '  --dry-run     print what it would build, copy and upload, and the gh commands; change nothing\n' +
        '  --skip-build  use the installers already in desktop/dist instead of running pnpm desktop:package\n' +
        '  --stage-only  build and copy to desktop/dist/release, publish nothing\n' +
        '  --force       upload even when the tag is already on origin at another commit',
    )
    return
  }

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const dist = path.join(root, 'desktop', 'dist')
  const out = path.join(dist, 'release')
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'app', 'package.json'), 'utf8'))
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? ''))
    fail(`desktop/app/package.json has no usable version (${version})`)
  const tag = `v${version}`
  if (!ASSETS[/** @type {keyof typeof ASSETS} */ (process.platform)])
    fail(`the app is packaged on Windows or Linux, not ${process.platform}`)
  const say = (/** @type {string} */ line) => console.log(opts.dryRun ? `[dry run] ${line}` : line)

  say(`release ${tag} (desktop/app/package.json ${version}) for ${process.platform}`)

  // What gets published: the commit checked out here, clean and on origin.
  const sha = run('git', ['rev-parse', 'HEAD'], { cwd: root }).out
  if (!opts.stageOnly) {
    const problems = []
    const dirty = run('git', ['status', '--porcelain'], { cwd: root })
    if (!dirty.ok) problems.push(`git status failed: ${dirty.err}`)
    else if (dirty.out) problems.push('the working tree has uncommitted changes')
    const onOrigin = run('git', ['branch', '-r', '--contains', sha], { cwd: root })
    if (!onOrigin.ok || !onOrigin.out)
      problems.push(`commit ${sha.slice(0, 7)} is not on origin (push it first)`)
    const remoteTag = run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], { cwd: root })
    const tagSha = remoteTag.out.split(/\s+/)[0]
    if (tagSha && tagSha !== sha && !opts.force)
      problems.push(
        `${tag} is on origin at ${tagSha.slice(0, 7)}, not ${sha.slice(0, 7)} (--force to upload anyway)`,
      )
    if (problems.length) {
      if (!opts.dryRun) fail(problems.join('; '))
      for (const p of problems) say(`would refuse: ${p}`)
    }
  }

  // 1. The installers.
  const build = [path.join(root, 'desktop', 'package.mjs')]
  if (opts.skipBuild) say('build: skipped, using desktop/dist as it is')
  else if (opts.dryRun) say(`build: ${show('node', ['desktop/package.mjs'])} (pnpm desktop:package)`)
  else if (!run(process.execPath, build, { cwd: root, inherit: true }).ok) fail('pnpm desktop:package failed')

  // 2. Each one under its versioned and its stable name, in desktop/dist/release.
  const exists = (/** @type {string} */ f) =>
    (opts.dryRun && !opts.skipBuild) || fs.existsSync(path.join(dist, f))
  const { files, missing } = releaseFiles(process.platform, version, exists)
  if (missing.length) {
    const message = `desktop/dist has no ${missing.join(', ')}`
    if (!opts.dryRun) fail(message)
    say(`would refuse: ${message}`)
  }
  if (!opts.dryRun) {
    fs.rmSync(out, { recursive: true, force: true })
    fs.mkdirSync(out, { recursive: true })
  }
  const uploads = []
  for (const f of files) {
    say(
      `${f.what}: ${f.versioned} -> desktop/dist/release/${f.versioned} and desktop/dist/release/${f.stable}`,
    )
    if (!opts.dryRun) {
      fs.copyFileSync(path.join(dist, f.versioned), path.join(out, f.versioned))
      fs.copyFileSync(path.join(dist, f.versioned), path.join(out, f.stable))
    }
    uploads.push(
      path.join('desktop', 'dist', 'release', f.versioned),
      path.join('desktop', 'dist', 'release', f.stable),
    )
  }
  if (opts.stageOnly) {
    say(`staged in ${out}; nothing published (--stage-only)`)
    return
  }

  // 3. The release: created by the first run, added to by the next.
  const view = run('gh', ['release', 'view', tag, '--repo', REPO, '--json', 'tagName'], { cwd: root })
  if (!view.ok && !/not found/i.test(view.err)) {
    if (!opts.dryRun) fail(`gh release view ${tag} failed: ${view.err || 'is gh installed and signed in?'}`)
    say(`could not ask GitHub about ${tag} (${view.err || 'gh failed'}); assuming it does not exist yet`)
  }
  const commands = ghCommands({ tag, version, sha, exists: view.ok, uploads })
  for (const args of commands) {
    say(`gh: ${show('gh', args)}`)
    if (!opts.dryRun && !run('gh', args, { cwd: root, inherit: true }).ok) fail(`${show('gh', args)} failed`)
  }
  if (opts.dryRun) {
    say('nothing was built, copied, tagged or uploaded')
    return
  }
  console.log(`\nhttps://github.com/${REPO}/releases/tag/${tag}`)
  for (const f of files) console.log(`  https://github.com/${REPO}/releases/latest/download/${f.stable}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
