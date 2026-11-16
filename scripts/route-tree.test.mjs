import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/** The checkout these tests run in. */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** src/routeTree.gen.ts, as a route generator or a build leaves it. */
const ROUTE_TREE = 'src/routeTree.gen.ts'

/**
 * What `vite build` and `vite dev` append to the generated route tree: the start plugin's module
 * registration, which the repo keeps out of git (scripts/release.mjs BUILD_OUTPUTS). It is not what the
 * generator writes, so a commit carrying it is a commit of a build's file, and the next build's rewrite
 * of the tree can no longer be told apart from a real change.
 */
const BUILD_TAIL = ["declare module '@tanstack/react-start'", 'interface Register']

/** The tail's markers that `text` carries, in BUILD_TAIL's order. */
const tailIn = (text) => BUILD_TAIL.filter((marker) => text.includes(marker))

describe('the committed route tree', () => {
  it('holds what the generator writes, without the tail a build appends', () => {
    // The commit's file, not the working copy, which a local build leaves with the tail.
    const committed = execFileSync('git', ['show', `HEAD:${ROUTE_TREE}`], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    expect(
      tailIn(committed),
      `HEAD:${ROUTE_TREE} carries the tail a build appends; commit pnpm generate-routes' output alone`,
    ).toEqual([])
  })
})
