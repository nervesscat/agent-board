import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { HttpError, readJson } from './http'

/** A request carrying exactly these bytes as its body, as a client that writes JSON by hand sends it. */
const raw = (body: string) =>
  new Request('http://localhost/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
const refusal = async (request: Request, schema: z.ZodType = z.unknown()) => {
  const err = await readJson(request, schema).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(HttpError)
  return err as HttpError
}
/** The message the platform's own JSON parser gives for this text. */
const parseError = (text: string) => {
  try {
    JSON.parse(text)
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('parsed')
}

describe('readJson', () => {
  it('decodes \\\\ escapes to one backslash each', async () => {
    // String.raw keeps the bytes as written: two backslashes per separator, as valid JSON has them.
    const body = String.raw`{"repoPath":"F:\\Programming\\Python\\x"}`
    expect(Buffer.from(body).filter((b) => b === 0x5c)).toHaveLength(6)
    const read = await readJson(raw(body), z.object({ repoPath: z.string() }))
    expect(read.repoPath).toBe(['F:', 'Programming', 'Python', 'x'].join('\\'))
  })

  it("says why a body is not JSON: the parser's message, and how a backslash is written", async () => {
    // What a shell leaves of the body above when it collapses \\ to \: \P is no JSON escape.
    const body = String.raw`{"repoPath":"F:\Programming"}`
    const err = await refusal(raw(body))
    expect(err.status).toBe(400)
    const parserMessage = parseError(body)
    expect(parserMessage).toMatch(/escaped character/i)
    expect(err.message).toBe(
      `body must be JSON: ${parserMessage}` +
        String.raw`; a backslash in a JSON string is written \\ (or \u005c)`,
    )
  })

  it('gives the backslash hint for a broken \\u escape too', async () => {
    const err = await refusal(raw(String.raw`{"repoPath":"C:\users"}`))
    expect(err.message).toMatch(/^body must be JSON: .*escape.*; a backslash in a JSON string is written/i)
  })

  it('gives no backslash hint when the body is broken some other way', async () => {
    const body = '{"repoPath":"x",}'
    const err = await refusal(raw(body))
    expect(err.message).toBe(`body must be JSON: ${parseError(body)}`)
  })

  it('gives no backslash hint when only the quoted body says "escape"', async () => {
    const body = '{"projectId":1,"repoPath": escape}'
    const reason = parseError(body)
    expect(reason).toContain('escape')
    const err = await refusal(raw(body))
    expect(err.message).toBe(`body must be JSON: ${reason}`)
  })

  it('refuses an empty body as not JSON, with the reason', async () => {
    const err = await refusal(raw(''))
    expect(err.status).toBe(400)
    expect(err.message).toMatch(/^body must be JSON: \S/)
  })

  it("keeps zod's message, without the JSON words, for JSON that does not fit the schema", async () => {
    const err = await refusal(raw('{"repoPath":7}'), z.object({ repoPath: z.string() }))
    expect(err.status).toBe(400)
    expect(err.message).not.toContain('body must be JSON')
    const expected = z.object({ repoPath: z.string() }).safeParse({ repoPath: 7 })
    expect(err.message).toBe(z.prettifyError(expected.error!))
  })
})
