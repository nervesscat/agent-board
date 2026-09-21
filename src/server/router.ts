import { HttpError } from './http'

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export interface Ctx {
  request: Request
  params: Record<string, string>
  url: URL
  actor: string
}
export type Handler = (ctx: Ctx) => Promise<Response> | Response

interface Route {
  method: Method
  keys: string[]
  re: RegExp
  handler: Handler
}

/** A tiny path router for the /api surface, so all JSON routes live in one file with plain patterns. */
export class ApiRouter {
  private routes: Route[] = []

  on(method: Method, pattern: string, handler: Handler) {
    const keys: string[] = []
    const re = new RegExp(
      `^${pattern.replace(/:(\w+)/g, (_, k: string) => {
        keys.push(k)
        return '([^/]+)'
      })}/?$`,
    )
    this.routes.push({ method, keys, re, handler })
    return this
  }

  get = (p: string, h: Handler) => this.on('GET', p, h)
  post = (p: string, h: Handler) => this.on('POST', p, h)
  put = (p: string, h: Handler) => this.on('PUT', p, h)
  patch = (p: string, h: Handler) => this.on('PATCH', p, h)
  delete = (p: string, h: Handler) => this.on('DELETE', p, h)

  async handle(request: Request, actor: string): Promise<Response> {
    const url = new URL(request.url)
    let pathMatched = false
    for (const r of this.routes) {
      const m = r.re.exec(url.pathname)
      if (!m) continue
      pathMatched = true
      if (r.method !== request.method) continue
      const params: Record<string, string> = {}
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)))
      return r.handler({ request, params, url, actor })
    }
    throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'method not allowed' : 'no such endpoint')
  }
}
