// The published corridor: the built viewer as static assets, the world's data out of R2.
//
// This file is uploaded as the Worker's one module by `tools/worldeditor/deploy.mjs`. It knows
// two things: which paths the viewer asks its own origin for that are DATA (the bake, the docs,
// the levels, the assets it uses), and that everything else is the app. The data lives in the
// bucket under `env.PREFIX` (one deploy, one prefix, so old revisions can be deleted whole),
// keyed by the same path the viewer would have asked the world editor for — so the viewer is
// deployed unchanged and never knows it is not talking to the editor.
//
// It is READ ONLY. The editor's saves are PUTs to `/sites/<slug>/<doc>.json`; here they get a
// 405 that says where to go, rather than a 404 that looks like a lost file.
//
// AND IT CACHES. R2 charges per read (Class B operations, ten million a month free, then a few
// cents a million), and a world is a few hundred tiles per player per session. Every object
// read from the bucket is put in the Cloudflare cache under the request URL (the Cache API,
// `caches.default`), so the next player in the same data centre — and with Tiered Cache on, in
// the same region — is served from the edge and the bucket is not read at all. The tiles under
// `web/` are immutable for a year; the documents for a minute, so an edit and a redeploy under
// the same prefix show up. Rich, 2026-09-30: "is there a way we can use their CDN as a pull
// through cache to minimize the cost?" — this is it; the rest is a dashboard switch (see
// docs/corridor/CLOUDFLARE.md).

const DATA = ['/sites/', '/levels/', '/assetsvc/', '/api/']

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** the R2 key for a request path, or null when the path is the app's own */
export function keyFor(pathname) {
  if (pathname === '/assets/catalog.json') return 'assets/catalog.json'
  if (pathname === '/api/levels') return 'api/levels'
  if (pathname.startsWith('/api/levels/')) return `levels/${pathname.slice('/api/levels/'.length)}.json`
  if (pathname.startsWith('/api/programs/')) return pathname.slice(1)
  if (pathname.startsWith('/sites/') || pathname.startsWith('/levels/') || pathname.startsWith('/assetsvc/')) return pathname.slice(1)
  return null
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url)
    const p = url.pathname
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (DATA.some((d) => p.startsWith(d)) || p === '/assets/catalog.json') return json(405, { error: 'this is a published copy of the world; edit it in the world editor and deploy again' })
    }
    const key = keyFor(p)
    if (key !== null) {
      let decoded
      try {
        decoded = key.split('/').map(decodeURIComponent).join('/')
      } catch {
        return json(400, { error: 'bad path', path: p })
      }
      // the edge first: the same URL served here before is served again without a bucket read
      const cache = typeof caches !== 'undefined' ? caches.default : null
      const cacheKey = new Request(`${url.origin}${p}`, { method: 'GET' })
      if (cache) {
        const hit = await cache.match(cacheKey)
        if (hit) return req.method === 'HEAD' ? new Response(null, { headers: hit.headers }) : hit
      }
      const obj = await env.DATA.get(`${env.PREFIX}/${decoded}`)
      if (!obj) return json(404, { error: 'not found', path: p })
      const headers = new Headers()
      obj.writeHttpMetadata(headers)
      headers.set('etag', obj.httpEtag)
      // the bake's tiles never change under a prefix; the docs might be redeployed under the same one
      headers.set('cache-control', decoded.includes('/web/') ? 'public, max-age=31536000, immutable' : 'public, max-age=60')
      const res = new Response(obj.body, { headers })
      if (cache && ctx?.waitUntil) ctx.waitUntil(cache.put(cacheKey, res.clone()))
      return req.method === 'HEAD' ? new Response(null, { headers }) : res
    }
    if (p.startsWith('/api/')) return json(404, { error: 'no such API in a published world', path: p })
    return env.ASSETS.fetch(req)
  },
}
