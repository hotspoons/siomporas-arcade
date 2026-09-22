import { createReadStream, existsSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { resolve, extname, normalize } from 'node:path'
import { createGzip } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { devBridge } from '@apex/engine/dev/bridge-plugin'

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
        // placements.json, structures.json, dead_ends.json — never anything the bake itself
        // produced. Whitelisted by name.
        //
        // `tuning` is the per-site knob override file (src/sitetuning.ts). The editor-knobs lane
        // built the whole save path and could not ship it because this one word was missing and
        // this file was not theirs to edit — their error message names the fix exactly.
        //
        // `dead_ends` is Rich's third editor ask, keyed on the OSM NODE ID rather than on `s` or a
        // chain id: the node id is in every dead_ends entry the bake emits and it survives a
        // re-bake, a re-chaining and a change of chain set, which stations and chain ids do not.
        if (req.method === 'PUT' && prefix === '/sites/' && /^[a-z0-9-]+\/(adjustments|placements|structures|dead_ends|tuning)\.json$/.test(rel.replaceAll('\\', '/'))) {
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
        // JSON goes over the wire compressed. crofton-triangle's manifest is 6.5 MB of it, and
        // uncompressed it was 1 348 ms of the load against 13 ms to parse — transfer, not compute.
        // The PNG/JPEG rasters are already compressed; gzipping them again only burns CPU.
        const gz = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) && /\.(json|geojson)$/.test(file)
        if (gz) {
          res.setHeader('Content-Encoding', 'gzip')
          res.setHeader('Vary', 'Accept-Encoding')
          createReadStream(file).pipe(createGzip()).pipe(res)
          return
        }
        createReadStream(file).pipe(res)
      })
    },
  }
}

export default defineConfig({
  // devBridge is inert unless APEX_BRIDGE is set, and can never reach a build — see
  // packages/engine/src/dev/bridge-plugin.ts. `just bridge-dev corridor` turns it on.
  plugins: [serveBake(), devBridge()],
  server: {
    // Keep in sync with the justfile (corridor viewer = 5185). CORRIDOR_PORT lets a second dev
    // server run this same app on another port — the world-editor lane runs it on 5212 against a
    // worldeditor service — without either of them having to edit this file again.
    port: Number(process.env.CORRIDOR_PORT ?? 5185),
    strictPort: true,
    host: true,
    allowedHosts: true,
    // DEV ONLY, and only when WORLDEDITOR is set. `tools/worldeditor` serves these paths in the
    // pod, from the same origin as the app; this makes development identical to that, so the
    // world editor's fetches are relative in both places and there is no CORS anywhere.
    ...(process.env.WORLDEDITOR ? { proxy: { '/api': process.env.WORLDEDITOR, '/assetsvc': process.env.WORLDEDITOR } } : {}),
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    // three pages: the viewer, the editor (apps/corridor/editor.html, owned by the editor agent)
    // and the world editor (world.html) — which is the one `tools/worldeditor` serves at `/`.
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        editor: fileURLToPath(new URL('editor.html', import.meta.url)),
        world: fileURLToPath(new URL('world.html', import.meta.url)),
      },
    },
  },
})
