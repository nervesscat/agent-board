import path from 'node:path'

import { defineConfig, devices } from '@playwright/test'

import { HUMAN, e2eEnv } from './e2e/env'

/**
 * The e2e suite drives a built board in test mode (README: "Test mode"): no passkey gate, on a free
 * loopback port above 47140, with its data in a throwaway folder. The build goes to .output-e2e, never
 * .output, so running this in the main checkout leaves the live board's build alone. E2E_SKIP_BUILD=1
 * reuses the last .output-e2e (CI builds it in the step before).
 */
const env = e2eEnv()
const build = process.env.E2E_SKIP_BUILD ? '' : 'pnpm build --logLevel error && '

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: process.env.CI ? 2 : 4,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: env.baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `${build}node .output-e2e/server/index.mjs`,
    url: `${env.baseURL}/api/me`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      BOARD_BUILD_DIR: '.output-e2e',
      BOARD_ENV: 'test',
      TEST_HUMAN: HUMAN,
      HOST: '127.0.0.1',
      PORT: String(env.port),
      // Nitro reads these before HOST and PORT: never inherit them from the shell.
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: String(env.port),
      BOARD_URL: env.baseURL,
      DATA_DIR: env.dataDir,
      CLAUDE_HOME: env.claudeHome,
      STORAGE: 'local',
      // claude is a stand-in that reads the prompt from stdin and answers with a report.
      CLAUDE_BIN: process.execPath,
      CLAUDE_ARGS: JSON.stringify([path.resolve('e2e/fake-claude.mjs')]),
    },
  },
})
