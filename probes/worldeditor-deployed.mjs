// Is the DEPLOYED editor actually the build we just pushed?
//
//   node probes/worldeditor-deployed.mjs [https://host]
//
// Compare the bundle names it prints against apps/corridor/dist/assets after a local
// `npm run build -w apps/corridor`: vite's hashes are content hashes, so identical names mean
// identical bytes. That is the only check that cannot be satisfied by a stale cache.
//
// A green Actions run, a published digest and a Running pod are three things that can all be true
// while the browser is served something else. So this asks a browser, with the cache off, and
// compares against what the local tree builds.
import { chromium } from 'playwright'
const base = process.argv[2] ?? 'https://worldeditor.richard-siomporas.basedweights.com'
const b = await chromium.launch()
const p = await b.newPage()
p.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 160)))
const r = await p.goto(base + '/world.html', { waitUntil: 'domcontentloaded', timeout: 60000 })
console.log('world.html', r?.status(), JSON.stringify(await p.title()))
const info = await p.evaluate(async () => {
  const t = await (await fetch('/world.html', { cache: 'reload' })).text()
  const bundles = [...t.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1])
  const health = await fetch('/api/health', { cache: 'reload' }).then((x) => x.ok ? x.json() : x.status).catch((e) => String(e))
  return { bundles, health }
})
console.log(JSON.stringify(info, null, 1))
// The editor's own panels, as the page actually renders them.
await p.waitForTimeout(4000)
const modes = await p.evaluate(() => [...document.querySelectorAll('.seg, [data-value]')].map((n) => n.dataset?.value || n.textContent.trim()).filter(Boolean).slice(0, 20))
console.log('modes:', JSON.stringify(modes))
await b.close()
