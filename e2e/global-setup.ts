import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { request } from '@playwright/test'

import { HUMAN, e2eEnv, git } from './env'
import { seedProject } from './fixtures'

/**
 * Runs once the board answers: a git repo for projects to point at, with a bare repo beside it as its
 * origin (main pushed), and a project (with that repo and its stages) for pages that only need one to
 * exist, written to seed.json. Tests that count tickets get a project of their own (the `project`
 * fixture), so they never see each other's.
 */
export default async function globalSetup() {
  const env = e2eEnv()
  // The Tailscale CLI the boards read: linked in, so a test can take it away (not installed), and its answers
  // start as a board on a running tailnet (tailnet-entrance.spec.ts sets them).
  fs.mkdirSync(path.dirname(env.tailscaleBin), { recursive: true })
  fs.symlinkSync(path.resolve('e2e/fake-tailscale.mjs'), env.tailscaleBin)
  fs.writeFileSync(env.tailscaleState, JSON.stringify({ version: '1.80.2\n' }))
  fs.mkdirSync(env.repoPath, { recursive: true })
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', env.originPath], { stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('commit', '-q', '--allow-empty', '-m', 'init')
  git('remote', 'add', 'origin', env.originPath)
  git('push', '-q', '-u', 'origin', 'main')

  const human = await request.newContext({
    baseURL: env.baseURL,
    extraHTTPHeaders: { 'X-Test-Actor': `human:${HUMAN}` },
  })
  const project = await seedProject(human, 'E2E')
  fs.writeFileSync(env.seedFile, JSON.stringify({ project }, null, 2))
  await human.dispose()
}
