// Do two neighbouring terrain tiles meet? Reads the live meshes: the rim vertices of one tile's
// east edge against the next tile's west edge, and flags any vertex thrown somewhere absurd.
//   PORT=5185 node probes/corridor-tileseam.mjs <site url>
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
  const tiles = new Map()
  site.group.traverse((o) => { if (o.isMesh && /^terrain:\d+_\d+$/.test(o.name)) tiles.set(o.name, o) })
  const grid = (m) => { const p = m.geometry.getAttribute('position'); const n = p.count; const side = Math.round(Math.sqrt(n)); return { p, n, side } }
  const a = tiles.get('terrain:4_1'), b = tiles.get('terrain:5_1'), c = tiles.get('terrain:4_2')
  if (!a || !b) return JSON.stringify({ tiles: tiles.size, names: [...tiles.keys()].slice(0, 6) })
  const A = grid(a), B = grid(b)
  const col = (G, ci) => { const out = []; for (let r = 0; r < G.side; r++) { const i = r * G.side + ci; out.push([G.p.getX(i), G.p.getY(i), G.p.getZ(i)]) } return out }
  const east = col(A, A.side - 1), west = col(B, 0)
  const prevEast = col(A, A.side - 2)
  let absurd = 0, minY = Infinity, maxY = -Infinity
  for (const m of tiles.values()) { const p = m.geometry.getAttribute('position'); for (let i = 0; i < p.count; i++) { const y = p.getY(i); if (!Number.isFinite(y) || y < -5 || y > 200) absurd++; minY = Math.min(minY, y); maxY = Math.max(maxY, y) } }
  const dx = east.map((e, i) => +(west[i][0] - e[0]).toFixed(2))
  const dz = east.map((e, i) => +(west[i][2] - e[2]).toFixed(2))
  const dy = east.map((e, i) => +(west[i][1] - e[1]).toFixed(2))
  const stepX = east.map((e, i) => +(e[0] - prevEast[i][0]).toFixed(2))
  const q = (arr) => { const s = [...arr].sort((p, q) => p - q); return { min: s[0], med: s[s.length >> 1], max: s[s.length - 1] } }
  return JSON.stringify({ tiles: tiles.size, verts: A.n, side: A.side, eastRim: east.slice(0, 3), westRim: west.slice(0, 3), gapX: q(dx), gapZ: q(dz), dY: q(dy), lastColumnStepX: q(stepX), absurdVerts: absurd, yRange: [+minY.toFixed(1), +maxY.toFixed(1)] })
}))
await browser.close()
