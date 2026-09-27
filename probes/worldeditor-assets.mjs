// Can a person get from a roster entry to a pinned seed without leaving the editor?
//
// That loop is the point of the Assets panel and it is the one the handoff cares about: "a human
// accepts a picture and only then is a GPU spent". So this drives it — open Assets, pick a spec,
// check the recipe explains ITSELF, draw candidates against the real flux, click one, and confirm
// the seed is pinned.
//
// IT ALSO CHECKS THE IMAGES ARRIVE THROUGH ONE ORIGIN. The browser must never reach assetsvc
// directly; the editor proxies it. An <img> whose naturalWidth is 0 is the failure that looks
// exactly like a slow network.
//
//   node probes/worldeditor-assets.mjs --ui http://localhost:5214/world.html
import { chromium } from 'playwright'
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const UI = arg('ui', 'http://localhost:5214/world.html')
const SPEC = arg('spec', 'rx7-fd')

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
const errors = []
page.on('pageerror', (e) => { errors.push(e.message.slice(0, 200)); console.log('pageerror', e.message.slice(0, 200)) })
await page.goto(UI, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.seg', { timeout: 30000 })
await page.click('.seg[data-value="assets"]')
await page.waitForSelector('#panel .row', { timeout: 30000 })

const rosterSize = await page.$$eval('#panel .row', (rs) => rs.length)
await page.click(`#panel .row:has-text("${SPEC}")`)
await page.waitForTimeout(1500)

// the recipe, and whether it explains itself
const readouts = await page.$$eval('#panel .readout', (rs) => rs.map((r) => r.textContent.trim()))
const whys = await page.$$eval('#panel .panel-hint', (hs) => hs.map((h) => h.textContent.trim()).filter((t) => /chroma|glassKey|paint/.test(t)))

// draw two, against the real model
await page.fill('#panel .field input[type=number]', '2')
await page.dispatchEvent('#panel .field input[type=number]', 'change')
await page.click('#panel button:has-text("Draw")')

// the job is a poll; give it the time a real draw takes
await page.waitForSelector('#panel .candidate', { timeout: 180000 })
await page.waitForTimeout(1500)

const shots = await page.$$eval('#panel .candidate', (cs) =>
  cs.map((c) => ({ seed: c.querySelector('.candidate-seed')?.textContent.trim(), w: c.querySelector('img')?.naturalWidth ?? 0 })),
)

// pick the second one, so "it pinned the first by accident" cannot pass
await page.click('#panel .candidate:nth-of-type(2)')
await page.waitForTimeout(2500)
const pinned = await page.$$eval('#panel .readout', (rs) => rs.map((r) => r.textContent.trim()).filter((t) => /^(chosen|seed)/.test(t)))
const marked = await page.$$eval('#panel .candidate.on .candidate-seed', (cs) => cs.map((c) => c.textContent.trim()))

console.log(JSON.stringify({ rosterSize, readouts, whys, shots, pinned, marked }, null, 1))
await browser.close()
const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1 }
if (errors.length) fail(`the page threw: ${errors[0]}`)
else if (rosterSize < 10) fail(`the roster has ${rosterSize} entries`)
else if (!readouts.some((r) => /backdrop/.test(r))) fail(`the recipe did not render: ${JSON.stringify(readouts)}`)
else if (!whys.length) fail('the panel shows the backdrop and glass key but not WHY — an unexplained choice is the first thing overridden')
else if (shots.length !== 2) fail(`asked for 2 candidates, got ${shots.length}`)
else if (shots.some((s) => s.w === 0)) fail(`an image did not load through the editor's proxy: ${JSON.stringify(shots)}`)
else if (new Set(shots.map((s) => s.seed)).size !== 2) fail(`both candidates report the same seed: ${JSON.stringify(shots)}`)
else if (!pinned.some((p) => /^seed\s*\d/.test(p))) fail(`no seed was pinned: ${JSON.stringify(pinned)}`)
else if (marked.length !== 1) fail(`${marked.length} candidates are marked as chosen`)
else console.log(`PASS: ${rosterSize} in the roster, the recipe explains itself (${whys[0].slice(0, 60)}…), 2 candidates drawn and loaded through the editor's own origin (${shots.map((s) => s.w).join('x, ')}px), and picking the second pinned ${pinned.find((p) => /^seed/.test(p))?.replace(/^seed/, 'seed ')}.`)
