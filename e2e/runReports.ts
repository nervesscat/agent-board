import type { APIRequestContext } from '@playwright/test'

import { expect, ok } from './fixtures'

/**
 * One run report written through the board's MCP, as an agent, and answered by the stored row. This is
 * the path a subagent takes before it hands back.
 */
export async function writeReport(
  agent: APIRequestContext,
  projectId: number,
  ticketId: number,
  fields: Record<string, unknown>,
) {
  const res = await agent.post('/api/mcp', {
    headers: { accept: 'application/json, text/event-stream' },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'write_run_report',
        arguments: { projectId, ticketId, ...fields },
      },
    },
  })
  const body = await ok<{ result: { isError?: boolean; content: { text: string }[] } }>(res)
  expect(body.result.isError, body.result.content[0]?.text).toBeUndefined()
  return JSON.parse(body.result.content[0]!.text) as { id: number; durationMs: number }
}
