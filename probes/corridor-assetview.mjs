// Can you see what you made, and can you say which dice to roll?
//
// Rich, 2026-09-28: "After generating the mesh, I see no way to view it, definitely need a viewer.
// Also being able to override the seed number would be good for the image generator." Both are
// claims about pixels and about a request body, and neither can be checked by looking at the DOM:
//
//   A CANVAS IS NOT A PREVIEW. `.meshview` existing, sized and visible is true of a viewer that
//   silently failed to load — GLTFLoader without a working DRACOLoader REJECTS, and an empty
//   stage is a grid on a background, which looks like a bad reconstruction rather than a bug. So
//   this reads the pixels back, in the same turn as the render (`capture`), and asks whether
//   anything in them is brighter than the stage.
//
//   THE SEED HAS TO REACH THE SERVICE. A number in a field that the request does not carry is the
//   exact bug being fixed here. The draw is intercepted rather than run: the point is the body,
//   and a real draw is ten seconds of somebody else's GPU per candidate.
//
// Also checks the memory: a spec that was drawn and meshed in an earlier session, or imported,
// must show both without spending anything.
//
//   node probes/corridor-assetview.mjs [spec-id]
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5185'
const SPEC = process.argv[2] ?? 'rx7-fd'
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message))

/** The draw is intercepted: this probe is about the body, not about the pictures. */
let sent = null
await page.route('**/assetsvc/specs/*/candidates', async (route) => {
  sent = JSON.parse(route.request().postData() ?? '{}')
  await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ job: { job: 'probe-job' }, recipe: {} }) })
})

