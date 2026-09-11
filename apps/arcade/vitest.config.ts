import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'arcade',
    include: ['test/**/*.test.ts'],
  },
})
