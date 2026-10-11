import { HttpError } from './http'

/**
 * One run of the `claude` CLI in print mode: `config.claudeBin` with `config.claudeArgs` first, then
 * `-p --output-format text`, the prompt written to its stdin (never an argument, so its size is not
 * bounded by the command line). Resolves with what it printed; rejects when it fails, exits non-zero
 * or outlives `timeoutMs`, killed then.
 */
export async function runClaude(_prompt: string, _opts: { timeoutMs?: number } = {}): Promise<string> {
  throw new HttpError(501, 'generating a report with claude is not available yet')
}
