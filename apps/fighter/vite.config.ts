import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    // Keep in sync with the justfile (fighter = 5184). 5183 is the arcade.
    port: 5184,
    strictPort: true,
    host: true,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
  },
})
