import { describe, expect, it } from 'vitest'

import { packageArch } from './packageArgs.mjs'

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
