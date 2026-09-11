import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'fighter',
    include: ['test/**/*.test.ts'],
  },
})
