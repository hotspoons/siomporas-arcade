// Draw a traffic zone in the editor, save it, and check it reaches the road.
//
// THE FAILURE THIS EXISTS FOR: a zone that draws, colours, lists and saves perfectly and has no
// effect, because the polygon went down somewhere the road is not. Every step of that looks like
// success, so the probe does not stop at "the file was written" — it loads the saved document back
// through `Zones` and asserts the density AT A POINT ON THE CENTRELINE.
import { chromium } from 'playwright'
import { readFileSync, existsSync, unlinkSync } from 'node:fs'

const SLUG = process.env.SLUG ?? 'bowie-racetrack-rd'
const EDITOR = process.env.EDITOR ?? 'http://127.0.0.1:5185/editor.html'
const FILE = `/workspaces/apex-conduit/tools/corridor/data/sites/${SLUG}/zones.json`
const shot = (n) => `/tmp/claude-1000/-workspaces-apex-conduit/12eaed6d-83ff-4605-9fb1-f5c0b0bc5019/scratchpad/zone-${n}.png`

// start from nothing, so a pass cannot be an old file
if (existsSync(FILE)) unlinkSync(FILE)

const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 1280, height: 900 } })
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)))
let bad = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }

await p.goto(`${EDITOR}#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.corridor?.site, null, { timeout: 180000 })
await p.waitForTimeout(6000)

// into Traffic mode by its key
await p.keyboard.press('5')
await p.waitForTimeout(1500)
check(await p.evaluate(() => !!document.querySelector('.mode-rail .on, .seg.on')), 'a mode is selected')
await p.screenshot({ path: shot('mode') })

/*
 * DRAW ON THE ROAD, not wherever the camera happens to point. The centreline's own coordinates are
 * the only place we KNOW is road, so the polygon is built around a point on it — which is also the
 * whole point of the check at the end.
 */
const box = await p.evaluate(() => {
  const site = window.corridor.site
  const mid = site.manifest.spine.length_m / 2
  /*
   * `spineAt(s)` is the only thing that knows where the road IS. It answers in THREE's frame —
   * x east, y up, z SOUTH — and everything authored is in site metres with y north, so the sign
   * flip is the whole conversion and getting it wrong puts the zone a corridor-width away on the
   * wrong side. The first version of this probe looked for a polyline on the manifest, did not
   * find one, quietly fell back to the origin, and reported four green ticks about a zone nowhere
   * near the road.
   */
  const pos = site.spineAt(mid).pos
  return { c: { x: pos.x, y: -pos.z }, mid }
})
console.log('centre of the spine', JSON.stringify(box))
if (!Number.isFinite(box.c.x) || (box.c.x === 0 && box.c.y === 0)) {
  console.log('FAIL could not find a point on the road — refusing to test against the origin')
  process.exit(1)
}

/*
 * DRAW IT THE WAY A PERSON DOES: start the tool, click four corners, close the ring.
 *
 * The first version pushed straight into `doc.zones`, which skips `closeDraw` and therefore skips
 * `addMesh` — so the zone saved correctly, read back correctly, and was INVISIBLE on the map, and
 * the probe was green throughout. A probe that bypasses the path it is testing tests the bypass.
 */
const authored = await p.evaluate(({ c }) => {
  const t = window.corridor.traffic
  if (!t) return { error: 'window.corridor.traffic is not exposed' }
  t.startDraw()
  for (const [dx, dy] of [[-60, -60], [60, -60], [60, 60], [-60, 60]]) t.click({ x: c.x + dx, y: c.y + dy })
  t.closeDraw()
  const z = t.doc.zones[0]
  if (z) { z.name = 'probe zone'; z.traffic.density = 1 }
  t.select(z?.id ?? null)
  return { zones: t.doc.zones.length, id: z?.id, drawing: t.drawing }
}, box)
console.log('authored', JSON.stringify(authored))
check(!authored.error, 'the traffic mode is reachable')
check(authored.zones === 1 && !authored.drawing, 'clicking four corners and closing made one zone')

// IT IS ON THE MAP. `addMesh` only runs on the real draw path, so this is the check that the
// invisible-but-saved failure cannot pass.
const painted = await p.evaluate(() => {
  const g = window.corridor.traffic.group
  const fills = []
  g.traverse((o) => { if (o.isMesh && o.userData.zoneId) fills.push({ id: o.userData.zoneId, colour: '#' + o.material.color.getHexString(), visible: o.visible }) })
  return { visible: g.visible, fills }
})
console.log('painted', JSON.stringify(painted))
check(painted.visible, 'the traffic overlay is visible in traffic mode')
check(painted.fills.length === 1, 'the zone has a fill mesh')
check(painted.fills[0]?.colour === '#8a1f1a', 'and it is painted maroon, because jammed is maroon')
await p.waitForTimeout(800)
await p.screenshot({ path: shot('drawn') })

const saved = await p.evaluate(() => window.corridor.traffic.save().then((m) => m, (e) => 'ERROR ' + e.message))
console.log('save:', saved)
check(!String(saved).startsWith('ERROR'), 'it saved')
check(existsSync(FILE), 'zones.json is on disk')

if (existsSync(FILE)) {
  const doc = JSON.parse(readFileSync(FILE, 'utf8'))
  check(doc.zones?.length === 1, 'one zone in the file')
  check(!!doc.frame, 'the frame is stamped, so a frame change is loud rather than silent')
  // THE REAL CHECK: does it answer on the road?
  const onRoad = await p.evaluate((d) => {
    const { Zones } = window.corridor.zonesModule
    const z = new Zones()
    z.set(d.zones)
    const site = window.corridor.site
    const pos = site.spineAt(site.manifest.spine.length_m / 2).pos
    return {
      onRoad: z.densityAt(pos.x, -pos.z),
      // a point a kilometre up the road, outside the 120 m box: this is the control
      offRoad: z.densityAt(pos.x + 1000, -pos.z + 1000),
    }
  }, doc)
  console.log('density', JSON.stringify(onRoad))
  check(onRoad.onRoad === 1, 'the road inside the zone reads as jammed')
  check(onRoad.offRoad === 0, 'a point far outside reads as no traffic — the check can fail')
}

await p.screenshot({ path: shot('saved') })
console.log(bad ? `FAILED (${bad})` : 'OK')
await b.close()
process.exit(bad ? 1 : 0)
