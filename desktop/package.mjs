#!/usr/bin/env node
// Builds the Windows installer and the unpacked app: `pnpm desktop:package` (README: "The desktop app").
//
//   1. builds the board into desktop/.stage/board/.output (never .output, which previews use);
//   2. copies the migrations beside it (the server reads ./drizzle from its working folder);
//   3. swaps the staged better-sqlite3 binary for Electron's ABI, in the stage only: the repo's
//      node_modules keeps the Node build that vitest and `pnpm dev` load (pnpm hard-links it from its
//      store, so rebuilding it in place would reach every other checkout too);
//   4. checks the staged driver opens a database under Electron's Node;
//   5. packs desktop/app with the stage through electron-builder into desktop/dist:
//      agent-board-setup-<version>.exe (NSIS, per user) and win-unpacked/agent-board.exe.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'electron-builder'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const stage = path.join(root, 'desktop', '.stage', 'board')
const dist = path.join(root, 'desktop', 'dist')
const electronVersion = require('electron/package.json').version
// The electron package has no install script: requiring it is what fetches its binary when it is missing
// (a fresh install), and gives its path. The packed app is that same folder.
const electronExe = /** @type {string} */ (require('electron'))
const electronDist = path.dirname(electronExe)
const brand = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'app', 'package.json'), 'utf8'))

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`desktop:package: ${message}`)
  process.exit(1)
}

/** Runs a command to the end with its output on this terminal; fails the package on a non-zero exit. */
/**
 * @param {string} command
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptions} opts
 */
function run(command, args, opts = {}) {
  console.log(`> ${[command, ...args].join(' ')}`)
  const res = spawnSync(command, args, { stdio: 'inherit', ...opts })
  if (res.status !== 0) fail(`${command} exited with ${res.status ?? res.signal}`)
}

if (process.platform !== 'win32') fail('the installer is built on Windows (NSIS, x64)')

fs.rmSync(path.join(root, 'desktop', '.stage'), { recursive: true, force: true })
fs.rmSync(dist, { recursive: true, force: true })

// 1. The board, built into the stage.
run(
  process.execPath,
  [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'warn'],
  {
    cwd: root,
    env: { ...process.env, BOARD_BUILD_DIR: path.join(stage, '.output') },
  },
)

// 2. The migrations.
fs.cpSync(path.join(root, 'drizzle'), path.join(stage, 'drizzle'), { recursive: true })

// 3. better-sqlite3 for Electron's ABI. Nitro copied the package into the stage's server; its build
// folder goes first so nothing is written through to a file it may share with the repo's.
const driver = path.join(stage, '.output', 'server', 'node_modules', 'better-sqlite3')
if (!fs.existsSync(path.join(driver, 'package.json')))
  fail(`no better-sqlite3 in ${path.dirname(driver)}: the build no longer traces it there`)
fs.rmSync(path.join(driver, 'build'), { recursive: true, force: true })
const prebuildInstall = createRequire(
  fs.realpathSync(require.resolve('better-sqlite3/package.json')),
).resolve('prebuild-install/bin.js')
run(
  process.execPath,
  [prebuildInstall, '--runtime', 'electron', '--target', electronVersion, '--arch', 'x64', '--verbose'],
  { cwd: driver },
)

// 4. The staged driver loads under Electron's Node and opens a database; the repo's still loads under Node.
const probe = `const D = require(${JSON.stringify(driver)}); new D(':memory:').prepare('select 1').get(); console.log('better-sqlite3 for ABI ' + process.versions.modules)`
run(electronExe, ['-e', probe], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
run(
  process.execPath,
  [
    '-e',
    "new (require('better-sqlite3'))(':memory:'); console.log('repo better-sqlite3 for ABI ' + process.versions.modules)",
  ],
  {
    cwd: root,
  },
)

// 5. The installer and the unpacked app. electron-builder packs the app with the dependencies its
// package manager lists for it, and inside this repo pnpm lists the whole workspace's: the app is packed
// from a copy outside the repo, whose package.json has none. The board's own come traced in the stage.
const appCopy = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-desktop-'))
fs.cpSync(path.join(root, 'desktop', 'app'), appCopy, { recursive: true })
try {
  await build({
    projectDir: appCopy,
    win: ['nsis'],
    x64: true,
    publish: 'never',
    config: {
      appId: 'dev.agent-board.desktop',
      productName: brand.productName,
      executableName: 'agent-board',
      copyright: `Copyright © ${new Date().getFullYear()} ${brand.author}`,
      electronVersion,
      electronDist,
      directories: { output: dist },
      files: ['**/*'],
      extraResources: [{ from: stage, to: 'board', filter: ['**/*'] }],
      asar: true,
      npmRebuild: false,
      nodeGypRebuild: false,
      win: {
        icon: path.join(appCopy, 'icon.png'),
        artifactName: 'agent-board-setup-${version}.${ext}',
      },
      nsis: {
        oneClick: true,
        perMachine: false,
        runAfterFinish: true,
        shortcutName: brand.productName,
        uninstallDisplayName: brand.productName,
        // The board's data and settings (%LOCALAPPDATA%\agent-board) outlive an uninstall.
        deleteAppDataOnUninstall: false,
      },
    },
  })
} finally {
  fs.rmSync(appCopy, { recursive: true, force: true })
}

console.log(`\nInstaller: ${path.join(dist, `agent-board-setup-${brand.version}.exe`)}`)
console.log(`Unpacked:  ${path.join(dist, 'win-unpacked', 'agent-board.exe')}`)
