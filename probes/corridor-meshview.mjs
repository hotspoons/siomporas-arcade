// Can you actually drive the 3D preview, and does it remember how you left it?
//
// Rich, 2026-09-28: "we need the ability to pop it out larger, and we should be able to click in
// it and spin and zoom with the mouse, and it should remember last settings on refreshes."
//
// THE FIRST ONE WAS NOT A MISSING FEATURE. OrbitControls were attached the whole time; the
// `.meshview-status` overlay is `position: absolute; inset: 0` with `display: grid`, and a
// `display` rule beats the `hidden` attribute — so the "loading…" layer never went away. It sat
// invisible over every viewer in the app, dimming it 35% and eating every pointerdown before the
// controls saw it. Which is why this probe asks `elementFromPoint` whether the canvas owns its own
// middle BEFORE it tries to drag: "the drag did nothing" and "nothing reached the canvas" are
// different bugs and look identical from outside.
//
//   node probes/corridor-meshview.mjs
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } })
const page = await ctx.newPage()
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
const fail = []
const say = (k, v) => console.log(`${k.padEnd(28)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)

async function openCatalog(p) {
  await p.waitForSelector('.seg')
  await p.click('.seg[data-value="assets"]')
  // the library is a full-width pane now, not a dialog over the map
  await p.waitForSelector('#assets .asset-row', { timeout: 30000 })
  await p.waitForTimeout(1200)
  const id = await p.evaluate(() => {
    for (const r of document.querySelectorAll('.asset-row')) {
      if (/ready|meshed/.test(r.textContent ?? '')) { r.click(); return r.querySelector('.asset-row-id')?.textContent }
    }
    return null
  })
  if (!id) return null
  await p.waitForFunction(() => window.__meshview?.size, null, { timeout: 90000 })
  await p.waitForTimeout(600)
  return id
}

const camera = (p) => p.evaluate(() => {
  const c = window.__meshview.camera
  return { at: [c.position.x, c.position.y, c.position.z].map((n) => +n.toFixed(3)), dist: +c.position.length().toFixed(3) }
})

/** The middle of the canvas in page coordinates, and whether anything is on top of it. */
const middle = async (p) => {
  await p.evaluate(() => document.querySelector('.asset-detail .meshview')?.scrollIntoView({ block: 'center' }))
  await p.waitForTimeout(350)
  return p.evaluate(() => {
    const c = document.querySelector('.asset-detail .meshview canvas')
    const r = c.getBoundingClientRect()
    const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: Math.round(r.width), h: Math.round(r.height), owns: t === c, top: `${t?.tagName}.${String(t?.className).split(' ')[0]}` }
  })
}

await page.goto(`http://localhost:${PORT}/world.html`, { waitUntil: 'networkidle', timeout: 60000 })
const id = await openCatalog(page)
say('item with a mesh', id ?? 'none')
if (!id) { console.log('\nSKIP: nothing in the catalog has a mesh to look at'); await browser.close(); process.exit(0) }

/* ---- 1 · is the canvas reachable at all ---- */
let m = await middle(page)
say('canvas', { w: m.w, h: m.h, ownsItsMiddle: m.owns, onTop: m.top })
if (!m.owns) fail.push(`something is over the canvas: ${m.top} — the pointer never reaches the controls`)
if (m.h > 520) fail.push(`the preview is ${m.h}px tall; it runs under the dialog's footer`)

/* ---- 2 · drag and wheel ---- */
const before = await camera(page)
await page.mouse.move(m.x, m.y)
await page.mouse.down()
await page.mouse.move(m.x + 140, m.y + 20, { steps: 12 })
await page.mouse.up()
await page.waitForTimeout(500)
const dragged = await camera(page)
say('drag', { before: before.at, after: dragged.at })
if (JSON.stringify(before.at) === JSON.stringify(dragged.at)) fail.push('dragging did not move the camera')

m = await middle(page)
await page.mouse.move(m.x, m.y)
await page.mouse.wheel(0, -240)
await page.waitForTimeout(500)
const zoomed = await camera(page)
say('wheel', { was: dragged.dist, now: zoomed.dist })
if (Math.abs(zoomed.dist - dragged.dist) < 0.01) fail.push('the wheel did not zoom')

/* ---- 2b · the raw mesh, beside the finished one ---- */
//
// Rich, 2026-09-28: "Is it possible to see the original raw mesh in addition to the decimated mesh
// as an option?" Both files are kept — `mesh.glb` as TRELLIS returned it, `mesh.finished.glb`
// after simplifying and Draco — and only the finished one could be looked at, which is the wrong
// way round for judging whether the decimation went too far.
//
// THE TRIANGLE COUNT IS THE CHECK, not the file size: the finished file is compressed and the raw
// one is not, so a probe comparing bytes would pass on two copies of the same geometry.
const variants = await page.evaluate(() =>
  [...document.querySelectorAll('#assets .segmented button, #assets .seg')].map((n) => n.textContent.trim()))
say('mesh variants', variants)

/* ---- 2c · the windows are windows ---- */
//
// Rich, 2026-09-28: "I notice the window transparency isn't working on either the original or
// decimated models", then: "trellis.2 puts alpha information into the voxel cloud, we should not
// be using any chroma-keyed glass which was the original approach, it looks terrible."
//
// The glazing is in the base colour texture's ALPHA — TRELLIS.2 puts it there and exports the
// material as OPAQUE, so it is in every asset and nothing ever switched it on. `src/glazing.ts`
// does, at load, for whichever mesh is showing.
//
// THE MATERIAL BEING RIGHT PROVES NOTHING: a transmissive material the renderer never runs its
// transmission pass over looks exactly like an opaque one. So this turns transmission off on the
// loaded model and checks the picture changes.
if (variants.includes('glass')) fail.push('the chroma-keyed glass file is still being offered')

const glazed = await page.evaluate(() => window.__meshview.glazed)
say('glazed from alpha', glazed)
if (!glazed || glazed.glazed < 1) {
  fail.push('no glazing was separated — the texture alpha is not being read')
} else {
  /*
   * THE GLASS HAS TO BE ITS OWN MATERIAL, and that is the whole finding.
   *
   * Putting a transmission MASK on the one material the reconstruction comes with did nothing
   * visible: that material describes the BODY, so it is roughness 1 and metalness 1, and a fully
   * rough transmissive surface is frosted to opacity while a metal has no diffuse for
   * transmission to replace. The mask was correct the whole time — painted onto the body it lit
   * up the windscreen and nothing else.
   */
  const mats = await page.evaluate(() => {
    const out = []
    window.__meshview.pivot.traverse((o) => {
      for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
        out.push({ type: m.type, transmission: m.transmission ?? 0, roughness: +(m.roughness ?? 0).toFixed(2), metalness: m.metalness ?? 0 })
      }
    })
    return out
  })
  say('materials', mats)
  const glass = mats.find((m) => m.transmission > 0)
  const bodyKept = mats.some((m) => m.transmission === 0)
  if (!glass) fail.push('nothing transmissive after the split')
  else {
    if (glass.roughness > 0.3) fail.push(`the glass is roughness ${glass.roughness} — frosted to opacity`)
    if (glass.metalness > 0.1) fail.push(`the glass is metalness ${glass.metalness} — a metal has no diffuse to transmit`)
  }
  if (!bodyKept) fail.push('the body lost its own material in the split')

  const frame = () => page.evaluate(() => {
    const v = window.__meshview
    v.renderer.render(v.scene, v.camera)
    const off = document.createElement('canvas')
    off.width = 160
    off.height = 120
    const g = off.getContext('2d')
    g.drawImage(v.renderer.domElement, 0, 0, 160, 120)
    return [...g.getImageData(0, 0, 160, 120).data]
  })
  const setT = (t) => page.evaluate((v) => window.__meshview.pivot.traverse((o) => {
    for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
      if ('transmission' in m) { m.transmission = v; m.needsUpdate = true }
    }
  }), t)
  const on = await frame()
  await setT(0)
  await page.waitForTimeout(600)
  const off = await frame()
  await setT(1)
  let changed = 0
  for (let i = 0; i < on.length; i += 4) if (Math.abs(on[i] - off[i]) > 6) changed++
  say('pixels transmission is worth', `${changed} of ${on.length / 4}`)
  if (changed < 20) fail.push('turning transmission off changed nothing — the pass is not running')
}

