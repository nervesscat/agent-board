#!/usr/bin/env node
// Builds the installer(s) and the unpacked app for the platform it runs on: `pnpm desktop:package`
// (README: "The desktop app"). x64 only (`--arch x64` or `--arch=x64`, the default; anything else is refused).
//
//   1. builds the board into desktop/.stage/board/.output (never .output, which previews use);
//   2. copies the migrations beside it (the server reads ./drizzle from its working folder);
//   3. swaps the staged better-sqlite3 binary for Electron's ABI, in the stage only: the repo's
//      node_modules keeps the Node build that vitest and `pnpm dev` load (pnpm hard-links it from its
//      store, so rebuilding it in place would reach every other checkout too);
//   4. checks the staged driver opens a database under Electron's Node;
//   5. packs desktop/app with the stage through electron-builder into desktop/dist:
//      on Windows agent-board-setup-<version>.exe (NSIS, per user) and win-unpacked/agent-board.exe;
//      on Linux agent-board-<version>-x86_64.AppImage, agent-board_<version>_amd64.deb,
//      agent-board-<version>.x86_64.rpm, agent-board-<version>-x86_64.pacman (rpmbuild and bsdtar
//      on PATH) and linux-unpacked/agent-board; beside them the metadata electron-updater reads to update
//      the installed app (latest.yml on Windows, latest-linux.yml on Linux: each package with its
//      sha512), and in the packed app's resources app-update.yml, which points it at the repo's GitHub
//      Releases. The packed app carries the main process's own dependencies (electron-updater).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'electron-builder'

import { appDependencies, appUpdateConfigProblem, packageArch, PUBLISH } from './packageArgs.mjs'

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
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

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

const WIN = process.platform === 'win32'
if (!WIN && process.platform !== 'linux')
  fail(`the app is packaged on Windows or Linux, not ${process.platform}`)
