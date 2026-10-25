// The command line of `pnpm desktop:package` (package.mjs), apart so that it can be tested without a build.

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