if (!variants.includes('raw') || !variants.includes('finished')) {
  fail.push('no way to choose the raw mesh')
} else {
  await page.evaluate(() => [...document.querySelectorAll('#assets button')].find((x) => x.textContent?.trim() === 'finished')?.click())
  await page.waitForTimeout(3000)
  const finished = await page.evaluate(() => window.__meshview.stats)
  await page.evaluate(() => [...document.querySelectorAll('#assets button')].find((x) => x.textContent?.trim() === 'raw')?.click())
  const swapped = await page.waitForFunction((was) => {
    const st = window.__meshview?.stats
    return st && st.triangles !== was
  }, finished.triangles, { timeout: 90000 }).then(() => true).catch(() => false)
  await page.waitForTimeout(600)
  const raw = await page.evaluate(() => window.__meshview.stats)
  say('finished vs raw', { finished: finished.triangles, raw: raw?.triangles })
  if (!swapped) fail.push('choosing the raw mesh loaded the same geometry')
  else if (raw.triangles <= finished.triangles) {
    fail.push(`the raw mesh has ${raw.triangles} triangles against the finished ${finished.triangles} — one of them is not what it says`)
  }
  // and back, because the rest of this probe is about the finished one
  await page.evaluate(() => [...document.querySelectorAll('#assets button')].find((x) => x.textContent?.trim() === 'finished')?.click())
  await page.waitForTimeout(3000)
}

