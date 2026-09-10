import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'stuntin',
    include: ['test/**/*.test.ts'],
  },
})
