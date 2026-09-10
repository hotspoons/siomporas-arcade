import { defineConfig } from 'vite'
import { devBridge } from '@apex/engine/dev/bridge-plugin'

export default defineConfig({
  // devBridge is inert unless APEX_BRIDGE is set — see packages/engine/src/dev/bridge-plugin.ts.
  plugins: [devBridge()],
  server: {
    // Keep in sync with the justfile (stuntin = 5181).
    port: 5181,
    strictPort: true,
    host: true,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
})
