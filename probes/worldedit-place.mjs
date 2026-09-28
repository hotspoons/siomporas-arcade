// The site editor is a MODE of the world editor, not another tab.
//
// Rich, 2026-09-27: "why are we just linking to a place editor — I thought the world editor was
// the place editor ... make it so you can edit the place after baking the world assets and it has
// a proper picker, and it isn't dumping you into new tabs, very amateurish." Then, asked whether
// to absorb it or keep it a separate page reached in place: "Absorbed".
//
// So the things to prove are: it is reachable without leaving the page, it shares the world
// picker rather than having a second one, it brings up a real 3D scene, and — the part that is
// easy to get wrong when two applications share a document — it stops drawing and stops eating
// keys when you leave it.
//
//   PORT=5185 node probes/worldedit-place.mjs [slug]
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5185'
const slug = process.argv[2] ?? null
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
const errors = []
page.on('pageerror', (e) => { errors.push(e.message.slice(0, 160)); console.log('pageerror', e.message.slice(0, 200)) })
let opened = 0
page.on('popup', () => { opened += 1 })
await page.goto(`http://localhost:${PORT}/world.html`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction(() => window.__we?.ready?.() === true, null, { timeout: 90000 })

const fails = []
const ok = (name, cond, detail) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name} — ${detail}`); if (!cond) fails.push(name) }

const baked = await page.evaluate(() => window.__we.worlds().filter((w) => w.baked).map((w) => w.slug))
ok('Place is one of the modes in the bar',
  await page.evaluate(() => !!document.querySelector('.seg[data-value="place"]')), 'present')
ok('and nothing in the menu opens a new tab any more',
  await page.evaluate(() => !document.body.textContent.includes('Site editor')),
  'no "Site editor" item')

if (!baked.length) {
  // Still worth asserting: the mode must say why rather than showing an empty 3D scene.
  await page.evaluate(() => window.__we.setMode('place'))
  await page.waitForTimeout(500)
  const text = await page.evaluate(() => document.querySelector('#panel')?.textContent ?? '')
  ok('with nothing baked it says so instead of opening an empty scene',
    /not baked|No world selected/i.test(text), text.trim().slice(0, 70))
  ok('and the 3D canvas stays hidden',
    await page.evaluate(() => document.querySelector('#gl')?.hidden === true), 'hidden')
  await browser.close()
  console.log(fails.length ? `\nFAIL: ${fails.length} — ${fails.join('; ')}` : '\nPASS (no baked world here: the empty path only)')
  process.exit(fails.length ? 1 : 0)
}

// Through the same path the picker uses. The first version of this probe called `selected()`,
// which is a GETTER, and then wondered why the Place mode kept reporting no world.
const target = slug ?? baked[0]
await page.evaluate((s) => window.__we.select(s), target)
ok('the picker selected it', await page.evaluate(() => window.__we.selected()) === target, target)
await page.evaluate(() => window.__we.setMode('place'))
// The canvas is revealed SYNCHRONOUSLY by setMode; the editor module is a dynamic import and
// arrives later, and the scene later still. Waiting on `#gl` asserted against a page that had not
// mounted anything yet, and reported "1 top bar(s)" as a failure — a true fact about the wrong
// moment. Wait for the rail the editor mounts, which only exists once it has.
await page.waitForFunction(() => !!document.querySelector('#se-rail .segmented'), null, { timeout: 180000 })
  .catch(() => {})

ok('entering Place shows the 3D canvas and hides the map',
  await page.evaluate(() => document.querySelector('#gl')?.hidden === false && document.querySelector('#map')?.hidden === true),
  'swapped')
ok('the site editor mounted its rail into this page rather than building a bar',
  await page.evaluate(() => !!document.querySelector('#se-rail .segmented') && document.querySelectorAll('header.topbar').length === 1),
  `${await page.evaluate(() => document.querySelectorAll('header.topbar').length)} top bar(s)`)
// ONE PICKER FOR THE PAGE. Both editors use the same class for theirs — `.topbar-site` — so the
// count is the test: two would mean the site editor had brought its own, which is exactly the
// duplication that let the world editor point at one place and the 3D scene at another. (An
// earlier version of this asserted `.topbar-site === 0`, having assumed the two used different
// classes, and called the single correct picker a failure.)
const pickers = await page.evaluate(() => ({
  wrappers: document.querySelectorAll('.topbar-site').length,
  buttons: document.querySelectorAll('.site-button').length,
}))
ok('there is ONE world picker on the page, not one per editor',
  pickers.wrappers === 1 && pickers.buttons === 1,
  `${pickers.wrappers} picker, ${pickers.buttons} button`)

// Back out: the scene must stop drawing and stop answering keys.
await page.evaluate(() => window.__we.setMode('define'))
await page.waitForTimeout(400)
ok('leaving Place puts the map back',
  await page.evaluate(() => document.querySelector('#gl')?.hidden === true && document.querySelector('#map')?.hidden === false),
  'swapped back')
ok('and the map works again — the box tool still draws',
  await (async () => {
    await page.evaluate(() => window.__we.map.clearRing())
    await page.mouse.move(400, 320); await page.mouse.down()
    for (let i = 1; i <= 8; i++) await page.mouse.move(400 + 25 * i, 320 + 20 * i)
    await page.mouse.up()
    return page.evaluate(() => window.__we.map.ring.length === 4)
  })(), 'drew a box after coming back')

ok('no new tab was opened at any point', opened === 0, `${opened} popups`)
ok('and nothing threw', errors.length === 0, errors[0] ?? 'clean')

await browser.close()
console.log(fails.length ? `\nFAIL: ${fails.length} — ${fails.join('; ')}` : '\nPASS: the place editor is a mode, not a tab')
process.exit(fails.length ? 1 : 0)
