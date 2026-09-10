import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { devBridge } from '@apex/engine/dev/bridge-plugin'

export default defineConfig({
  // devBridge is inert unless APEX_BRIDGE is set — see packages/engine/src/dev/bridge-plugin.ts.
  plugins: [devBridge()],
  server: {
    // Keep in sync with the justfile (coast = 5182).
    port: 5182,
    strictPort: true,
    host: true,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      // Two pages: the game, and the model viewer at /model.html.
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        model: fileURLToPath(new URL('model.html', import.meta.url)),
      },
    },
  },
})
