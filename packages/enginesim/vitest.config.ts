import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'enginesim',
    include: ['test/**/*.test.ts'],
  },
})
