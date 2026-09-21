// Drive the corridor editor headlessly: load a site, optionally run a script of actions, shoot it.
//   node probes/editor-shot.mjs <slug> <out.png> [action...]
// actions: draw       draw a 4-vertex area by clicking the canvas and closing it
//          select:ID  select an area by id
//          place:ASSET place one of that asset near the middle of the view
//          save       Ctrl+S
//          key:K      press a key
//          mode:M     areas | place | structures
//          span:S0:S1 (structures) author an interval by along-track metres, as two clicks would
//          struct:ID  (structures) select an authored structure by id
//          set:KEY:V  (structures) set a field on the selected structure (kind, clearance_m, span_m, asset, name…)
//          stance:B64 put the editor camera where the viewer's stance URL (its ?stance= value) had the chase camera
//          look:s:dist:h  low view from `dist` m before spine station s, `h` m up, looking along the road
import { chromium } from 'playwright'

const [, , slug = 'frederick-i70', out = '/tmp/editor.png', ...actions] = process.argv
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
await page.route('**/@vite/client', (r) => r.abort())
\1page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`))
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`))
page.on('dialog', (d) => d.accept())

await page.goto(`http://localhost:5207/editor.html#${slug}`, { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && !!window.corridor?.site, null, { timeout: 240000 })
await page.waitForTimeout(1500)

let placed = 0
const click = (x, y) => page.mouse.click(x, y, { delay: 40 })
for (const a of actions) {
  const [verb, arg] = a.split(':')
  if (verb === 'draw') {
    await page.keyboard.press('n')
    for (const [x, y] of [[760, 380], [1060, 400], [1080, 660], [720, 640]]) { await click(x, y); await page.waitForTimeout(250) }
    await page.keyboard.press('Enter')
  } else if (verb === 'select') {
    await page.evaluate((id) => window.corridor.areas.select(id), arg)
  } else if (verb === 'place') {
    // each `place:` lands on its own spot, so a run of them does not stack in one pile
    const [x, y] = [[820, 430], [960, 520], [740, 600], [1020, 640], [880, 340]][placed++ % 5]
    await page.evaluate((id) => window.corridor.place.arm(id), arg)
    await click(x, y)
  } else if (verb === 'save') {
    await page.keyboard.down('Control'); await page.keyboard.press('s'); await page.keyboard.up('Control')
  } else if (verb === 'key') {
    await page.keyboard.press(arg)
  } else if (verb === 'mode') {
    await page.keyboard.press(arg === 'place' ? '2' : arg === 'structures' ? '4' : '1')
  } else if (verb === 'span') {
    // two clicks on the road at exact stations: `span:2340:2362`
    const [, s0, s1] = a.split(':')
    await page.evaluate(([a0, a1]) => {
      const { structs, site } = window.corridor
      const at = (s) => { const p = site.spineAt(s).pos; return { x: p.x, y: -p.z } }
      structs.startPick()
      structs.click(at(a0))
      structs.click(at(a1))
    }, [Number(s0), Number(s1)])
    await page.waitForTimeout(1500)
  } else if (verb === 'struct') {
    await page.evaluate((id) => window.corridor.structs.select(id), arg)
  } else if (verb === 'set') {
    const [, key, ...rest] = a.split(':')
    const raw = rest.join(':')
    await page.evaluate(([k, v]) => {
      const { structs } = window.corridor
      if (k === 'kind') return structs.setKind(v)
      const it = structs.doc.items.find((i) => i.id === structs.selected)
      if (!it) return
      const n = Number(v)
      it[k] = Number.isFinite(n) && v !== '' ? n : v
      structs.dirty = true
      structs.select(it.id) // redraws through the same path the panel uses
    }, [key, raw])
    await page.waitForTimeout(1200)
  } else if (verb === 'stance') {
    // the viewer's chase camera for a stance: 7.5 m behind the car, 2.6 m up, looking 6 m ahead
    const st = JSON.parse(Buffer.from(arg, 'base64').toString('utf8'))
    // The stored car height is the road AS IT WAS when Rich copied the stance; a flatten or a
    // re-profile since then moves the road, so stand on today's ground instead of yesterday's.
    await page.evaluate((st) => {
      const { camera, orbitTarget, site } = window.corridor
      const [x, , z] = st.car.p
      const y = site.groundAt(x, z) ?? st.car.p[1]
      const f = [Math.cos(st.car.yaw), 0, Math.sin(st.car.yaw)]
      camera.position.set(x - f[0] * 7.5, y + 2.6, z - f[2] * 7.5)
      orbitTarget.set(x + f[0] * 6, y + 1.0, z + f[2] * 6)
      camera.lookAt(orbitTarget)
    }, st)
  } else if (verb === 'look') {
    const [, s, dist = 40, h = 3] = a.split(':')
    await page.evaluate(([s, dist, h]) => {
      const { camera, orbitTarget, site } = window.corridor
      const at = site.spineAt(s)
      const from = site.spineAt(Math.max(0, s - dist)).pos
      camera.position.set(from.x, from.y + h, from.z)
      orbitTarget.set(at.pos.x, at.pos.y + 2, at.pos.z)
      camera.lookAt(orbitTarget)
    }, [Number(s), Number(dist), Number(h)])
  } else if (verb === 'slide') {
    // drive the Nth slider in the detail panel the way a pointer would: `slide:0:2.4`
    const [, n, v] = a.split(':')
    await page.evaluate(([i, val]) => {
      const r = document.querySelectorAll('#body input[type=range]')[i]
      r.value = String(val)
      r.dispatchEvent(new Event('input', { bubbles: true }))
    }, [Number(n), Number(v)])
  } else if (verb === 'put') {
    // place at exact site coordinates: `put:barn-01:120:-40`
    const [, id, x, y] = a.split(':')
    await page.evaluate(([i, px, py]) => {
      window.corridor.place.arm(i)
      window.corridor.place.click({ x: px, y: py })
    }, [id, Number(x), Number(y)])
    await page.waitForTimeout(900)
  } else if (verb === 'obl') {
    // low oblique on a placement, to see a model rather than its roof
    await page.evaluate(([id, dist]) => {
      const { place, camera, site } = window.corridor
      const p = place.doc.items.find((i) => i.id === id)
      if (!p) return
      const z = site.groundAt(p.x, -p.y) ?? site.heightAt(p.x, p.y)
      window.corridor.orbitTarget?.set?.(p.x, z + 8, -p.y)
      camera.position.set(p.x + dist * 0.8, z + dist * 0.45, -p.y + dist * 0.8)
      camera.lookAt(p.x, z + 8, -p.y)
    }, [arg, Number(a.split(':')[2] ?? 70)])
  } else if (verb === 'wait') {
    await page.waitForTimeout(Number(arg))
  }
  await page.waitForTimeout(600)
}

await page.waitForTimeout(1200)
await page.screenshot({ path: out, timeout: 180000 })
console.log(logs.filter((l) => !l.startsWith('log:')).slice(0, 12).join('\n') || 'no console errors')
console.log('status:', await page.textContent('#status'))
console.log('areas:', await page.evaluate(() => window.corridor.areas.doc.areas.length), 'selected:', await page.evaluate(() => window.corridor.areas.selected))
console.log('placements:', await page.evaluate(() => window.corridor.place.doc.items.length))
console.log('structures:', await page.evaluate(() => JSON.stringify(window.corridor.structs?.doc.items ?? null)))
await browser.close()
