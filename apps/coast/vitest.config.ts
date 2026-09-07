import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'coast',
    include: ['test/**/*.test.ts'],
  },
})
