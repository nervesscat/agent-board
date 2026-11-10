import { describe, expect, it } from 'vitest'

import {
  activeTab,
  closeTab,
  NO_PREVIEW_WINDOW,
  openTab,
  previewBrowserUrl,
  previewEmbedPath,
  previewHealth,
  previewNotice,
  previewTab,
  reloadTabs,
  showTab,
  toggleMaximized,
  type PreviewTab,
  type PreviewWindowsState,
} from './previewWindow'

const run = {
  url: 'http://127.0.0.1:47123',
  proxyUrl: 'http://localhost:47100/p/3/9/',
  remoteUrl: 'https://devbox.example-tailnet.ts.net/p/3/9/',
}

const tab = (id: string, over: Partial<PreviewTab> = {}): PreviewTab => ({
  key: `ws:3:${id}`,
  title: `#${id} A preview`,
  subtitle: id,
  src: `/p/3/${id}/`,
  browser: `http://localhost:47100/p/3/${id}/`,
  workspaceId: 3,
  ticketId: Number(id),
  runId: Number(id),
  through: true,
  ...over,
})

describe('the path the embedded window loads', () => {
  it('is the proxy path, so it is same-origin, signed in and never a loopback port off this machine', () => {
    expect(previewEmbedPath(run, true)).toBe('/p/3/9/')
    expect(previewEmbedPath({ proxyUrl: '/p/3/9/?x=1' }, false)).toBe('/p/3/9/?x=1')
  })

  it('is a loopback link as it is on this machine, when there is no proxy', () => {
    expect(previewEmbedPath({ url: 'http://127.0.0.1:47123' }, true)).toBe('http://127.0.0.1:47123')
    expect(previewEmbedPath({ url: 'http://localhost:3000/app' }, true)).toBe('http://localhost:3000/app')
  })

  it('is none for a loopback link off this machine, a hosted page, or the board proxy turned off', () => {
    expect(previewEmbedPath({ url: 'http://127.0.0.1:47123' }, false)).toBeNull()
    expect(previewEmbedPath({ url: 'https://example.com/x' }, true)).toBeNull()
    expect(previewEmbedPath({ url: null }, true)).toBeNull()
  })

  it('ignores a proxy URL that is not the preview path', () => {
    expect(previewEmbedPath({ proxyUrl: 'https://example.com/x' }, true)).toBeNull()
  })
})

describe('the link Open in browser opens', () => {
  it('is the proxy one wherever the page is opened: it is the same preview, and it reaches another device', () => {
    expect(previewBrowserUrl(run, true)).toBe('http://localhost:47100/p/3/9/')
    expect(previewBrowserUrl(run, false)).toBe('http://localhost:47100/p/3/9/')
  })

  it('falls back to the loopback one here, and to a hosted one anywhere', () => {
    expect(previewBrowserUrl({ url: 'http://127.0.0.1:47123' }, true)).toBe('http://127.0.0.1:47123')
    expect(previewBrowserUrl({ url: 'https://example.com/x' }, true)).toBe('https://example.com/x')
    expect(previewBrowserUrl({ url: 'https://example.com/x' }, false)).toBe('https://example.com/x')
  })

  it('gives up on a loopback one off this machine, but not on its tailnet link', () => {
    expect(previewBrowserUrl({ url: 'http://127.0.0.1:47123' }, false)).toBeNull()
    expect(previewBrowserUrl({ url: 'http://127.0.0.1:47123', remoteUrl: run.remoteUrl }, false)).toBe(
      run.remoteUrl,
    )
  })
})

describe('a preview tab', () => {
  it('is keyed by its workspace and run, titled by the ticket, and loads through the proxy', () => {
    expect(
      previewTab({ ticketId: 12, title: 'Try it', workspaceId: 3, runId: 9, label: 'wt · Preview', run }),
    ).toEqual({
      key: 'ws:3:9',
      title: '#12 Try it',
      subtitle: 'wt · Preview',
      src: '/p/3/9/',
      browser: 'http://localhost:47100/p/3/9/',
      workspaceId: 3,
      ticketId: 12,
      runId: 9,
      through: true,
    })
  })

  it('is an agent link on this machine, not through the proxy', () => {
    const linked = previewTab({
      ticketId: 12,
      title: 'Try it',
      workspaceId: 3,
      runId: null,
      label: 'wt',
      run: { url: 'http://127.0.0.1:5000' },
      here: true,
    })
    expect(linked).toMatchObject({ key: 'ws:3:link', src: 'http://127.0.0.1:5000', through: false })
  })

  it('is none when the preview cannot be framed', () => {
    expect(
      previewTab({
        ticketId: 12,
        title: 'Try it',
        workspaceId: 3,
        runId: null,
        label: 'wt',
        run: { url: 'https://example.com/x' },
        here: true,
      }),
    ).toBeNull()
  })
})

