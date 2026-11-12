import os from 'node:os'
import path from 'node:path'

import { defineConfig, devices } from '@playwright/test'

import { HUMAN, e2eEnv } from './e2e/env'

/**
 * The e2e suite drives a built board in test mode (README: "Test mode"): sign-in off, on a free
 * loopback port above 47140, with its data in a throwaway folder. The build goes to .output-e2e, never
 * .output, so running this in the main checkout leaves the live board's build alone. E2E_SKIP_BUILD=1
 * reuses the last .output-e2e (CI builds it in the step before).
 */
const env = e2eEnv()
const build = process.env.E2E_SKIP_BUILD ? '' : 'pnpm build --logLevel error && '
const tailscaleEnv = { TAILSCALE_BIN: env.tailscaleBin, FAKE_TAILSCALE_STATE: env.tailscaleState }

/** What a test-mode board runs with: its port, its data, the fake claude; never the shell's own settings. */
const boardEnv = (port: number, baseURL: string, dataDir: string) => ({
  BOARD_BUILD_DIR: '.output-e2e',
  BOARD_ENV: 'test',
  TEST_HUMAN: HUMAN,
  HOST: '127.0.0.1',
  PORT: String(port),
  // Nitro reads these before HOST and PORT: never inherit them from the shell.
  NITRO_HOST: '127.0.0.1',
  NITRO_PORT: String(port),
  BOARD_URL: baseURL,
  DATA_DIR: dataDir,
  // The board's own home, so the board skill's install lands in the run's folder, never the real home.
  HOME: env.home,
  USERPROFILE: env.home,
  CLAUDE_HOME: env.claudeHome,
  // OpenCode's config sources this run controls: its global folder, and no $OPENCODE_CONFIG of the shell.
  XDG_CONFIG_HOME: env.opencodeConfigHome,
  OPENCODE_CONFIG: '',
  STORAGE: 'local',
  // claude is a stand-in that reads the prompt from stdin and answers with a report.
  CLAUDE_BIN: process.execPath,
  CLAUDE_ARGS: JSON.stringify([path.resolve('e2e/fake-claude.mjs')]),
})

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // The suite's 497 tests no longer fit the job at 2 workers on the shared self-hosted 12-core runner;
  // capped at 4, so a 2-core hosted runner stays at 2.
  workers: process.env.CI ? Math.min(4, Math.max(2, os.cpus().length)) : 4,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  // Every run the board runs counts against one board-wide preview limit, which some tests change: the
  // tests that start runs or change it (tagged BOARD_RUNS) run one at a time, beside the rest.
  projects: [
    { name: 'e2e', grepInvert: /@board-runs/ },
    { name: 'board-runs', grep: /@board-runs/, workers: 1 },
  ],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: env.baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Two test-mode boards: the second one has PUBLIC_ORIGIN in its environment (Settings shows it set by env).
  // Both read the fake Tailscale CLI (e2e/fake-tailscale.mjs), never the real one.
  webServer: [
    {
      command: `${build}node .output-e2e/server/index.mjs`,
      url: `${env.baseURL}/api/me`,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        ...boardEnv(env.port, env.baseURL, env.dataDir),
        ...tailscaleEnv,
      },
    },
    {
      command: 'node .output-e2e/server/index.mjs',
      url: `${env.envBaseURL}/api/me`,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        ...boardEnv(env.envPort, env.envBaseURL, env.envDataDir),
        PUBLIC_ORIGIN: 'https://envbox.example-tailnet.ts.net',
        ...tailscaleEnv,
      },
    },
  ],
})
