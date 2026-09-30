// Assets → a new item → type a prompt → Draw, WITHOUT saving. The prompt typed is the one drawn.
//
// Rich, 2026-09-30: a pizza-car prompt came back as children jumping in a car park, because the
// item was created with prompt '' and Draw sent only a seed — flux was asked for nothing. "Make
// this work on draft prompts, no need to require a save before generate."
//
// THE ASSERTION IS WHAT THE GENERATOR RECEIVED, not what the page shows. Run the asset service
// with its image model pointed at a recorder (anything that logs the JSON body of
// /v1/images/generations, one line per call), and give this the log:
//
//   ASSETSVC_URL_FLUX2_DEV=http://localhost:8799 node tools/assetsvc/server.mjs --port 8790
//   FLUX_LOG=/path/to/log PORT=5186 node probes/corridor-draw-draft.mjs
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const PORT = process.env.PORT ?? '5185'
const LOG = process.env.FLUX_LOG
if (!LOG) { console.error('FLUX_LOG is required: the recorder log is the only thing this trusts'); process.exit(2) }
const SVC = `http://localhost:${PORT}`
const ID = `probe-draft-${Date.now().toString(36)}`
const PROMPT = 'A sleek exotic pizza delivery sports car for "Mr. Pizza" with a lit roof sign'
const fail = []
const say = (k, v) => console.log(`${k.padEnd(28)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)
const received = () => readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]))
try {
  await page.goto(`${SVC}/world.html`, { waitUntil: 'networkidle', timeout: 90000 })
  await page.waitForSelector('.seg')
  await page.click('.seg[data-value="assets"]')
  await page.waitForSelector('#assets .asset-pane-bar', { timeout: 30000 })
  await page.evaluate(() => [...document.querySelectorAll('#assets .asset-pane-bar button')].find((b) => /New item/.test(b.textContent))?.click())
  await page.waitForTimeout(400)

  /* ---- 1 · create it: the service stores prompt '' ---- */
  const idIn = page.locator('#assets .field').filter({ hasText: /^id/ }).locator('input')
  await idIn.fill(ID)
  await idIn.dispatchEvent('change')
  await page.locator('#assets button.btn:has-text("Create")').click()
  await page.waitForSelector('#assets textarea.prompt-input', { timeout: 20000 })

  /* ---- 2 · the nothing case: Draw with an empty prompt sends flux NOTHING ---- */
  const before = received().length
  await page.locator('#assets button.btn:has-text("Draw")').first().click()
  await page.waitForTimeout(1500)
  say('draws with an empty box', received().length - before)
  if (received().length !== before) fail.push(`an empty prompt reached the generator: ${JSON.stringify(received().at(-1))}`)
  const refused = await fetch(`${SVC}/assetsvc/catalog/${ID}/image`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  say('service, no prompt at all', refused.status)
  if (refused.status !== 400) fail.push(`the service accepted a draw with no prompt (${refused.status})`)

  /* ---- 3 · type a prompt, do NOT save, Draw ---- */
  const box = page.locator('#assets textarea.prompt-input').first()
  await box.fill(PROMPT)
  // the textarea commits on change, which a real click on Draw fires by blurring it
  await page.locator('#assets button.btn:has-text("Draw")').first().click()
  const t0 = Date.now()
  while (received().length === before && Date.now() - t0 < 20000) await page.waitForTimeout(250)
  const got = received().at(-1)
  say('the generator received', got?.prompt ?? 'nothing')
  if (received().length === before) fail.push('Draw with a typed, unsaved prompt drew nothing')
  else if (got.prompt !== PROMPT) fail.push(`the generator was asked for "${got.prompt}", not what was typed`)

  /* ---- 4 · the draft is still a draft: saving stays a separate decision ---- */
  const item = await fetch(`${SVC}/assetsvc/catalog/${ID}`).then((r) => r.json())
  say('saved prompt after the draw', JSON.stringify(item.prompt ?? item.item?.prompt))
  const view = (item.history ?? item.item?.history ?? []).find((h) => h.step === 'image')
  say('the view records', view?.prompt ?? 'no view')
  if (view && view.prompt !== PROMPT) fail.push('the drawn view does not record the prompt that drew it')
} finally {
  await fetch(`${SVC}/assetsvc/catalog/${ID}`, { method: 'DELETE' }).catch(() => {})
  if (errs.length) { say('page errors', [...new Set(errs)].slice(0, 3)); fail.push(`${errs.length} page errors`) }
  await browser.close()
}
console.log(fail.length ? `\nFAIL:\n  ${fail.join('\n  ')}` : '\nPASS: the prompt in the box is what the generator draws, saved or not, and an empty one draws nothing')
process.exit(fail.length ? 1 : 0)
