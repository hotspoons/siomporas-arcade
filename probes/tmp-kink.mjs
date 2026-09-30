// What the lane does where the car is thrown: slope, slope CHANGE, and the ribbon's own triangles.
import { chromium } from 'playwright'
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 700, height: 500 } })
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)))
await p.goto('http://127.0.0.1:5185/index.html#bowie-racetrack-rd', { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.__apex?.site, null, { timeout: 240000 })
await p.waitForTimeout(5000)
console.log(JSON.stringify(await p.evaluate(async () => {
  const { fixturePath, ribbonGeometry } = await import('/src/stunts.ts')
  const f = { id: 'k', name: 'k', piece: 'loop', at: [0, 0], yaw_deg: 0 }
  const path = fixturePath(f, 96, 0)
  const rows = []
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], c = path[i]
    const run = Math.hypot(c.x - a.x, c.y - a.y)
    const slope = (Math.atan2(c.z - a.z, run) * 180) / Math.PI
    rows.push({ i, s: +run.toFixed(2), z: +c.z.toFixed(2), slope: +slope.toFixed(1) })
  }
  // the biggest slope CHANGE between consecutive samples, which is the kink
  let worst = { i: 0, d: 0 }
  for (let i = 1; i < rows.length; i++) {
    const d = Math.abs(rows[i].slope - rows[i - 1].slope)
    if (d > worst.d) worst = { i: rows[i].i, d: +d.toFixed(1), from: rows[i - 1].slope, to: rows[i].slope, s: rows[i].s }
  }
  // and whether the ribbon itself is well formed there: triangle areas and normals
  const g = ribbonGeometry(path, 5)
  const tri = []
  const P = (k) => [g.positions[k * 3], g.positions[k * 3 + 1], g.positions[k * 3 + 2]]
  let degenerate = 0
  for (let t = 0; t < g.indices.length; t += 3) {
    const a = P(g.indices[t]), c = P(g.indices[t + 1]), d = P(g.indices[t + 2])
    const u = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]]
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const area = Math.hypot(...n) / 2
    if (area < 0.01) degenerate++
    if (t / 3 >= 8 && t / 3 <= 24) tri.push(+area.toFixed(2))
  }
  return { first: rows.slice(0, 16), worst, degenerate, triangles: g.indices.length / 3, areasNearEntry: tri }
}), null, 1))
await b.close()
