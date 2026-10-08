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
  // gaussian splat worlds: a capture is not part of a site's bake, it is attached to one
  // (docs/corridor/PLAN-SPLAT-CORRIDORS.md)
  '/splats/': resolve(here, '../../tools/corridor/data/splats'),
  // levels: a world dressed and given something to do. The world editor writes these to its
  // volume; in dev they are beside the sites, and without this line a fetch for one gets the
  // SPA fallback -- HTTP 200 and index.html -- which is not a missing file, it is a worse one.
  '/levels/': resolve(here, '../../tools/corridor/data/levels'),
}
const types: Record<string, string> = {
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.geojson': 'application/geo+json',
  '.tif': 'image/tiff',
  '.laz': 'application/vnd.laszip',
  '.ply': 'application/octet-stream',
  '.spz': 'application/octet-stream',
  '.ksplat': 'application/octet-stream',
}

/** localhost and 127.0.0.1 are this machine. Anything else is another install. */
function localOrigin(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return false
  }
}

/**
 * What Vite forwards.
 *
 * Local `WORLDEDITOR` (the service on :8780) gets the editor's own state: worlds, runs, the bake,
 * levels, and the placeable catalog. A remote `WORLDEDITOR` is the cluster, and the only thing
 * forwarded there is `/assetsvc` — drawing and reconstruction. `/api` still goes to the local
 * service.
 *
 * `WORLDEDITOR_REMOTE` is the third shape, and it is the one to reach for when profiling: the
 * local page against a deployed cluster as if it were the pod. Everything the pod serves from one
 * origin — the bake (`/sites`), levels, photos, splats, the asset service and its catalogue — goes
 * to that host. `/assets/` stays local: the Draco decoder and the shipped kit live in this tree
 * and there is no reason to pull them over the wire. Nothing local answers for a bake, so what the
 * page shows is exactly what the cluster holds. See `just corridor-remote`.
 */
function proxyFor(worldeditor: string | undefined, remote: string | undefined): { proxy?: Record<string, { target: string; ws?: boolean; changeOrigin: boolean }> } {
  if (remote) {
    const plain = { target: remote, changeOrigin: true }
    return {
      proxy: {
        '/api': { target: remote, ws: true, changeOrigin: true },
        '/sites': plain,
        '/levels': plain,
        '/photos': plain,
        '/splats': plain,
        '/assetsvc': plain,
        '/assets/catalog.json': plain,
      },
    }
  }
  if (!worldeditor) return {}
  const local = localOrigin(worldeditor)
  const api = local ? worldeditor : 'http://127.0.0.1:8780'
  return {
    proxy: {
      '/api': { target: api, ws: true, changeOrigin: true },
      '/assetsvc': { target: worldeditor, changeOrigin: true },
      ...(local
        ? {
            '/sites': { target: worldeditor, changeOrigin: true },
            '/levels': { target: worldeditor, changeOrigin: true },
            // The placeable catalog only. `/assets` as a whole stays here: the Draco decoder and
            // the shipped models live under it, and a static public/assets/catalog.json never
            // hears about a tick in the asset library.
            '/assets/catalog.json': { target: worldeditor, changeOrigin: true },
          }
        : {}),
    },
  }
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
        // `presets` is the world's named library of look snapshots — the keyframes a level and a
        // program tween between (src/presets.ts). Same shape of file as `tuning`, same lifetime as
        // the world, so it lives beside it rather than in a service.
        //
        // `dead_ends` is Rich's third editor ask, keyed on the OSM NODE ID rather than on `s` or a
        // chain id: the node id is in every dead_ends entry the bake emits and it survives a
        // re-bake, a re-chaining and a change of chain set, which stations and chain ids do not.
        //
        // `courses` is the circuits and stages — gates you cross, in order (src/races.ts).
        //
        // `stunts` is the loops, corkscrews and banked turns standing on the road (src/stunts.ts).
        // A fixture REPLACES a stretch of the baked road rather than correcting it, which is why it
        // is not an adjustment either.
        //
        // `zones` is gameplay bounds — traffic areas today, race gates next (src/zones.ts). NOT in
        // `adjustments.json` although it is the same polygon: an adjustment says the bake got it
        // wrong and is true for every game played on that ground, while a traffic zone belongs to
        // one level, and a rally stage and a delivery game want different answers in the same
        // field. The pod-side twin of this list is `AUTHORED` in tools/worldeditor/store.mjs.
        if (req.method === 'PUT' && prefix === '/sites/' && /^[a-z0-9-]+\/(adjustments|placements|structures|dead_ends|tuning|presets|zones|stunts|courses|fixtures|surfaces|points)\.json$/.test(rel.replaceAll('\\', '/'))) {
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
          // A local world editor owns the bake. Let that proxy answer a file this middleware
          // does not have. A remote WORLDEDITOR is the cluster, and falling through to it is how
          // a missing local file was replaced by the cluster's bake of the same slug.
          if (process.env.WORLDEDITOR && localOrigin(process.env.WORLDEDITOR)) return next()
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
  plugins: [...(process.env.WORLDEDITOR_REMOTE ? [] : [serveBake()]), devBridge()],
  server: {
    // Keep in sync with the justfile (corridor viewer = 5185). CORRIDOR_PORT lets a second dev
    // server run this same app on another port — the world-editor lane runs it on 5212 against a
    // worldeditor service — without either of them having to edit this file again.
    port: Number(process.env.CORRIDOR_PORT ?? 5185),
    strictPort: true,
    host: true,
    allowedHosts: true,
    // With the operator bridge on, let the page profile itself: the JS Self-Profiling API
    // (`new Profiler(...)`) needs this document policy, and it is how a bridge probe gets a real
    // sampled call-stack profile of Rich's tab instead of wrapping functions one at a time
    // (2026-10-08). Dev and bridge only; a build never sees it.
    ...(process.env.APEX_BRIDGE ? { headers: { 'Document-Policy': 'js-profiling' } } : {}),
    // DEV ONLY, and only when WORLDEDITOR is set. `tools/worldeditor` serves these paths in the
    // pod, from the same origin as the app; this makes development identical to that, so the
    // world editor's fetches are relative in both places and there is no CORS anywhere.
    /*
     * `ws: true` IS NOT OPTIONAL, and the short form does not imply it.
     *
     * `{ '/api': url }` proxies HTTP and drops the WebSocket upgrade on the floor — no error, the
     * socket simply never opens. The MCP bridge dials `/api/agent/bridge` from `location.origin`,
     * which in development is Vite rather than the service, so every browser tool ("run this in
     * the editor's shell", "what does TypeScript say about this file") came back as "no editor is
     * attached" while an editor sat attached to nothing. In the pod there is no proxy — the world
     * editor serves the page and the socket from one origin — so this is a development-only hole,
     * which is the kind that stays open longest.
     *
     * A REMOTE WORLDEDITOR IS ASSETSVC ONLY.
     *
     * Worlds, runs, levels and the bake are this machine's. Pointing `/api` and `/sites` at the
     * cluster listed the cluster's worlds and then drew them with this machine's bake of the same
     * slug — two crofton-triangles, one map. Image generation and reconstruction stay on that
     * host, because those GPUs are not here. `WORLDEDITOR=http://localhost:8780` is the local
     * service and still receives the whole set.
     */
    ...proxyFor(process.env.WORLDEDITOR, process.env.WORLDEDITOR_REMOTE),
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
