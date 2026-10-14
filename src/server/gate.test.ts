import { afterEach, describe, expect, it, vi } from 'vitest'

import { askGate, CACHE_MAX, gateCaller } from './gate'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** A gate that says no to everyone, and records every /auth it is asked: `url credential`. */
function refusingGate() {
  const asked: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const h = new Headers(init.headers)
      asked.push(`${url} ${h.get('authorization') ?? h.get('cookie')}`)
      return Response.json({ error: 'sign in' }, { status: 401 })
    }),
  )
  return asked
}

describe('askGate', () => {
  it('caches each answer under the gate that gave it, for a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const asked = refusingGate()
    const a = 'http://127.0.0.1:47111'
    const b = 'http://localhost:47110'
    expect(await askGate(a, 'cookie', 'gate_session=one')).toBeNull()
    expect(await askGate(a, 'cookie', 'gate_session=one')).toBeNull()
    expect(await askGate(b, 'cookie', 'gate_session=one')).toBeNull()
    expect(asked).toEqual([`${a}/auth gate_session=one`, `${b}/auth gate_session=one`])
    vi.advanceTimersByTime(61_000)
    await askGate(a, 'cookie', 'gate_session=one')
    expect(asked).toHaveLength(3)
  })

  it('keeps at most CACHE_MAX answers: made-up cookies cannot grow it without end', async () => {
    const asked = refusingGate()
    const gate = 'http://127.0.0.1:47111'
    await askGate(gate, 'cookie', 'gate_session=first')
    for (let i = 0; i < CACHE_MAX; i++) await askGate(gate, 'cookie', `gate_session=made-up-${i}`)
    expect(asked).toHaveLength(CACHE_MAX + 1)
    // The oldest answer made room for the newest, and is asked again; the newest are still kept.
    await askGate(gate, 'cookie', 'gate_session=first')
    expect(asked).toHaveLength(CACHE_MAX + 2)
    await askGate(gate, 'cookie', `gate_session=made-up-${CACHE_MAX - 1}`)
    expect(asked).toHaveLength(CACHE_MAX + 2)
  })

  it('drops expired answers first when it is full, before a fresh one that is older in line', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const asked = refusingGate()
    const gate = 'http://127.0.0.1:47111'
    await askGate(gate, 'cookie', 'gate_session=kept')
    for (let i = 1; i < CACHE_MAX; i++) await askGate(gate, 'cookie', `gate_session=old-${i}`)
    vi.advanceTimersByTime(61_000)
    // All have expired. The first is asked again: fresh now, though still the first in line.
    await askGate(gate, 'cookie', 'gate_session=kept')
    await askGate(gate, 'cookie', 'gate_session=new')
    const before = asked.length
    await askGate(gate, 'cookie', 'gate_session=kept')
    expect(asked).toHaveLength(before)
  })

  it('asks again after the gate could not be reached', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++
        throw new Error('connect ECONNREFUSED')
      }),
    )
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const gate = 'http://127.0.0.1:47111'
    expect(await askGate(gate, 'authorization', 'Bearer gate_x')).toBeNull()
    expect(await askGate(gate, 'authorization', 'Bearer gate_x')).toBeNull()
    expect(calls).toBe(2)
    expect(error).toHaveBeenCalledWith(`gate unreachable at ${gate}:`, 'connect ECONNREFUSED')
    error.mockRestore()
  })
})

describe('gateCaller', () => {
  it('shows the gate the token, else the session cookie, and nothing without either', async () => {
    const asked = refusingGate()
    const gate = 'http://127.0.0.1:47111'
    const headers = (h: Record<string, string>) => new Headers(h)
    expect(await gateCaller(gate, headers({}))).toBeNull()
    expect(await gateCaller(gate, headers({ cookie: 'theme=dark' }))).toBeNull()
    expect(await gateCaller(gate, headers({ authorization: 'Basic abc' }))).toBeNull()
    expect(await gateCaller(gate, headers({ 'tailscale-user-login': 'someone@example.com' }))).toBeNull()
    expect(asked).toEqual([])
    await gateCaller(gate, headers({ authorization: 'Bearer gate_t', cookie: 'gate_session=s' }))
    await gateCaller(gate, headers({ cookie: 'theme=dark; gate_session=s2' }))
    expect(asked).toEqual([`${gate}/auth Bearer gate_t`, `${gate}/auth theme=dark; gate_session=s2`])
  })
})
