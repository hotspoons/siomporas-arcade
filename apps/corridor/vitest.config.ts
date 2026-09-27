import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'corridor',
    include: ['test/**/*.test.ts'],
  },
})
