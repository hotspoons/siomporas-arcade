// The bench is served from its own root so the package has no build step of its own: the game
// imports src/*.ts directly and the app that embeds it does the bundling.
import { defineConfig } from 'vite'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  server: { port: 5198, strictPort: true, host: true },
})
