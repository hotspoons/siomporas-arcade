import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'drivin',
    include: ['test/**/*.test.ts'],
  },
})
