// Stands in for the `claude` CLI in the e2e suite: the board runs it as `node e2e/fake-claude.mjs -p
// --output-format text` (CLAUDE_BIN and CLAUDE_ARGS, set in playwright.config.ts) and writes the prompt
// to its stdin. It reads the whole prompt and answers with a report that fills the default template.
let prompt = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) prompt += chunk

const headings = ['Done', 'In progress', 'Blocked / needs you', 'Pushed today', 'Next']
process.stdout.write(
  `${headings.map((h) => `## ${h}\n\n- (written from a prompt of ${prompt.length} characters)`).join('\n\n')}\n`,
)
