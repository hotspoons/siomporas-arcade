// The mesh, in 3D, in the panel.
//
// Rich, 2026-09-28: "we need to port the 3d viewer, the browser, etc. to this interface from the
// other service ... we don't need an external service that will be wiped on a fresh clone sticking
// around, everything needs to be folded in here."
//
// `ext/*` is gitignored, so ext/assetlib's viewer does not survive a clone at all. Before this,
// the only way to judge a reconstruction from the editor was to download the .glb and open it
// somewhere else.
//
// The check that matters is not "a canvas exists" — it is that something was DRAWN into it, and
// that the GLTFLoader did not reject. GLTFLoader without a working DRACOLoader rejects rather than
// warning, and finish.mjs emits Draco, so an empty stage is the expected failure and looks exactly
// like a bad reconstruction.
//
//   PORT=5185 node probes/worldedit-meshview.mjs
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
page.on('pageerror', (e) => { errors.push(e.message.slice(0, 160)); console.log('pageerror', e.message.slice(0, 200)) })
await page.goto(`http://localhost:${PORT}/world.html`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction(() => window.__we?.ready?.() === true, null, { timeout: 90000 })

const fails = []
const ok = (name, cond, detail) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name} — ${detail}`); if (!cond) fails.push(name) }

/*
 * THROUGH THE ASSETS MODE, which is now the only way in.
 *
 * This used to click a toolbar icon. "Assets" existed three times — that icon, a mode, and two
 * drawer items opening a different dialog — and de-duplicating it left this probe clicking a
 * button that is gone. The catalog opens from inside the mode, which is where generating and
 * placing both live now.
 */
await page.evaluate(() => window.__we.setMode('assets'))
await page.waitForFunction(() => [...document.querySelectorAll('#panel button')].some((n) => /catalog & generate/i.test(n.textContent ?? '')), null, { timeout: 30000 })
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#panel button')].find((n) => /catalog & generate/i.test(n.textContent ?? ''))
  b?.click()
})
await page.waitForFunction(() => !!document.querySelector('.asset-row'), null, { timeout: 30000 }).catch(() => {})
// the first item that has a mesh
const picked = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.asset-row')]
  const ready = rows.find((r) => /ready|meshed/i.test(r.textContent ?? '')) ?? rows[0]
  ready?.click()
  return ready?.textContent?.trim().slice(0, 30) ?? null
})
ok('an asset with a mesh was opened', !!picked, picked ?? 'none')
await page.waitForFunction(() => !!document.querySelector('.meshview-canvas'), null, { timeout: 30000 }).catch(() => {})

const canvas = await page.evaluate(() => {
  const c = document.querySelector('.meshview-canvas')
  if (!c) return null
  const r = c.getBoundingClientRect()
  return { w: Math.round(r.width), h: Math.round(r.height), gl: !!c.getContext instanceof Object }
})
ok('the panel has a 3D canvas with real size', (canvas?.w ?? 0) > 200 && (canvas?.h ?? 0) > 150,
  canvas ? `${canvas.w}x${canvas.h}` : 'no canvas')

// Give it time to fetch and decode the glb, then check it did not report a failure.
await page.waitForTimeout(6000)
const status = await page.evaluate(() => {
  const s = document.querySelector('.meshview-status')
  return { hidden: s?.hidden ?? true, text: (s?.textContent ?? '').trim() }
})
ok('it did not report a load failure', status.hidden || !/could not load|loading/i.test(status.text),
  status.hidden ? 'no message' : status.text)

/*
 * SOMETHING WAS ACTUALLY DRAWN. A canvas of the right size showing nothing is what a rejected
 * Draco decode looks like, so this reads the pixels back: a rendered model over a dark background
 * has a spread of luminance, an empty stage has almost none.
 */
// THROUGH THE VIEW'S OWN capture(), which renders and reads back in ONE turn. A WebGL canvas
// without `preserveDrawingBuffer` is cleared after compositing, so a drawImage from a later turn
// reads an empty buffer — the first version of this check reported luminance 0-0 on a model that
// was on screen, which is exactly the failure it was written to detect.
const pixels = await page.evaluate(() => window.__meshview.capture())
ok('and something is actually drawn in it, not an empty stage',
  pixels.max - pixels.min > 25, `luminance ${pixels.min}–${pixels.max}, mean ${pixels.mean}`)

// Closing the panel must give the WebGL context back — browsers cap them and lose the oldest.
await page.evaluate(() => document.querySelector('.dialog-head button:last-child')?.click())
await page.waitForTimeout(600)
ok('closing the panel disposes the preview',
  await page.evaluate(() => !document.querySelector('.meshview-canvas')), 'gone')
ok('and nothing threw', errors.length === 0, errors[0] ?? 'clean')

await browser.close()
console.log(fails.length ? `\nFAIL: ${fails.length} — ${fails.join('; ')}` : '\nPASS: the mesh shows up in the panel')
process.exit(fails.length ? 1 : 0)
