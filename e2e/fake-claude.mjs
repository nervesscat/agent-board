// Stands in for the `claude` CLI in the tests: the board runs it as `node e2e/fake-claude.mjs -p
// --output-format text` (CLAUDE_BIN and CLAUDE_ARGS, set in playwright.config.ts; the unit tests set
// them too) and writes the prompt to its stdin. It reads the whole prompt and answers with a report
// that fills the default template.
//
// A test steers it with markers in the prompt (put in the project's report prompt, which the board
// copies into what it sends):
//   [fake-claude-log: <file>]  appends {argv, stdin, pid} as a JSON line to <file> before answering
//   [fake-claude: bad]         answers without the "Next" heading, every time
//   [fake-claude: bad-then-good]  answers badly when <file> above has no earlier run, well after
//   [fake-claude: slow <ms>]   waits <ms> before answering well
//   [fake-claude: fail]        says why on stderr and exits 3
import fs from 'node:fs'

let prompt = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) prompt += chunk

const log = /\[fake-claude-log: ([^\]]+)\]/.exec(prompt)?.[1]?.trim()
const mode = /\[fake-claude: ([^\]]+)\]/.exec(prompt)?.[1]?.trim() ?? 'good'
let earlier = 0
if (log) {
  earlier = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0
  fs.appendFileSync(
    log,
    `${JSON.stringify({ argv: process.argv.slice(2), stdin: prompt, pid: process.pid })}\n`,
  )
}

const all = ['Done', 'In progress', 'Blocked / needs you', 'Pushed today', 'Next']
const report = (headings) =>
  `${headings.map((h) => `## ${h}\n\n- (written from a prompt of ${prompt.length} characters)`).join('\n\n')}\n`
const bad = () => report(all.filter((h) => h !== 'Next'))

if (mode === 'fail') {
  process.stderr.write('fake-claude: asked to fail\n')
  process.exit(3)
} else if (mode === 'bad') process.stdout.write(bad())
else if (mode === 'bad-then-good') process.stdout.write(earlier ? report(all) : bad())
else if (mode.startsWith('slow')) {
  await new Promise((resolve) => setTimeout(resolve, Number(mode.split(/\s+/)[1] ?? 5000)))
  process.stdout.write(report(all))
} else process.stdout.write(report(all))
