// What the primary strip's shader is actually fed: uniforms, textures, and the canopy attribute.
//   PORT=5185 node probes/corridor-stripstate.mjs <stance url>
import { chromium } from 'playwright'
const [, , url] = process.argv
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 800, height: 500 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 300000 })
console.log(await page.evaluate(() => {
  const site = window.corridor.site
  const out = []
  site.group.traverse((o) => {
    if (o.name !== 'strip') return
    const u = o.userData?.uniforms
    const g = o.geometry
    const n = g.getAttribute('position').count
    const can = g.getAttribute('aCanopy'), edge = g.getAttribute('aEdge')
    const stat = (a) => { if (!a) return null; const v = Array.from(a.array).sort((p, q) => p - q); return { min: +v[0].toFixed(2), p50: +v[v.length >> 1].toFixed(2), p90: +v[(v.length * 0.9) | 0].toFixed(2), max: +v[v.length - 1].toFixed(2) } }
    // share of vertices in the rough zone (8..22 m) whose canopy > 3 m
    let rough = 0, roughCanopy = 0
    if (can && edge) for (let i = 0; i < n; i++) { const e = edge.array[i]; if (e > 9.5 && e < 18) { rough++; if (can.array[i] > 3) roughCanopy++ } }
    const tx = (t) => t ? { cls: t.constructor.name, w: t.image?.width ?? t.image?.naturalWidth, h: t.image?.height ?? t.image?.naturalHeight, complete: t.image?.complete } : null
    out.push({ verts: n, userDataKeys: Object.keys(o.userData || {}), hasGrass: u?.hasGrass?.value, hasForest: u?.hasForest?.value, mown: u && tx(u.grassMown.value), rough: u && tx(u.grassRough.value), floor: u && tx(u.forestFloor.value), litterTint: u && '#' + u.litterTint.value.getHexString(), litterSpread: u?.litterSpread?.value, aCanopy: stat(can), aEdge: stat(edge), roughZoneVerts: rough, roughZoneUnderCanopy: roughCanopy, map: tx(o.material.map) })
  })
  // the primary is the big one; the branches are all alike
  out.sort((a, b) => b.verts - a.verts)
  return JSON.stringify({ strips: out.length, primary: out[0], typicalBranch: out[Math.floor(out.length / 2)] }, null, 1)
}))
await browser.close()
