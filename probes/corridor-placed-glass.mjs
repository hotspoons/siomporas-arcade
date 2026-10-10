// Do cars PLACED IN A WORLD have windows, or are they still painted on?
//
// `glazing.ts` landed on 2026-09-28 and only the asset library's viewer called it, so every car
// standing in a world still had solid black glass. This checks the game's own loader.
//
// ASSERTED THROUGH THE SCENE, not through the module. Importing `applyAlphaGlazing` in a probe and
// checking it works would prove nothing about whether `placements.ts` calls it — which is the
// entire question, and was the answer "no" for a day.
//
//   node probes/corridor-placed-glass.mjs [world-slug]
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5185'
const WORLD = process.argv[2] ?? 'arrowhead-farms'
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]))
const fail = []
const say = (k, v) => console.log(`${k.padEnd(26)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)

/*
 * PUT A CAR IN THE WORLD FIRST.
 *
 * No world on this volume places a vehicle — every placements.json holds buildings, whose textures
 * have no alpha and are correctly left opaque. So without this the probe reports "0 glazed" and
 * looks like a failure of the code rather than of the fixture, which is how a probe ends up
 * disbelieved. The original document is restored at the end whatever happens.
 */
const doc = await fetch(`http://localhost:${PORT}/sites/${WORLD}/placements.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
const car = await fetch('http://localhost:8790/catalog')
  .then((r) => r.json())
  .then((j) => j.items.find((i) => /hero-car|traffic/.test(i.kind) && i.finished))
  .catch(() => null)
if (!car) { console.log('\nSKIP: the asset service has no finished vehicle to place'); await browser.close(); process.exit(0) }
say('placing', car.id)
const restore = async () => {
  await fetch(`http://localhost:8780/api/catalog/${encodeURIComponent(car.id)}`, { method: 'DELETE' }).catch(() => {})
  if (!doc) return
  await fetch(`http://localhost:${PORT}/sites/${WORLD}/placements.json`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc),
  }).catch(() => {})
}
/*
 * AND IT HAS TO BE PLACEABLE. A placement names a catalog id, and the catalog the VIEWER reads is
 * the volume's `/assets/catalog.json` — not the asset service's library. An id that is not in it
 * resolves to no entry, so `placements.ts` draws a box, whose material has no texture and is
 * therefore invisible to the check below. The first version of this probe stopped there and
 * reported "placed cars still have painted windows" about a car that was never loaded at all.
 *
 * This is what the library's "placeable" checkbox does: an entry pointing at the service's file.
 */
const entry = {
  id: car.id,
  name: car.subject?.slice(0, 40) ?? car.id,
  category: 'prop',
  footprint_m: [4.5, 1.9],
  height_m: 1.4,
  glb: `assetsvc/catalog/${encodeURIComponent(car.id)}/file/mesh.finished.glb`,
}
const listed = await fetch('http://localhost:8780/api/catalog', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assets: [entry] }),
}).then((r) => r.status).catch(() => 0)
say('listed as placeable', listed)

const spot = doc?.items?.[0]
const withCar = {
  ...(doc ?? { version: 1, items: [] }),
  items: [...(doc?.items ?? []), { id: 'zzprobe-car', asset: car.id, x: spot?.x ?? 0, y: spot?.y ?? 0, yaw_deg: 0, scale: 1, snap: 'ground' }],
}
const wrote = await fetch(`http://localhost:${PORT}/sites/${WORLD}/placements.json`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(withCar),
}).then((r) => r.status).catch(() => 0)
say('wrote the fixture', wrote)
if (wrote >= 400 || !wrote) { console.log('\nSKIP: could not write a placement to this volume'); await browser.close(); process.exit(0) }

await page.goto(`http://localhost:${PORT}/#${WORLD}`, { waitUntil: 'networkidle', timeout: 120000 })
const up = await page.waitForFunction(() => window.__apex?.site, null, { timeout: 120000 }).then(() => true).catch(() => false)
if (!up) { await restore(); console.log(`\nSKIP: ${WORLD} did not load in the viewer`); await browser.close(); process.exit(0) }
await page.waitForTimeout(6000)

// Every material in the scene that came off a placed glb, by whether it is in the sorted queue.
const mats = await page.evaluate((id) => {
  const seen = new Map()
  // THE CAR'S OWN MATERIALS. Everything else placed here is a building whose texture has no alpha
  // and which is correctly left opaque, so a scene-wide count answers a different question.
  let car = null
  window.__apex.site.group.traverse((o) => { if (o.userData?.placement?.asset === id) car = o })
  if (!car) return null
  car.traverse((o) => {
    if (!o.isMesh || !o.material) return
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m?.map || seen.has(m.uuid)) continue
      seen.set(m.uuid, { transparent: !!m.transparent, depthWrite: !!m.depthWrite, side: m.side })
    }
  })
  return [...seen.values()]
}, car.id)
if (mats === null) { await restore(); console.log('\nSKIP: the placed car never reached the scene'); await browser.close(); process.exit(0) }
if (!mats.length) { await restore(); fail.push('the car placed as a BOX — its glb did not load, so nothing here tested glazing') }
const textured = mats.length
const glazed = mats.filter((m) => m.transparent)
say('the car\u2019s textured materials', textured)
say('glazed', glazed.length)

if (!glazed.length) fail.push('not one placed model uses its texture alpha — placed cars still have painted windows')

// and the two properties that make it look right rather than merely "transparent"
for (const g of glazed) {
  // a car body in the sorted queue that stopped writing depth draws its far side through its near side
  if (!g.depthWrite) { fail.push('a glazed material stopped writing depth'); break }
}
for (const g of glazed) {
  // a single-sided windscreen shows nothing behind it, which reads as a hole rather than as glass
  if (g.side !== 2) { fail.push('a glazed material is single-sided'); break }
}

await restore()
if (errs.length) { say('page errors', [...new Set(errs)].slice(0, 3)); fail.push(`${errs.length} page errors`) }
console.log(fail.length ? `\nFAIL:\n  ${fail.join('\n  ')}` : `\nPASS: ${glazed.length} of ${textured} placed materials use their alpha, keep depth, and show both sides`)
await browser.close()
process.exit(fail.length ? 1 : 0)
