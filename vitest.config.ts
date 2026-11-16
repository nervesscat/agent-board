import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs', 'desktop/**/*.test.mjs'],
    // Server test files set up a store in beforeAll; on the shared CI runner that setup can take
    // longer than vitest's 10 s default hook timeout under load. Assertions are unchanged.
    hookTimeout: 30000,
  },
})
