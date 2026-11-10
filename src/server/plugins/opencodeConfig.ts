import { definePlugin } from 'nitro'

import { checkOpencodeConfig } from '../opencodeConfig'
import { listRepos } from '../repos'

// Whether OpenCode may run subagents from subagents (experimental.subagent_depth): checked once as the
// server starts, in the background. GET /api/agent-setup waits for it when asked before it ends, and
// POST /api/agent-setup/opencode-check checks again after the human edits the config.
export default definePlugin(() => {
  void checkOpencodeConfig(listRepos().map((r) => r.repoPath))
})