/** @type {string[]} */
let appDeps = []
try {
  appDeps = appDependencies(brand, rootPkg)
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}
const arch = packageArch(process.argv.slice(2))
// The driver's probe (step 4) runs the staged binary under this machine's Electron, so the packed arch
// is this machine's; arm64 is not built (README: "The desktop app").
if (arch !== 'x64') fail(`only x64 is packaged, not "${arch}"`)
if (process.arch !== 'x64') fail(`this machine is ${process.arch}; the app is packaged on x64 only`)

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
  [prebuildInstall, '--runtime', 'electron', '--target', electronVersion, '--arch', arch, '--verbose'],
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
// from a copy outside the repo, whose package.json lists the main process's own (appDependencies), each
// linked from the repo's node_modules, where pnpm put the version the tests ran. electron-builder walks
// them from there, their own dependencies with them. The board's own come traced in the stage.
const appCopy = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-desktop-'))
fs.cpSync(path.join(root, 'desktop', 'app'), appCopy, { recursive: true })
for (const name of appDeps) {
  const installed = fs.realpathSync(path.join(root, 'node_modules', name))
  const { version } = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'))
  if (version !== brand.dependencies[name])
    fail(`node_modules has ${name} ${version}, not ${brand.dependencies[name]}: run pnpm install`)
  const link = path.join(appCopy, 'node_modules', name)
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(installed, link, 'junction')
}
const icon = path.join(appCopy, 'icon.png')
/** @type {import('electron-builder').Configuration} */
const common = {
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
  // Where the installed app looks for updates (app-update.yml) and what the metadata files name. Nothing
  // is uploaded from here (publish: 'never' below): scripts/release.mjs and the release workflow do it.
  publish: [PUBLISH],
}
/** @type {Partial<import('electron-builder').CliOptions> & { config: import('electron-builder').Configuration }} */
const windows = {
  win: ['nsis'],
  x64: true,
  config: {
    ...common,
    win: {
      icon,
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
}
// What Electron needs from the system, by each distribution's names; the package managers install it.
// electron-builder's own lists miss libgbm and ALSA, and Arch's names packages it no longer has.
/** @type {Partial<import('electron-builder').CliOptions> & { config: import('electron-builder').Configuration }} */
const linux = {
  linux: ['AppImage', 'deb', 'rpm', 'pacman'],
  x64: true,
  config: {
    ...common,
    linux: {
      // One per hicolor size, 16 to 256 px: desktop/app/icon.png (256) and smaller copies of it, made
      // once with a Lanczos resize (from one file electron-builder installs only its own size).
      icon: path.join(root, 'desktop', 'linux', 'icons'),
      category: 'Development',
      synopsis: 'The job board shared by one developer and their AI agents',
      description: brand.description,
      // The packages' maintainer and vendor: the author, by name (no address is invented here).
      maintainer: brand.author,
      vendor: brand.author,
      // The desktop entry is agent-board.desktop, its StartupWMClass agent-board: package.json's
      // desktopName, which Electron makes the window's Wayland app_id and X11 WM_CLASS.
      syncDesktopName: true,
      desktop: { entry: { Name: brand.productName, Keywords: 'agents;kanban;tickets;board;' } },
    },
    appImage: { artifactName: 'agent-board-${version}-${arch}.${ext}' },
    deb: {
      artifactName: 'agent-board_${version}_${arch}.${ext}',
      depends: [
        'libgtk-3-0',
        'libnotify4',
        'libnss3',
        'libxss1',
        'libxtst6',
        'xdg-utils',
        'libatspi2.0-0',
        'libuuid1',
        'libsecret-1-0',
        'libgbm1',
        'libasound2 | libasound2t64',
      ],
    },
    rpm: {
      artifactName: 'agent-board-${version}.${arch}.${ext}',
      // The package owns its folders too, so that removing it leaves no empty /opt/CrossBoard behind.
      fpm: ['--directories', '/opt/CrossBoard'],
      depends: [
        'gtk3',
        'libnotify',
        'nss',
        'libXScrnSaver',
        '(libXtst or libXtst6)',
        'xdg-utils',
        'at-spi2-core',
        '(libuuid or libuuid1)',
        'mesa-libgbm',
        'alsa-lib',
      ],
    },
    pacman: {
      artifactName: 'agent-board-${version}.${ext}',
      depends: [
        'gtk3',
        'libnotify',
        'nss',
        'libxss',
        'libxtst',
        'xdg-utils',
        'at-spi2-core',
        'util-linux-libs',
        'libsecret',
        'mesa',
        'alsa-lib',
      ],
    },
  },
}
try {
  await build({ projectDir: appCopy, publish: 'never', ...(WIN ? windows : linux) })
} finally {
  fs.rmSync(appCopy, { recursive: true, force: true })
}

// The packed app, as the updater needs it: its dependencies inside app.asar, app-update.yml beside it.
const resources = path.join(dist, WIN ? 'win-unpacked' : 'linux-unpacked', 'resources')
// electron-builder writes each Linux package's type into the unpacked folder's resources as it builds
// that package, and leaves the last one's (pacman) there: the packages each have their own, and the
// unpacked folder is none of them, so it goes, or an unpacked copy would update itself as a pacman one.
fs.rmSync(path.join(resources, 'package-type'), { force: true })
const asar = createRequire(
  createRequire(fs.realpathSync(require.resolve('electron-builder/package.json'))).resolve(
    'app-builder-lib/package.json',
  ),
)('@electron/asar')
const packed = new Set(asar.listPackage(path.join(resources, 'app.asar'), { isPack: false }))
for (const name of appDeps)
  if (!packed.has(path.join(path.sep, 'node_modules', name, 'package.json')))
    fail(`the packed app has no ${name} (app.asar has no node_modules/${name})`)
const updateConfig = path.join(resources, 'app-update.yml')
const configProblem = appUpdateConfigProblem(
  fs.existsSync(updateConfig) ? fs.readFileSync(updateConfig, 'utf8') : null,
)
if (configProblem) fail(configProblem)

if (WIN) {
  console.log(`\nInstaller: ${path.join(dist, `agent-board-setup-${brand.version}.exe`)}`)
  console.log(`Unpacked:  ${path.join(dist, 'win-unpacked', 'agent-board.exe')}`)
  if (!fs.existsSync(path.join(dist, 'latest.yml'))) fail(`electron-builder made no latest.yml in ${dist}`)
  console.log(`Metadata:  ${path.join(dist, 'latest.yml')}`)
} else {
  const v = brand.version
  const made = [
    ['AppImage:', `agent-board-${v}-x86_64.AppImage`],
    ['deb:', `agent-board_${v}_amd64.deb`],
    ['rpm:', `agent-board-${v}.x86_64.rpm`],
    ['pacman:', `agent-board-${v}.pacman`],
    ['Unpacked:', path.join('linux-unpacked', 'agent-board')],
    ['Metadata:', 'latest-linux.yml'],
  ]
  console.log('')
  for (const [what, file] of made) {
    if (!fs.existsSync(path.join(dist, file))) fail(`electron-builder made no ${file} in ${dist}`)
    console.log(`${what.padEnd(10)} ${path.join(dist, file)}`)
  }
}
