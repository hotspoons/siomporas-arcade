// A LOOK at one stop sign and one street-name post, from the kerb, on a box with no GPU.
//
//   PORT=5185 node probes/corridor-signshot.mjs <out-prefix>
//
// Finds the first placed stop sign (furniture:sign:stop, instance 0) and the nearest blade post,
// stands the camera 7 m in front of the sign at eye height looking at it, and shoots small. This
// exists because the counts said 572 signs faced the right way and none of them said the octagon
// was hung corner-up with no legend, or that the post ran through the middle of the street name.
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5185'
const SLUG = process.env.SLUG ?? 'crofton-triangle'
const OUT = process.argv[2] ?? '/tmp/sign-'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 900, height: 560 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction((slug) => window.corridor?.site?.manifest?.slug === slug, SLUG, { timeout: 600000 })
await page.keyboard.press('m')
const shots = ['sign', 'blades']
for (const which of shots) {
  const info = await page.evaluate((which) => {
    const c = window.corridor, site = c.site, THREE = c.THREE
    c.tune.set('GRASS_RADIUS', 30); c.tune.set('GRASS_SPRITE_RADIUS', 80); c.tune.set('GRASS_MOWN_PER_M2', 20); c.tune.set('GRASS_ROUGH_PER_M2', 10)
    let mesh = null
    site.group.traverse((o) => { if (!mesh && o.name === 'furniture:sign:stop') mesh = o })
    if (!mesh) return { error: 'no stop signs' }
    const m = new THREE.Matrix4(); mesh.getMatrixAt(0, m)
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3()
    m.decompose(pos, q, s)
    // the sign faces -Z in its own frame; stand in front of it, where the traffic it stops is
    const face = new THREE.Vector3(0, 0, -1).applyQuaternion(q)
    let target = pos.clone().add(new THREE.Vector3(0, 1.9, 0)), eye = pos.clone().add(face.clone().multiplyScalar(7)).add(new THREE.Vector3(0, 1.6, 0))
    if (which === 'blades') {
      // the nearest street-name post to this sign
      let best = null
      const bl = site.layers.blades
      const pg = bl?.children.find((o) => o.geometry?.getAttribute('position') && !o.material.map)
      if (pg) {
        const p = pg.geometry.getAttribute('position')
        for (let i = 0; i < p.count; i += 14) { const d = Math.hypot(p.getX(i) - pos.x, p.getZ(i) - pos.z); if (!best || d < best.d) best = { d, x: p.getX(i), z: p.getZ(i), y: p.getY(i) } }
      }
      if (best) {
        const gy = site.groundAt(best.x, best.z) ?? best.y
        target = new THREE.Vector3(best.x, gy + 3.0, best.z)
        eye = new THREE.Vector3(best.x + 5, gy + 2.2, best.z + 5)
      }
    }
    c.camera.position.copy(eye)
    c.orbit.target.copy(target)
    c.orbit.update()
    return { which, eye: eye.toArray().map((v) => +v.toFixed(1)), target: target.toArray().map((v) => +v.toFixed(1)) }
  }, which)
  console.log(which, JSON.stringify(info))
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${OUT}${which}.png`, timeout: 300000 })
}
await browser.close()
