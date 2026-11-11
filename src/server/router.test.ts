import { afterEach, describe, expect, it } from 'vitest'

import { pathUnderAppBase, useAppBase } from './previewPaths'
import { ApiRouter } from './router'

/**
 * A preview of the board serves its API under its base on the board's origin (`/p/<w>/<r>/api/…`): the
 * router matches the path under the base, as the app's own routes do.
 */
describe('the api of a build served at its own base', () => {
  const router = new ApiRouter().get('/api/me', () => Response.json({ me: 'ok' }))

  afterEach(() => useAppBase('/'))

  it('matches /api/me at the root, as the board does', async () => {
    const res = await router.handle(new Request('http://board.test/api/me'), 'enrique')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ me: 'ok' })
  })

  it('matches /p/<w>/<r>/api/me when the build serves at that base', async () => {
    useAppBase('/p/56/1/')
    const res = await router.handle(new Request('http://board.test/p/56/1/api/me'), 'enrique')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ me: 'ok' })
  })

  it("takes off exactly that base, and leaves another run's path alone", () => {
    useAppBase('/p/56/1/')
    expect(pathUnderAppBase('/p/56/1/api/me')).toBe('/api/me')
    expect(pathUnderAppBase('/p/56/1/')).toBe('/')
    expect(pathUnderAppBase('/p/56/1')).toBe('/')
    expect(pathUnderAppBase('/p/56/10/api/me')).toBe('/p/56/10/api/me')
    expect(pathUnderAppBase('/api/me')).toBe('/api/me')
  })

  it('leaves the root build as it was', () => {
    expect(pathUnderAppBase('/api/me')).toBe('/api/me')
  })
})