const fail = []
const say = (k, v) => console.log(`${k.padEnd(26)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)

await page.goto(`http://localhost:${PORT}/world.html`, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForSelector('.seg', { timeout: 30000 })
await page.click('.seg[data-value="assets"]')
await page.waitForSelector('#panel .rows .row', { timeout: 20000 })

// open the spec by name, whichever class it is filed under
const opened = await page.evaluate(async (id) => {
  const classes = [...document.querySelectorAll('#panel select option')].map((o) => o.value)
  for (const c of classes) {
    const sel = document.querySelector('#panel select')
    if (sel && sel.value !== c) { sel.value = c; sel.dispatchEvent(new Event('change')) }
    await new Promise((r) => setTimeout(r, 60))
    for (const row of document.querySelectorAll('#panel .rows .row')) {
      if (row.querySelector('.row-name')?.textContent?.trim() === id) { row.click(); return true }
    }
  }
  return false
}, SPEC)
if (!opened) { console.log(`FAIL: ${SPEC} is not in the roster`); await browser.close(); process.exit(1) }
await page.waitForSelector('.field.text input', { timeout: 20000 })
await page.waitForTimeout(1500)

/* ---- 1 · what was already there ---- */
const tiles = await page.locator('#panel .candidate').count()
say('candidates on open', tiles)
if (!tiles) fail.push('a spec with views on disk showed none — the panel is not reading the catalog')

/* ---- 2 · the preview, in pixels ---- */
const has = await page.locator('#panel .meshview canvas').count()
say('meshview canvases', has)
if (!has) fail.push('no 3D preview for a spec that already has a mesh')
else {
  // the loader has to finish, and it fetches a multi-megabyte Draco glb through two proxies
  const shown = await page.waitForFunction(() => {
    const v = window.__meshview
    return v && v.size ? { x: +v.size.x.toFixed(2), y: +v.size.y.toFixed(2), z: +v.size.z.toFixed(2) } : null
  }, null, { timeout: 60000 }).then((h) => h.jsonValue()).catch(() => null)
  say('bounds', shown ?? 'never loaded')
  if (!shown) fail.push('the glb never loaded — an empty stage looks exactly like a bad bake')
  // the reconstruction is unit-normalised, so this is a shape check and not a size one: a car
  // that came back as a cube is a failed bake whatever it is scaled to later
  else if (Math.max(shown.x, shown.y, shown.z) / Math.max(1e-6, Math.min(shown.x, shown.y, shown.z)) < 1.5) {
    fail.push(`loaded a ${JSON.stringify(shown)} lump — nothing that shape is a vehicle`)
  }

  const px = await page.evaluate(() => window.__meshview.capture())
  say('pixels min/max/mean', px)
  // an empty stage is the background plus a faint grid: a loaded model puts real highlights in it
  if (px.max - px.min < 25) fail.push(`nothing stands out of the stage (min ${px.min}, max ${px.max}) — the preview is empty`)

  const status = await page.locator('#panel .meshview-status').evaluate((n) => (n.hidden ? null : n.textContent))
  say('viewer says', status ?? '(nothing, which is right)')
  if (status) fail.push(`the viewer reported: ${status}`)

  const showing = await page.locator('#panel .readout').evaluateAll((ns) => ns.map((n) => n.textContent?.trim()).filter((t) => t?.startsWith('showing')))
  say('showing', showing.join(' '))
}

/* ---- 2b · a candidate opens big enough to decide on ---- */
//
// "I don't see a lightbox pop up when I go to inspect the output... can't expand these" — and the
// decision these 140px tiles carry is which drawing gets forty seconds of GPU. So the check is
// that a click gets you a picture MUCH bigger than the tile, with the action on it.
if (tiles) {
  const tile = await page.locator('#panel .candidate').first().boundingBox()
  await page.locator('#panel .candidate').first().click()
  await page.waitForSelector('.lightbox img', { timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(400)
  const box = await page.locator('.lightbox img').boundingBox().catch(() => null)
  const act = await page.locator('.lightbox button:not(.hidden)').evaluateAll((ns) => ns.map((n) => n.textContent?.trim()).filter(Boolean)).catch(() => [])
  say('tile → lightbox', box ? `${Math.round(tile.width)}px → ${Math.round(box.width)}px` : 'did not open')
  say('lightbox offers', act.join(' · ') || '(nothing)')
  if (!box) fail.push('clicking a candidate opened no lightbox')
  else if (box.width < tile.width * 2) fail.push(`the lightbox is ${Math.round(box.width)}px against a ${Math.round(tile.width)}px tile — not worth opening`)
  if (!act.some((t) => /use this one/i.test(t))) fail.push('the lightbox cannot choose the picture it is showing')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
}

/* ---- 3 · the seed reaches the service ---- */
const typed = await page.evaluate(() => {
  const f = [...document.querySelectorAll('#panel .field.text')].find((n) => n.querySelector('.field-label')?.textContent === 'seed')
  if (!f) return null
  const i = f.querySelector('input')
  i.value = '4242'
  i.dispatchEvent(new Event('change'))
  return { placeholder: i.placeholder, note: f.querySelector('.field-note')?.textContent ?? null }
})
say('seed field', typed ?? 'ABSENT')
if (!typed) fail.push('no seed field in Candidates')
else {
  await page.evaluate(() => [...document.querySelectorAll('#panel button')].find((b) => b.textContent?.trim() === 'Draw')?.click())
  await page.waitForTimeout(600)
  say('draw sent', sent ?? 'nothing')
  if (!sent) fail.push('Draw sent no request')
  else if (sent.seed !== 4242) fail.push(`Draw sent seed ${sent.seed}, not the 4242 that was typed`)
}

/* ---- 4 · one context, not one per render ---- */
// the panel redraws on a poll; a MeshView per render is a WebGL context per render
const contexts = await page.evaluate(() => document.querySelectorAll('.meshview canvas').length)
say('canvases after a draw', contexts)
if (contexts > 1) fail.push(`${contexts} preview canvases — a context is leaking per render`)

if (errs.length) { say('page errors', errs.slice(0, 3)); fail.push(`${errs.length} page errors`) }
console.log(fail.length ? `\nFAIL:\n  ${fail.join('\n  ')}` : '\nPASS: the mesh is visible and the seed is the one that was typed')
await browser.close()
process.exit(fail.length ? 1 : 0)
