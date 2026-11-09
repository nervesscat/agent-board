// The Tailscale CLI, as the e2e suite stands in for it (TAILSCALE_BIN, which links here as tailscale.mjs): it
// answers each read from the state file the test writes (FAKE_TAILSCALE_STATE, JSON keyed by the arguments,
// `status --json` and so on), and fails any other call, so the board's own writes to Tailscale would show.
import fs from 'node:fs'

const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_TAILSCALE_LOG ?? '/dev/null', `${JSON.stringify(args)}\n`)
const state = JSON.parse(fs.readFileSync(process.env.FAKE_TAILSCALE_STATE, 'utf8'))
const answer = state[args.join(' ')]
if (answer === undefined) {
  process.stderr.write(`fake tailscale: nothing for ${args.join(' ')}\n`)
  process.exit(1)
}
process.stdout.write(typeof answer === 'string' ? answer : JSON.stringify(answer))
