import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'conduit',
    include: ['test/**/*.test.ts'],
  },
})
