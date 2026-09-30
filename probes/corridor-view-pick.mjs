// Assets → an item's drawings: choose which one TRELLIS meshes, and delete the ones you do not want.
//
// Rich, 2026-09-30: "I can't select which photo to send to the trellis mesher, the first image
// stays put and there is no way to change it or delete it."
//
// EVERY ASSERTION ASKS THE SERVICE what it will mesh (`chosen`) and what it holds (`views`), not
// what the page highlights. A card that lights up while the service still meshes the first one is
// exactly the bug being fixed. Needs an image model that answers; a recorder is enough:
//
//   ASSETSVC_URL_FLUX2_DEV=http://localhost:8799 node tools/assetsvc/server.mjs --port 8790
//   PORT=5186 node probes/corridor-view-pick.mjs
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5185'
const SVC = `http://localhost:${PORT}`
const ID = `probe-pick-${Date.now().toString(36)}`
const fail = []
const say = (k, v) => console.log(`${k.padEnd(30)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)
const item = () => fetch(`${SVC}/assetsvc/catalog/${ID}`).then((r) => r.json())
async function drawOne() {
  const j = await fetch(`${SVC}/assetsvc/catalog/${ID}/image`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json())
  for (let k = 0; k < 80; k++) {
    const s = await fetch(`${SVC}/assetsvc/jobs/${j.job}`).then((r) => r.json())
    if (s.state === 'done') return
    if (s.state === 'failed') throw new Error(`draw failed: ${s.detail}`)
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('draw never finished')
}

await fetch(`${SVC}/assetsvc/catalog`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: ID, subject: 'probe', kind: 'prop', prompt: 'a red mailbox' }) })
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]))
const card = (view) => page.locator('#assets .asset-view-card').filter({ has: page.locator(`img[src*="${view}"]`) })
try {
  /* ---- 1 · the newest drawing is the default: the first no longer sticks ---- */
  await drawOne()
  await drawOne()
  const [a, b] = (await item()).views
  say('two drawings, chosen', (await item()).chosen === b ? 'the newest' : (await item()).chosen)
  if ((await item()).chosen !== b) fail.push('with two drawings the FIRST is still the one meshed')

  await page.goto(`${SVC}/world.html`, { waitUntil: 'networkidle', timeout: 90000 })
  await page.click('.seg[data-value="assets"]')
  await page.waitForSelector('#assets .asset-row', { timeout: 30000 })
  await page.locator('#assets .asset-row').filter({ hasText: ID }).click()
  await page.waitForSelector('#assets .asset-view-card', { timeout: 10000 })

  /* ---- 2 · pick the other one, from the card itself ---- */
  const pickA = card(a).locator('button:has-text("Mesh this")')
  say('"Mesh this" on the other card', await pickA.count())
  if (!(await pickA.count())) fail.push('the drawing that is not chosen has no way to choose it')
  if (!(await card(b).locator('text=will be meshed').count())) fail.push('the chosen drawing does not say it will be meshed')
  await pickA.click()
  await page.waitForTimeout(1200)
  say('after "Mesh this"', (await item()).chosen === a ? 'the one picked' : (await item()).chosen)
  if ((await item()).chosen !== a) fail.push('"Mesh this" did not change what the service will mesh')

  /* ---- 3 · a pick survives drawing another ---- */
  await drawOne()
  const c = (await item()).views.at(-1)
  say('drew a third, chosen', (await item()).chosen === a ? 'still the one picked' : (await item()).chosen)
  if ((await item()).chosen !== a) fail.push('drawing again threw away the person\'s pick')

  /* ---- 4 · delete the chosen one, through the card and its confirm ---- */
  await page.locator('#assets button[title="refresh"], #assets button:has-text("Refresh")').first().click().catch(() => {})
  await page.locator('#assets .asset-row').filter({ hasText: ID }).click()
  await page.waitForSelector(`#assets .asset-view-card img[src*="${c}"]`, { timeout: 10000 }).catch(() => {})
  await card(a).locator('button[title^="delete"]').click()
  await page.locator('.dialog button:has-text("Delete")').click()
  await page.waitForTimeout(1200)
  const after = await item()
  say('after deleting it', { views: after.views.length, chosen: after.chosen === c ? 'the newest left' : after.chosen })
  if (after.views.includes(a)) fail.push('the deleted drawing is still there')
  if (after.views.length !== 2) fail.push(`deleting one left ${after.views.length} drawings, not 2`)
  if (after.chosen !== c) fail.push(`with the chosen one deleted, ${after.chosen} will be meshed, not the newest left`)
  const gone = await fetch(`${SVC}/assetsvc/catalog/${ID}/views/${a}`, { method: 'DELETE' })
  if (gone.status !== 404) fail.push(`deleting it twice answered ${gone.status}, not 404`)
  await page.waitForTimeout(400)
  if (await card(a).count()) fail.push('the page still shows the deleted drawing')
} finally {
  await fetch(`${SVC}/assetsvc/catalog/${ID}`, { method: 'DELETE' }).catch(() => {})
  if (errs.length) { say('page errors', [...new Set(errs)].slice(0, 3)); fail.push(`${errs.length} page errors`) }
  await browser.close()
}
console.log(fail.length ? `\nFAIL:\n  ${fail.join('\n  ')}` : '\nPASS: the drawing to mesh is chosen from its card, a pick sticks, and deleting one moves the choice sensibly')
process.exit(fail.length ? 1 : 0)
