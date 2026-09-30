import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'stunt-pieces',
    include: ['test/**/*.test.ts'],
  },
})
