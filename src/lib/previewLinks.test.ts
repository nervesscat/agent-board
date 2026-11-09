import { describe, expect, it } from 'vitest'

import { previewOpenLinks } from './previewLinks'

const run = {
  url: 'http://127.0.0.1:47101',
  proxyUrl: 'http://localhost:47100/p/3/9/',
  remoteUrl: 'https://devbox.example-tailnet.ts.net/p/3/9/',
}

describe('the link a running preview is opened by', () => {
  it('on this machine: the loopback URL, with the proxied path beside it', () => {
    expect(previewOpenLinks(run, true)).toEqual({
      open: 'http://127.0.0.1:47101',
      through: 'http://localhost:47100/p/3/9/',
    })
  })

  it('on the tailnet name: the proxied path alone, relative to that origin', () => {
    expect(previewOpenLinks(run, false)).toEqual({ open: '/p/3/9/', through: null })
  })

  it('falls back to what it has when a link is missing', () => {
    expect(previewOpenLinks({ url: null, proxyUrl: 'http://localhost:47100/p/3/9/' }, true)).toEqual({
      open: 'http://localhost:47100/p/3/9/',
      through: 'http://localhost:47100/p/3/9/',
    })
    expect(previewOpenLinks({ url: null }, false)).toEqual({ open: null, through: null })
  })
})
