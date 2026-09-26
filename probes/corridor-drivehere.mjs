// "Drive here": a left click in fly mode should put the car where you pointed, on the road if
// there is one under the cursor, facing the way that road goes.
//   PORT=5185 node probes/corridor-drivehere.mjs [slug]
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-triangle'
const PORT = process.env.PORT ?? '5185'
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const p = await b.newPage({ viewport: { width: 900, height: 600 } })
p.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await p.route('**/@vite/client', (r) => r.abort())
await p.goto(`http://localhost:${PORT}/?lite=1&fresh#${slug}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.corridor?.site, null, { timeout: 600000 })
await p.waitForTimeout(3000)
let fails = 0
const ok = (what, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`); if (!cond) fails++ }
// A DETERMINISTIC VIEWPOINT. The top view frames whatever it frames; put the camera over a known
// stretch of the spine instead, the way applyStance does (position AND orbit target, or the orbit
// controls drag it back on the next frame).
await p.evaluate(() => {
  const { site, camera, orbit } = window.corridor
  const c = site.manifest.spine.coords
  const mid = c[Math.floor(c.length / 2)]
  const target = { x: mid[0], y: site.groundAt(mid[0], -mid[1]) ?? 0, z: -mid[1] }
  orbit.target.set(target.x, target.y, target.z)
  camera.position.set(target.x, target.y + 180, target.z + 60)
  camera.lookAt(orbit.target)
  orbit.update()
})
await p.waitForTimeout(2500)
ok('we are in fly mode', !(await p.evaluate(() => window.corridor.drive.on)))
// where does the centre of the screen point? ask the page, then click exactly there
const target = await p.evaluate(() => {
  const { site, camera, THREE } = window.corridor
  const ray = new THREE.Raycaster()
  ray.setFromCamera(new THREE.Vector2(0, 0), camera)
  const o = ray.ray.origin, d = ray.ray.direction
  for (let s = 5; s < 8000; s += 2) {
    const q = o.clone().addScaledVector(d, s)
    const g = site.groundAt(q.x, q.z)
    if (g !== null && q.y <= g) return { x: +q.x.toFixed(1), z: +q.z.toFixed(1), edge: site.edgeInfo(q.x, q.z) }
  }
  return null
})
ok('the middle of the view is over the ground', !!target, JSON.stringify(target && { x: target.x, z: target.z, d: +target.edge.d.toFixed(1) }))
await p.mouse.click(450, 300)
await p.waitForTimeout(1200)
const after = await p.evaluate(() => {
  const c = window.corridor.drive.car, site = window.corridor.site
  if (!c) return null
  const e = site.edgeInfo(c.pos.x, c.pos.z)
  return { on: window.corridor.drive.on, x: +c.pos.x.toFixed(1), z: +c.pos.z.toFixed(1), yaw: +c.yaw.toFixed(3), speed: c.speed, edge: +e.d.toFixed(2), who: e.who }
})
ok('clicking took the seat', after?.on === true, JSON.stringify(after))
ok('the car landed where the cursor pointed', target && after && Math.hypot(after.x - target.x, after.z - target.z) < 25, `click at ${target?.x},${target?.z} -> car at ${after?.x},${after?.z}`)
ok('it landed stationary', after?.speed === 0)
if (target && target.edge.d < 30) {
  ok('a click near a road puts the car ON the pavement', after.edge < 1.0, `${after.edge} m from the pavement edge (negative is on it)`)
  // "points along the road" against the BAKE's own geometry, not against the distance field: near
  // a junction the field is flat in every direction and proves nothing. Site frame is x east,
  // y north; the world's z is -y, so a segment (dx, dy) runs at atan2(-dy, dx) in car yaw.
  const road = await p.evaluate(({ x, z, yaw }) => {
    const m = window.corridor.site.manifest
    const sx = x, sy = -z
    let best = Infinity, bearing = 0
    const walk = (pts) => {
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1], [bx, by] = pts[i]
        const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1
        const u = Math.max(0, Math.min(1, ((sx - ax) * dx + (sy - ay) * dy) / L))
        const qx = ax + u * dx - sx, qy = ay + u * dy - sy
        const d = qx * qx + qy * qy
        if (d < best) { best = d; bearing = Math.atan2(-dy, dx) }
      }
    }
    walk(m.spine.coords)
    for (const b of m.branches ?? []) if (b.coords?.length > 1) walk(b.coords)
    const diff = Math.abs(((yaw - bearing + Math.PI * 3) % (Math.PI * 2)) - Math.PI)
    return { nearest_m: +Math.sqrt(best).toFixed(1), offDeg: +((Math.min(diff, Math.PI - diff) * 180) / Math.PI).toFixed(0) }
  }, after)
  ok('and points along it', road.offDeg < 20, `${road.offDeg}° off the centreline of the road ${road.nearest_m} m away`)
}
console.log(fails ? `FAIL ${fails}` : 'PASS')
await b.close()
process.exit(fails ? 1 : 0)
