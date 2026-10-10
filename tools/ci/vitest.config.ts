import { defineConfig } from 'vitest/config'

// The checks CI used to run as their own steps — the services' node:test suites and the linter —
// as a vitest project, so `npx vitest run` before a push runs them too (Rich, 2026-10-10: "add them
// so they are caught locally or disable the linter").
export default defineConfig({
  test: {
    name: 'checks',
    include: ['tools/ci/*.test.ts'],
    root: new URL('../..', import.meta.url).pathname,
    testTimeout: 180_000,
    maxConcurrency: 6,
  },
})
