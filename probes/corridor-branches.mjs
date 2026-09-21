// Network branches: does a branch get asphalt, stations (edgeDistance < 0 on it) and a strip (groundAt from the strip)? 
// node probes/corridor-branches.mjs <slug> <bx> <by> out.png   (bx,by = a site point ON the branch, away from the junction)
import { chromium } from 'playwright'
const [,, slug, bx, by, out] = process.argv
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:5185/#${slug}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor?.site, null, { timeout: 240000 })
await page.waitForTimeout(1500)
console.log(await page.evaluate(([x, y]) => {
  const s = window.corridor.site, wz = -y
  const roads = []
  s.layers.road.traverse((o) => { if (o.isMesh) roads.push(o.name || o.type) })
  const e = s.edgeDistance(x, wz)
  const g = s.groundAt(x, wz), h = s.heightAt(x, y)
  const e2 = s.edgeDistance(x + 12, wz), g2 = s.groundAt(x + 12, wz), h2 = s.heightAt(x + 12, y)
  // fly camera to look along the branch from above the junction
  const cam = window.corridor.camera
  cam.position.set(x + 40, (g ?? h) + 25, wz + 40); cam.lookAt(x, g ?? h, wz)
  return JSON.stringify({ branches: s.manifest.branches?.length ?? 0, roadMeshes: roads.length, onBranch: { edgeDistance: +e.toFixed(2), groundAt: g && +g.toFixed(2), dem: +h.toFixed(2) }, besideBranch12m: { edgeDistance: +e2.toFixed(2), groundAt: g2 && +g2.toFixed(2), dem: +h2.toFixed(2) } })
}, [Number(bx), Number(by)]))
await page.waitForTimeout(2500)
await page.screenshot({ path: out, timeout: 120000, animations: 'disabled', caret: 'initial' }).catch((e) => console.log('screenshot failed:', String(e).slice(0, 80)))
await browser.close()
