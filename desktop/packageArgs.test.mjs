import fs from 'node:fs'

import { describe, expect, it } from 'vitest'

import { appDependencies, appUpdateConfigProblem, packageArch } from './packageArgs.mjs'

describe('packageArch', () => {
  it('is x64 when no arch is given', () => {
    expect(packageArch([])).toBe('x64')
    expect(packageArch(['--verbose'])).toBe('x64')
  })

  it('reads --arch <value> and --arch=<value> alike', () => {
    expect(packageArch(['--arch', 'arm64'])).toBe('arm64')
    expect(packageArch(['--arch=arm64'])).toBe('arm64')
    expect(packageArch(['--arch=x64'])).toBe('x64')
  })

  it('is empty, so refused, for an --arch without a value', () => {
    expect(packageArch(['--arch='])).toBe('')
    expect(packageArch(['--arch'])).toBe('')
    expect(packageArch(['--arch', '--verbose'])).toBe('')
  })

  it('takes the last arch given', () => {
    expect(packageArch(['--arch', 'x64', '--arch=arm64'])).toBe('arm64')
  })
})

describe('appDependencies', () => {
  const root = { devDependencies: { 'electron-updater': '6.8.11', vitest: '^4.0.0' } }

  it("names the app's dependencies, each pinned to the repo's version", () => {
    expect(appDependencies({ dependencies: { 'electron-updater': '6.8.11' } }, root)).toEqual([
      'electron-updater',
    ])
    expect(appDependencies({}, root)).toEqual([])
  })

  it('refuses one the repo has at another version, or not at all', () => {
    expect(() => appDependencies({ dependencies: { 'electron-updater': '6.9.0' } }, root)).toThrow(
      /electron-updater 6\.9\.0, the repo's package\.json 6\.8\.11/,
    )
    expect(() => appDependencies({ dependencies: { semver: '7.7.3' } }, root)).toThrow(
      /semver 7\.7\.3, the repo's package\.json none/,
    )
  })

  it("matches the app's package.json and the repo's as they are", () => {
    const read = (/** @type {string} */ f) => JSON.parse(fs.readFileSync(new URL(f, import.meta.url), 'utf8'))
    expect(appDependencies(read('./app/package.json'), read('../package.json'))).toEqual(['electron-updater'])
  })
})

describe('appUpdateConfigProblem', () => {
  it("accepts the repo's GitHub Releases, as electron-builder writes it", () => {
    expect(
      appUpdateConfigProblem(
        'owner: nervesscat\nrepo: agent-board\nprovider: github\nupdaterCacheDirName: agent-board-updater\n',
      ),
    ).toBeNull()
  })

  it('refuses a missing file, another provider or another repo', () => {
    expect(appUpdateConfigProblem(null)).toMatch(/no resources\/app-update\.yml/)
    expect(appUpdateConfigProblem('provider: generic\nurl: http://127.0.0.1:8120/\n')).toMatch(
      /provider generic, not github/,
    )
    expect(appUpdateConfigProblem('owner: someone\nrepo: agent-board\nprovider: github\n')).toMatch(
      /owner someone/,
    )
  })
})
