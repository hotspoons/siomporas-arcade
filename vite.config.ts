import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { devBridge } from './dev/bridge-plugin.ts'

// https://vite.dev/config/
export default defineConfig({
  // devBridge is inert unless APEX_BRIDGE is set — see dev/bridge-plugin.ts.
  plugins: [react(), devBridge()],
  server: {
    // Keep in sync with forwardPorts in .devcontainer/devcontainer.json.
    port: 5180,
    strictPort: true,
    host: true,
    // tunnel hostnames rotate per-start; this is a dev tool
    allowedHosts: true,
  },
  build: {
    // three is ~1MB minified on its own — the default 500kB warning is pure
    // noise for a game that ships one big scene bundle.
    chunkSizeWarningLimit: 1500,
  },
})