const downloads = await page.evaluate(() => [...document.querySelectorAll('#assets a.btn')].map((a) => a.textContent.trim()))
say('downloads', downloads)
if (downloads.length < 2) fail.push('only one of the two meshes can be downloaded')

/* ---- 3 · pop out ---- */
await page.evaluate(() => [...document.querySelectorAll('#assets button')].find((x) => /Pop out/.test(x.textContent))?.click())
await page.waitForTimeout(900)
const big = await page.locator('.meshview.big canvas').boundingBox().catch(() => null)
say('popped out', big ? { w: Math.round(big.width), h: Math.round(big.height) } : 'did not open')
if (!big) fail.push('Pop out opened nothing')
else if (big.width < m.w * 1.25) fail.push(`popped out at ${Math.round(big.width)}px against ${m.w}px inline — not worth the click`)
// the SAME viewer, moved: a second one would be a second WebGL context and a second download
const contexts = await page.evaluate(() => document.querySelectorAll('.meshview canvas').length)
say('canvases in the page', contexts)
if (contexts > 2) fail.push(`${contexts} viewers alive — pop out is making new ones`)
await page.keyboard.press('Escape')
await page.waitForTimeout(600)

/* ---- 4 · remembered across a reload ---- */
await page.evaluate(() => window.__meshview.setSpin(false))
const left = await camera(page)
await page.waitForTimeout(400)
await page.reload({ waitUntil: 'networkidle', timeout: 60000 })
const again = await openCatalog(page)
await page.waitForTimeout(900)
const back = await page.evaluate(() => ({ spin: window.__meshview.spinning, cam: [window.__meshview.camera.position.x, window.__meshview.camera.position.y, window.__meshview.camera.position.z].map((n) => +n.toFixed(3)) }))
say('after a reload', { sameItem: again === id, spin: back.spin, cam: back.cam })
if (back.spin !== false) fail.push('spin was turned off and came back on — the preference is not kept')
const moved = Math.hypot(back.cam[0] - left.at[0], back.cam[1] - left.at[1], back.cam[2] - left.at[2])
say('camera drift', +moved.toFixed(3))
if (moved > 0.05) fail.push(`the camera came back ${moved.toFixed(2)} away from where it was left`)

if (errs.length) { say('page errors', errs.slice(0, 3)); fail.push(`${errs.length} page errors`) }
console.log(fail.length ? `\nFAIL:\n  ${fail.join('\n  ')}` : '\nPASS: it can be driven, popped out, and it comes back as you left it')
await browser.close()
process.exit(fail.length ? 1 : 0)