describe('the window state', () => {
  const opened = (): PreviewWindowsState => openTab(openTab(NO_PREVIEW_WINDOW, tab('9')), tab('10'))

  it('opens a tab and shows it; the same preview again switches to it instead of adding one', () => {
    let state = openTab(NO_PREVIEW_WINDOW, tab('9'))
    expect(state.tabs.map((t) => t.key)).toEqual(['ws:3:9'])
    expect(state.active).toBe('ws:3:9')
    state = openTab(state, tab('9', { title: '#9 Renamed' }))
    expect(state.tabs).toHaveLength(1)
    expect(activeTab(state)?.title).toBe('#9 Renamed')
    state = openTab(state, tab('10'))
    expect(state.tabs.map((t) => t.key)).toEqual(['ws:3:9', 'ws:3:10'])
    expect(state.active).toBe('ws:3:10')
  })

  it('switches to an open tab, and ignores one that is not', () => {
    const state = opened()
    expect(showTab(state, 'ws:3:9').active).toBe('ws:3:9')
    expect(showTab(state, 'ws:3:99')).toBe(state)
  })

  it('closes the active tab to the one before it, the next when it was first, and the window when it was last', () => {
    const state = opened()
    // The first of two closed: the next shows.
    expect(closeTab(state, 'ws:3:9')).toMatchObject({ active: 'ws:3:10', maximized: false })
    expect(closeTab(state, 'ws:3:10')).toMatchObject({ active: 'ws:3:9' })
    expect(closeTab(closeTab(state, 'ws:3:10'), 'ws:3:9')).toEqual({
      tabs: [],
      active: null,
      maximized: false,
      loads: {},
    })
    // A tab that is not active leaves the one showing.
    expect(closeTab(state, 'ws:3:9').tabs.map((t) => t.key)).toEqual(['ws:3:10'])
    expect(closeTab(state, 'ws:3:9').active).toBe('ws:3:10')
  })

  it('reloads one tab or all of them, and its loads go with the tab when it closes', () => {
    let state = reloadTabs(opened(), 'ws:3:9')
    expect(state.loads).toEqual({ 'ws:3:9': 1 })
    state = reloadTabs(state)
    expect(state.loads).toEqual({ 'ws:3:9': 2, 'ws:3:10': 1 })
    expect(closeTab(state, 'ws:3:9').loads).toEqual({ 'ws:3:10': 1 })
  })

  it('maximizes and restores', () => {
    expect(toggleMaximized(opened()).maximized).toBe(true)
    expect(toggleMaximized(toggleMaximized(opened())).maximized).toBe(false)
  })
})

describe('whether the preview still runs', () => {
  it('reads a proxied tab from its run: running, building, failed, stopped', () => {
    const t = { through: true }
    expect(previewHealth(t, undefined)).toBe('unknown')
    expect(previewHealth(t, { running: true, managed: { status: 'running' } })).toBe('running')
    expect(previewHealth(t, { running: true, managed: { status: 'building' } })).toBe('building')
    expect(previewHealth(t, { running: true, managed: { status: 'starting' } })).toBe('building')
    expect(previewHealth(t, { running: false, managed: { status: 'failed' } })).toBe('failed')
    expect(previewHealth(t, { running: false, managed: { status: 'stopped' } })).toBe('stopped')
    expect(previewHealth(t, { running: false, managed: null })).toBe('stopped')
  })

  it("reads an agent's link from whether it answers", () => {
    expect(previewHealth({ through: false }, { running: true })).toBe('running')
    expect(previewHealth({ through: false }, { running: false })).toBe('stopped')
  })

  it('says where the Start is, and never starts or stops the run itself', () => {
    expect(previewNotice('running', { through: true })).toBeNull()
    expect(previewNotice('unknown', { through: true })).toBeNull()
    expect(previewNotice('building', { through: true })).toMatch(/^Building/)
    expect(previewNotice('failed', { through: true }, 'port 47123 is in use')).toBe(
      'The preview failed: port 47123 is in use. See its log on the ticket.',
    )
    expect(previewNotice('stopped', { through: true })).toBe(
      "This preview is stopped. Start it from the ticket's Runs card or the Previews page.",
    )
    expect(previewNotice('stopped', { through: false })).toBe(
      'The preview does not answer on this machine. Start its server again where it runs.',
    )
  })
})
