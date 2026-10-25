import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { ActorRow } from '#/lib/api'

// Who signs in as what, as `/api/actors` would say; no project agents on the page.
const actors: Partial<ActorRow>[] = [{ name: 'orch/builder-1', kind: 'agent', role: 'worker' }]
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: actors }) }))
vi.mock('#/lib/project', () => ({ useProjectAgent: () => undefined }))

const { ClaimedActor, claimedShape } = await import('./Actor')

const html = (name: string, by: string | null | undefined) =>
  renderToStaticMarkup(createElement(ClaimedActor, { name, by }))

describe('ClaimedActor', () => {
  it('is one Actor when the name is its recorder, or the recorder is unknown', () => {
    expect(claimedShape('claude', 'claude')).toBe('actor')
    expect(claimedShape('claude', '')).toBe('actor')
    expect(claimedShape('claude', null)).toBe('actor')
    expect(claimedShape('enrique', 'orch/builder-1')).toBe('claimed')
  })

  it("shows the Board badge only on the board's own events", () => {
    expect(claimedShape('board', 'board')).toBe('actor')
    // An older event with no recorder still reads as the board's.
    expect(claimedShape('board', '')).toBe('actor')
    const own = html('board', 'board')
    expect(own).toContain('data-role="board"')
    expect(own).not.toContain('event-by')
  })

  it("treats a worker's event under the name 'board' as a claim: plain name, then who recorded it", () => {
    expect(claimedShape('board', 'orch/builder-1')).toBe('claimed')
    const claimed = html('board', 'orch/builder-1')
    const [name, by] = claimed.split('data-testid="event-by"')
    expect(name).toContain('data-testid="claimed-name"')
    expect(name).toContain('>board</span>')
    // No badge on the claimed part: only the recorder carries one, and it is the worker's.
    expect(name).not.toContain('data-role')
    expect(claimed).not.toContain('data-role="board"')
    expect(by).toContain('data-role="worker"')
    expect(by).toContain('orch/builder-1')
  })
})

describe('Actor', () => {
  it('stays inside its line: the root shrinks and the name breaks anywhere', () => {
    const out = html('orch/builder-1', 'orch/builder-1')
    const root = /<span class="([^"]*)" data-role="worker"/.exec(out)?.[1] ?? ''
    expect(root.split(' ')).toEqual(
      expect.arrayContaining(['inline-flex', 'min-w-0', 'max-w-full', 'wrap-anywhere']),
    )
  })
})
