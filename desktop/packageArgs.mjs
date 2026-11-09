// What `pnpm desktop:package` (package.mjs) reads and checks, its command line among them, apart so that it
// can be tested without a build.

/**
 * The arch asked for: `--arch <value>` or `--arch=<value>` (the last one given wins), `x64` when none
 * is given, and '' for one given without a value, which package.mjs refuses as it does any arch but x64.
 * @param {string[]} argv The arguments after the script.
 */
export function packageArch(argv) {
  let arch = 'x64'
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--arch=')) arch = a.slice('--arch='.length)
    else if (a === '--arch') {
      const next = argv[i + 1] ?? ''
      arch = next.startsWith('--') ? '' : next
      if (arch) i++
    }
  }
  return arch.trim()
}

/** Where the packed app's updater looks for releases: the repo's GitHub Releases (app-update.yml). */
export const PUBLISH = { provider: /** @type {const} */ ('github'), owner: 'nervesscat', repo: 'agent-board' }

/**
 * The packages the app's main process loads (desktop/app/package.json's dependencies, electron-updater),
 * which package.mjs links into the copy it packs from the repo's node_modules. Each must be pinned to
 * the version the repo installs (its package.json, which the tests load the same package from), so the
 * packed app runs what was tested.
 * @param {{ dependencies?: Record<string, string> }} appPkg
 * @param {{ dependencies?: Record<string, string>, devDependencies?: Record<string, string> }} rootPkg
 * @returns {string[]} The packages' names.
 */
export function appDependencies(appPkg, rootPkg) {
  const deps = Object.entries(appPkg.dependencies ?? {})
  for (const [name, version] of deps) {
    const repo = rootPkg.dependencies?.[name] ?? rootPkg.devDependencies?.[name]
    if (repo !== version)
      throw new Error(
        `desktop/app/package.json has ${name} ${version}, the repo's package.json ${repo ?? 'none'}: they must be the same version`,
      )
  }
  return deps.map(([name]) => name)
}

/**
 * What is wrong with the app-update.yml electron-builder wrote into the packed app's resources, or
 * null: it must name the repo's GitHub Releases (PUBLISH).
 * @param {string | null} text The file, null when there is none.
 */
export function appUpdateConfigProblem(text) {
  if (text === null) return 'the packed app has no resources/app-update.yml'
  /** @type {Record<string, string>} */
  const fields = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\w+):\s*['"]?([^'"]*)['"]?\s*$/.exec(line)
    if (m) fields[m[1]] = m[2]
  }
  for (const [key, value] of Object.entries(PUBLISH))
    if (fields[key] !== value) return `app-update.yml has ${key} ${fields[key] ?? 'none'}, not ${value}`
  return null
}
