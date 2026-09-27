#!/usr/bin/env node
// A browser viewer for the library that scans itself.
//
//   node ext/assetlib/tool/serve.mjs                 # http://localhost:5199
//   node ext/assetlib/tool/serve.mjs --tunnel        # ...and a public trycloudflare URL
//
// It lists whatever is on disk RIGHT NOW and re-scans on every poll, so a batch that is still
// running fills the gallery as it goes — no restart, no rebuild, no manifest to keep in step.
//
// Everything is served from node_modules and the repo: three, its addons, and the vendored Draco
// decoder the corridor viewer already ships. A DRACOLoader is mandatory — finish.mjs emits Draco
// and GLTFLoader does not warn when it cannot decode, it rejects, so the page reports the failure
// loudly rather than showing an empty stage that looks like a bad reconstruction.

import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIB = path.resolve(HERE, '..')
const ROOT = path.resolve(LIB, '../..')
const OUT = path.join(LIB, 'out')

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i === -1 ? d : process.argv[i + 1] }
const PORT = Number(arg('port', 5199))

const TYPES = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.json': 'application/json', '.html': 'text/html; charset=utf-8', '.css': 'text/css',
}

/** Scan the output directory. Cheap enough to redo on every poll, which is what keeps it live. */
function scan() {
  if (!existsSync(OUT)) return []
  return readdirSync(OUT)
    .filter((d) => !d.startsWith('_') && statSync(path.join(OUT, d)).isDirectory())
    .map((id) => {
      const dir = path.join(OUT, id)
      const has = (f) => existsSync(path.join(dir, f))
      const size = (f) => (has(f) ? statSync(path.join(dir, f)).size : 0)
      let meta = {}
      try { meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')) } catch { /* mid-write */ }
      return {
        id,
        class: meta.class ?? 'unknown',
        subject: meta.subject ?? '',
        chroma: meta.chroma,
        prompt: meta.prompt,
        view: meta.view,
        key: meta.key,
        mesh: meta.mesh,
        finished: meta.finished,
        thumb: has('view-1-keyed.png') ? `out/${id}/view-1-keyed.png` : has('view-1.png') ? `out/${id}/view-1.png` : null,
        raw: has('view-1.png') ? `out/${id}/view-1.png` : null,
        glb: has(`${id}-finished.glb`) ? `out/${id}/${id}-finished.glb` : null,
        // A glass.mjs variant, when one has been made: the glazing split out into a real
        // KHR_materials_transmission material instead of a dark painted panel.
        glbGlass: has(`${id}-glass-finished.glb`) ? `out/${id}/${id}-glass-finished.glb` : null,
        glbRaw: has(`${id}.glb`) ? `out/${id}/${id}.glb` : null,
        bytes: size(`${id}-finished.glb`),
        state: has(`${id}-finished.glb`) ? 'ready' : has('view-1-keyed.png') ? 'meshing' : 'drawing',
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

// Read per request, not once at startup. Caching it in a const meant every edit to the page
// needed a server restart to take effect — and because the stale page still WORKED, three
// successive fixes appeared to do nothing and were nearly re-debugged from scratch. The file is
// a few kilobytes; there is no reason to hold it.
const PAGE = () => readFileSync(path.join(HERE, 'viewer.html'), 'utf8')

// Map a request path onto a file, or null. Kept explicit: this serves out of node_modules and the
// repo, so a path that escapes ROOT must not resolve.
function resolveFile(pathname) {
  const p = decodeURIComponent(pathname)
  if (p.startsWith('/out/')) return path.join(LIB, p)
  if (p.startsWith('/surfaces/')) return path.join(LIB, p)
  if (p.startsWith('/vendor/three/addons/')) return path.join(ROOT, 'node_modules/three/examples/jsm', p.slice('/vendor/three/addons/'.length))
  if (p.startsWith('/vendor/three/build/')) return path.join(ROOT, 'node_modules/three/build', p.slice('/vendor/three/build/'.length))
  if (p.startsWith('/vendor/draco/')) return path.join(ROOT, 'apps/corridor/public/assets/vendor/draco', p.slice('/vendor/draco/'.length))
  return null
}

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' })
    return res.end(PAGE())
  }
  if (u.pathname === '/api/materials') {
    res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' })
    const f = path.join(LIB, 'surfaces', 'materials.json')
    return res.end(existsSync(f) ? readFileSync(f) : '{"materials":[]}')
  }
  if (u.pathname === '/api/assets') {
    res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' })
    return res.end(JSON.stringify(scan()))
  }
  const f = resolveFile(u.pathname)
  const safe = f && (f.startsWith(LIB) || f.startsWith(path.join(ROOT, 'node_modules')) || f.startsWith(path.join(ROOT, 'apps')))
  if (!safe || !existsSync(f) || statSync(f).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    return res.end('not found')
  }
  res.writeHead(200, {
    'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream',
    // The glbs are rewritten in place by --redo; never let a browser cache a stale one.
    'cache-control': path.extname(f) === '.glb' ? 'no-store' : 'public, max-age=3600',
  })
  res.end(readFileSync(f))
})

server.listen(PORT, () => {
  console.log(`assetlib viewer  http://localhost:${PORT}   (${scan().length} assets on disk)`)
  if (process.argv.includes('--tunnel')) {
    // Same shape as scripts/tunnel.sh: a quick tunnel, and the URL written where scripts can read it.
    const cf = execFile('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'])
    const seen = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/
    const onLine = (buf) => {
      const m = String(buf).match(seen)
      if (m && !server._url) {
        server._url = m[0]
        writeFileSync(path.join(ROOT, '.tunnel-url.assetlib'), `${m[0]}\n`)
        console.log(`\n  ➜  TUNNEL: ${m[0]}\n`)
      }
    }
    cf.stdout.on('data', onLine)
    cf.stderr.on('data', onLine)
    cf.on('error', (e) => console.error(`cloudflared: ${e.message} — is it installed?`))
  }
})
