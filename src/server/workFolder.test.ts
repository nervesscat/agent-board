import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ensureProjectWorkFolder, projectWorkFolder } from './workFolder'

describe('the work folder of a project with no software kind', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-folder-'))
  })

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('is one plain folder per project under the data folder', () => {
    expect(projectWorkFolder(7, dataDir)).toBe(path.join(dataDir, 'projects', '7'))
    expect(projectWorkFolder(8, dataDir)).not.toBe(projectWorkFolder(7, dataDir))
  })

  it('is created on first use and left as it is after that', () => {
    const dir = ensureProjectWorkFolder(7, dataDir)
    fs.writeFileSync(path.join(dir, 'take-1.wav'), 'x')
    expect(ensureProjectWorkFolder(7, dataDir)).toBe(dir)
    expect(fs.readFileSync(path.join(dir, 'take-1.wav'), 'utf8')).toBe('x')
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(false)
  })
})
