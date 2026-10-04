import { z } from 'zod'

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Tells the UI which refusal it is, when it can offer a way past it. */
    public code?: string,
  ) {
    super(message)
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`)

/** Parse and validate a JSON body; a bad body is a 400 with zod's message, which is safe to show. */
export async function readJson<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    throw new HttpError(400, 'body must be JSON')
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error))
  return parsed.data
}

export function intParam(value: string, name = 'id'): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${name} must be a positive integer`)
  return n
}

/** Wrap a handler so thrown HttpErrors become JSON and anything else is a logged 500. */
export function api<TCtx extends { request: Request }>(fn: (ctx: TCtx) => Promise<Response> | Response) {
  return async (ctx: TCtx): Promise<Response> => {
    try {
      return await fn(ctx)
    } catch (err) {
      if (err instanceof HttpError)
        return Response.json(
          { error: err.message, ...(err.code ? { code: err.code } : {}) },
          { status: err.status },
        )
      console.error(`${ctx.request.method} ${new URL(ctx.request.url).pathname} failed:`, err)
      return Response.json({ error: 'internal error, see the server log' }, { status: 500 })
    }
  }
}
