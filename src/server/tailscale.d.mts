/** Types of tailscale.mjs, the Tailscale CLI's read-only calls (shared by the board and `pnpm tailnet`). */

export const READS: readonly string[]

export function tailscaleBin(): string

export function tailscaleCommand(args: string[]): [string, string[]]

export function tailscaleSync(...args: string[]): string

export function tailscaleAsync(...args: string[]): Promise<string>

export function parseTailscaleJson(out: string, args: string[]): Record<string, unknown>

export interface Funnelled {
  hostPort: string
  where: string | null
}

export function funnelled(config: unknown): Funnelled[]

export function servedAt(config: unknown, name: string, port: number | string): string | null
