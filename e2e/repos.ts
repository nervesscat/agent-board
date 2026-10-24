import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type { APIRequestContext } from '@playwright/test'

import type { Project, Repo } from '#/lib/api'
import { e2eEnv } from './env'
import { ok } from './fixtures'

/**
 * A project of its own on a repo of its own: a bare origin and the board's checkout of it, main
 * pushed before the board first looks. The run's shared repo will not do for what reached origin
 * today: other tests push to its origin at the same time, and every project on it would see their
 * commits arrive.
 */
export async function ownRepo(human: APIRequestContext, name: string) {
  const dir = fs.mkdtempSync(path.join(e2eEnv().root, 'pushed-today-'))
  const origin = path.join(dir, 'origin.git')
  const repoPath = path.join(dir, 'repo')
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', '-c', 'core.autocrlf=false', ...args],
      {
        cwd,
        encoding: 'utf8',
      },
    )
  fs.mkdirSync(origin)
  git(origin, 'init', '-q', '--bare', '-b', 'main')
  fs.mkdirSync(repoPath)
  git(repoPath, 'init', '-q', '-b', 'main')
  git(repoPath, 'remote', 'add', 'origin', origin)
  fs.writeFileSync(path.join(repoPath, 'base.txt'), 'base\nlines\n')
  git(repoPath, 'add', 'base.txt')
  git(repoPath, 'commit', '-q', '-m', 'base')
  git(repoPath, 'push', '-q', 'origin', 'main')

  const created = await ok<{ id: number }>(human.post('/api/projects', { data: { name } }))
  await ok<Repo>(human.post('/api/repos', { data: { projectId: created.id, repoPath, name: 'shop-api' } }))
  const project = await ok<Project>(human.get(`/api/projects/${created.id}`))
  // The board's first look at the repo: from here on it sees what arrives.
  await look(human, project)
  return {
    project,
    /** A commit of one new one-line file on `branch` (cut from main), pushed from the checkout. */
    push: (branch: string) => {
      git(repoPath, 'checkout', '-q', '-b', branch, 'main')
      fs.writeFileSync(path.join(repoPath, `${branch.replace(/\W/g, '-')}.txt`), 'one line\n')
      git(repoPath, 'add', '.')
      git(repoPath, 'commit', '-q', '-m', `work on ${branch}`)
      git(repoPath, 'push', '-q', 'origin', branch)
    },
    /**
     * A commit writing `text` to `file` on `branch` (cut from main when it is new), pushed from the
     * checkout. Returns its sha.
     */
    write: (branch: string, file: string, text: string) => {
      const known = git(repoPath, 'branch', '--list', branch).trim()
      git(repoPath, 'checkout', '-q', ...(known ? [branch] : ['-b', branch, 'main']))
      fs.writeFileSync(path.join(repoPath, file), text)
      git(repoPath, 'add', file)
      git(repoPath, 'commit', '-q', '-m', `${file} on ${branch}`)
      git(repoPath, 'push', '-q', 'origin', branch)
      return git(repoPath, 'rev-parse', 'HEAD').trim()
    },
  }
}

/**
 * A git checkout whose path has backslash separators on every OS: Windows' own, elsewhere a folder
 * name holding backslashes (legal there). Its JSON carries `\\` either way.
 */
export function backslashCheckout(name: string) {
  const dir = fs.mkdtempSync(path.join(e2eEnv().root, `${name}-`))
  const repoPath =
    process.platform === 'win32'
      ? path.join(dir, 'code', 'repo')
      : path.join(dir, ['code', 'repo'].join(String.fromCharCode(0x5c)))
  fs.mkdirSync(repoPath, { recursive: true })
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...args], {
      cwd: repoPath,
    })
  git('init', '-q', '-b', 'main')
  git('commit', '-q', '--allow-empty', '-m', 'base')
  return repoPath
}

/** What the page's refresh does: fetch origin into the checkout and read its branches afresh. */
export const look = (human: APIRequestContext, project: Project) =>
  ok(human.post(`/api/projects/${project.id}/push/refresh`))
