import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp
process.env.FEATURE_REVIEW_DIR = path.join(tmp, 'feature-review')

let reviews: typeof import('./reviews')
let prs: typeof import('./prs')
beforeAll(async () => {
  reviews = await import('./reviews')
  prs = await import('./prs')
})

describe('nativePath', () => {
  it('turns git-bash drive paths into Windows paths on win32, leaves others alone', () => {
    const expected =
      process.platform === 'win32' ? 'C:/Users/me/.claude/x/review.md' : '/c/Users/me/.claude/x/review.md'
    expect(reviews.nativePath('/c/Users/me/.claude/x/review.md')).toBe(expected)
    expect(reviews.nativePath('/home/me/review.md')).toBe('/home/me/review.md')
  })
})

describe('entryBelongsTo', () => {
  const entry = {
    repo: 'https://github.com/Authentic-org/spark-backend.git',
    path: '/c/u/.claude/feature-review/spark-backend-pr-1314/review.md',
  }
  const base = { target: 'pr 1314', sha: 'abc', verdict: 'SHIP', at: '2026-09-21T00:00:00Z' }
  it('matches on the GitHub repo slug', () => {
    expect(
      reviews.entryBelongsTo(
        { ...base, ...entry },
        { repoPath: 'F:\\x\\other', githubRepo: 'authentic-org/spark-backend' },
      ),
    ).toBe(true)
  })
  it('falls back to the checkout directory name in the review path', () => {
    expect(
      reviews.entryBelongsTo(
        { ...base, ...entry },
        { repoPath: 'F:\\Programming\\spark-backend', githubRepo: null },
      ),
    ).toBe(true)
    expect(
      reviews.entryBelongsTo(
        { ...base, ...entry },
        { repoPath: 'F:\\Programming\\webapp', githubRepo: null },
      ),
    ).toBe(false)
  })
})

describe('readLedger', () => {
  it('keeps entries at or after `since` and skips half-written lines', () => {
    fs.mkdirSync(process.env.FEATURE_REVIEW_DIR!, { recursive: true })
    fs.writeFileSync(
      path.join(process.env.FEATURE_REVIEW_DIR!, 'ledger.jsonl'),
      [
        JSON.stringify({
          repo: 'r',
          target: 'pr 1',
          sha: 'a',
          verdict: 'SHIP',
          path: '/x/a/review.md',
          at: '2026-09-21T10:00:00Z',
        }),
        JSON.stringify({
          repo: 'r',
          target: 'pr 2',
          sha: 'b',
          verdict: 'FIX',
          path: '/x/b/review.md',
          at: '2026-09-21T12:00:00Z',
        }),
        '{"repo": "r", "target": "pr 3"',
        '',
      ].join('\n'),
    )
    const got = reviews.readLedger(new Date('2026-09-21T11:00:00Z'))
    expect(got.map((e) => e.target)).toEqual(['pr 2'])
  })
})

describe('importImages', () => {
  it('copies local screenshots into uploads and rewrites the links; leaves remote and missing ones', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'review-'))
    fs.mkdirSync(path.join(dir, 'shots'))
    fs.writeFileSync(path.join(dir, 'shots', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const md = '![login](shots/a.png)\n![gone](shots/missing.png)\n![web](https://x/y.png)'
    const out = reviews.importImages(md, dir, 'tester')
    expect(out).toMatch(/!\[login\]\(\/api\/uploads\/\d+\)/)
    expect(out).toContain('![gone](shots/missing.png)')
    expect(out).toContain('![web](https://x/y.png)')
    expect(fs.readdirSync(path.join(tmp, 'uploads'))).toHaveLength(1)
  })
})

describe('isDue', () => {
  const monday1500 = new Date(2026, 8, 21, 15, 0) // Monday
  const weekdays = 0b0111110
  it('is due once the slot has passed and nothing ran since it', () => {
    expect(reviews.isDue({ time: '09:00', days: weekdays, enabled: true, lastRunAt: null }, monday1500)).toBe(
      true,
    )
    expect(
      reviews.isDue(
        {
          time: '09:00',
          days: weekdays,
          enabled: true,
          lastRunAt: new Date(2026, 8, 20, 9, 0).toISOString(),
        },
        monday1500,
      ),
    ).toBe(true)
  })
  it('is not due before the slot, after it already ran, on an off day, or when disabled', () => {
    expect(reviews.isDue({ time: '16:00', days: weekdays, enabled: true, lastRunAt: null }, monday1500)).toBe(
      false,
    )
    expect(
      reviews.isDue(
        {
          time: '09:00',
          days: weekdays,
          enabled: true,
          lastRunAt: new Date(2026, 8, 21, 9, 1).toISOString(),
        },
        monday1500,
      ),
    ).toBe(false)
    expect(
      reviews.isDue({ time: '09:00', days: 0b0000001, enabled: true, lastRunAt: null }, monday1500),
    ).toBe(false)
    expect(
      reviews.isDue({ time: '09:00', days: weekdays, enabled: false, lastRunAt: null }, monday1500),
    ).toBe(false)
  })
})

describe('localPath', () => {
  it('maps Windows drive paths into WSL, leaves everything else alone', async () => {
    const { localPath } = await import('./uploads')
    expect(localPath('C:\\Users\\me\\shot.png', 'linux')).toBe('/mnt/c/Users/me/shot.png')
    expect(localPath('F:/work/a b/rec.mp4', 'linux')).toBe('/mnt/f/work/a b/rec.mp4')
    expect(localPath('/home/me/shot.png', 'linux')).toBe('/home/me/shot.png')
    expect(localPath('C:\\Users\\me\\shot.png', 'win32')).toBe('C:\\Users\\me\\shot.png')
  })
})

describe('prStatus', () => {
  it('hold wins, then any review of mine, else pending', () => {
    expect(prs.prStatus({ hold: true, myReview: 'approved' })).toBe('on_hold')
    expect(prs.prStatus({ hold: false, myReview: 'approved' })).toBe('reviewed')
    expect(prs.prStatus({ hold: false, myReview: 'commented' })).toBe('reviewed')
    expect(prs.prStatus({ hold: false, myReview: 'none' })).toBe('pending')
  })
})
