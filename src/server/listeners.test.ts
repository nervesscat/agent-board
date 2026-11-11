import net from 'node:net'

import { describe, expect, it } from 'vitest'

import { listeningAddresses, loopbackOf } from './listeners'

/** Whether this machine lets a test listen on every address (a sandbox may allow loopback only). */
const canListenBeyond = await new Promise<boolean>((resolve) => {
  const probe = net.createServer()
  probe.once('error', () => resolve(false))
  probe.listen(0, '0.0.0.0', () => probe.close(() => resolve(true)))
})

describe('where a port listens', () => {
  it('reads loopback addresses as loopback, and anything else, or an address it cannot read, as beyond', () => {
    expect(loopbackOf(['127.0.0.1:8150'])).toBe('loopback')
    expect(loopbackOf(['[::1]:8150', '127.0.0.2:8150'])).toBe('loopback')
    expect(loopbackOf(['0.0.0.0:8150'])).toBe('beyond')
    expect(loopbackOf(['*:8150'])).toBe('beyond')
    expect(loopbackOf(['[::]:8150'])).toBe('beyond')
    expect(loopbackOf(['192.168.1.20:8150', '127.0.0.1:8150'])).toBe('beyond')
    expect(loopbackOf(['not an address'])).toBe('beyond')
  })

  it('cannot tell when nothing is listed', () => {
    expect(loopbackOf([])).toBe('unknown')
  })

  it.skipIf(!canListenBeyond)('sees a real listener bound to every address as beyond loopback', async () => {
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
    try {
      const port = (server.address() as net.AddressInfo).port
      const addresses = await listeningAddresses(port)
      expect(addresses.length).toBeGreaterThan(0)
      expect(loopbackOf(addresses)).toBe('beyond')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
