import { defineConfig } from 'vite'
import { devBridge } from '@apex/engine/dev/bridge-plugin'

export default defineConfig({
  // devBridge is inert unless APEX_BRIDGE is set — see packages/engine/src/dev/bridge-plugin.ts.
  plugins: [devBridge()],
  server: {
    // Keep in sync with the justfile (arcade = 5183).
    port: 5183,
    strictPort: true,
    host: true,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    // three and @apex/engine are shared by the lobby and all three games, so rollup hoists them
    // into one chunk every route depends on. Each game's own code stays in its own lazy chunk —
    // which is the whole point of the arcade, so it is worth checking after a dependency change
    // that this is still what comes out.
    chunkSizeWarningLimit: 1800,
  },
})
