import { createReadStream, existsSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { resolve, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

// The viewer reads the SAME layout the Worker will serve from R2: /sites/index.json and
// /sites/<slug>/web/*. In dev those come straight off tools/corridor/data, so nothing is copied
// into the app and a fresh bake is visible on reload. The photos are served beside them so the
// info panel can show what was actually seen at each site.
const here = fileURLToPath(new URL('.', import.meta.url))
const roots: Record<string, string> = {
  '/sites/': resolve(here, '../../tools/corridor/data/sites'),
  '/photos/': resolve(here, '../../ext/ref-driving/small'),
}
const types: Record<string, string> = {
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.geojson': 'application/geo+json',
  '.tif': 'image/tiff',
  '.laz': 'application/vnd.laszip',
}

function serveBake(): Plugin {
  return {
    name: 'corridor-serve-bake',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0]
        const prefix = Object.keys(roots).find((p) => url.startsWith(p))
        if (!prefix) return next()
        const rel = normalize(decodeURIComponent(url.slice(prefix.length)))
        if (rel.startsWith('..')) return next()
        const file = resolve(roots[prefix], rel)
        // DEV ONLY: the editor writes authored JSON back beside the bake — adjustments.json,
        // placements.json — never anything the bake itself produced. Whitelisted by name.
        if (req.method === 'PUT' && prefix === '/sites/' && /^[a-z0-9-]+\/(adjustments|placements)\.json$/.test(rel.replaceAll('\\', '/'))) {
          const chunks: Buffer[] = []
          req.on('data', (c) => chunks.push(c))
          req.on('end', () => {
            try {
              const body = Buffer.concat(chunks).toString('utf8')
              JSON.parse(body) // must be JSON
              writeFileSync(file + '.tmp', body)
              renameSync(file + '.tmp', file)
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: true, bytes: body.length }))
            } catch (e) {
              res.statusCode = 400
              res.end(JSON.stringify({ ok: false, error: String(e) }))
            }
          })
          return
        }
        if (!file.startsWith(roots[prefix])) return next()
        if (!existsSync(file) || !statSync(file).isFile()) {
          // never fall through to Vite's SPA fallback: an optional JSON that does not exist yet must
          // be a 404, not index.html with a 200 (both agents lost time to `r.json()` on '<!doctype')
          res.statusCode = 404
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: 'not found', path: url }))
          return
        }
        res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream')
        res.setHeader('Cache-Control', 'no-cache')
        createReadStream(file).pipe(res)
      })
    },
  }
}

export default defineConfig({
  plugins: [serveBake()],
  server: {
    // Keep in sync with the justfile (corridor viewer = 5185).
    port: 5185,
    strictPort: true,
    host: true,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    // two pages: the viewer and the editor (apps/corridor/editor.html, owned by the editor agent)
    rollupOptions: { input: { main: fileURLToPath(new URL('index.html', import.meta.url)), editor: fileURLToPath(new URL('editor.html', import.meta.url)) } },
  },
})
