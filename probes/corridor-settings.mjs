// Settings → Services: set the TRELLIS endpoint in the editor, and the asset service USES it.
//
// Rich, 2026-09-29: "We need to make sure all services are configurable both from env vars and
// from within the editor's UI, so we should be able to configure trellis endpoint, image generator
// endpoint, and the splat pipeline."
//
// THE ASSERTION IS THE REGISTRY, not the setting. A service that saved the URL and kept calling
// the old one would pass any check of "the value was stored". So after saving through the UI this
// asks /assetsvc/models where the mesh model now points — which is what a job would dial.
//
//   node probes/corridor-settings.mjs
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5185'
const SVC = process.env.WORLDEDITOR ?? 'http://localhost:8780'
const fail = []
const say = (k, v) => console.log(`${k.padEnd(30)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)
const TRY = 'http://recon-probe.example.svc'

const models = () => fetch(`${SVC}/assetsvc/models`).then((r) => r.json())
const meshUrl = async () => {
  const d = await models()
  return d.models.find((m) => m.id === d.defaults.mesh)?.url
}
const row = async (path, key) => (await fetch(`${SVC}${path}`).then((r) => r.json())).settings.find((s) => s.key === key)

// whatever it is now, so the probe leaves it as it found it
const before = await row('/assetsvc/settings', 'url.trellis2')
say('trellis endpoint before', { value: before.value, source: before.source })
if (before.source === 'ui') await fetch(`${SVC}/assetsvc/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ 'url.trellis2': null }) })

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]))
await page.goto(`http://localhost:${PORT}/world.html`, { waitUntil: 'networkidle', timeout: 90000 })
await page.waitForFunction(() => window.__we?.ready(), null, { timeout: 90000 })

/* ---- 1 · both services' settings are in the panel, each saying where it came from ---- */
await page.click('.topbar button[title="settings"]')
await page.waitForTimeout(600)
await page.click('.dialog .tab:has-text("Services")')
await page.waitForFunction(() => document.querySelectorAll('.dialog .setting-row').length > 8, null, { timeout: 30000 }).catch(() => {})
const shown = await page.$$eval('.dialog .setting-row', (rows) => rows.map((r) => ({
  label: r.querySelector('.field-label')?.textContent?.trim(),
  source: r.querySelector('.setting-source')?.textContent?.trim(),
})))
say('rows in the panel', shown.length)
const labels = shown.map((s) => s.label)
for (const want of ['trellis2 endpoint', 'flux2-dev endpoint', 'Image generator', 'Runner', 'Training image', 'Asset service']) {
  if (!labels.includes(want)) fail.push(`no "${want}" setting in the panel`)
}
if (shown.some((s) => !s.source)) fail.push('a setting does not say where its value came from')

/* ---- 2 · set TRELLIS's endpoint through the UI and save ---- */
const field = page.locator('.dialog .setting-row').filter({ hasText: 'trellis2 endpoint' }).locator('input')
await field.fill(TRY)
await field.dispatchEvent('change')
const section = page.locator('.dialog .settings-section').filter({ hasText: 'trellis2 endpoint' })
await section.locator('button:has-text("Save")').click()
await page.waitForTimeout(1200)

const saved = await row('/assetsvc/settings', 'url.trellis2')
say('after saving in the UI', { value: saved.value, source: saved.source })
if (saved.value !== TRY) fail.push(`the setting holds ${saved.value}, not what was typed`)
if (saved.source !== 'ui') fail.push(`the setting says it came from "${saved.source}", not the UI`)

// THE POINT: the registry the next job reads from has moved
const now = await meshUrl()
say('the mesh model now dials', now)
if (now !== TRY) fail.push(`the asset service still dials ${now} — it saved the URL and kept the old one`)

/* ---- 3 · the panel shows it as set here, with a reset that names where it goes ---- */
await page.waitForFunction(() => [...document.querySelectorAll('.dialog .setting-row')]
  .some((r) => /trellis2 endpoint/.test(r.textContent) && r.querySelector('.source-ui')), null, { timeout: 15000 }).catch(() => {})
const reset = page.locator('.dialog .setting-row').filter({ hasText: 'trellis2 endpoint' }).locator('button:has-text("Reset")')
const resetLabel = await reset.textContent().catch(() => null)
say('reset button', resetLabel?.trim() ?? 'none')
if (!resetLabel) fail.push('a value set here offers no way back')
else {
  await reset.click()
  await page.waitForTimeout(1200)
  const back = await row('/assetsvc/settings', 'url.trellis2')
  say('after reset', { value: back.value, source: back.source })
  if (back.source === 'ui') fail.push('reset left the UI value in place')
  if (back.value !== before.value) fail.push(`reset landed on ${back.value}, not ${before.value}`)
  if ((await meshUrl()) !== before.value) fail.push('reset did not move the registry back')
}

/* ---- 4 · the world editor's own settings, same mechanism ---- */
const r0 = await row('/api/settings', 'splat.runner')
const put = await fetch(`${SVC}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ 'splat.runner': 'kubeflow' }) })
say('a runner that is not one', put.status)
if (put.status !== 400) fail.push('an invalid runner was accepted')
if ((await row('/api/settings', 'splat.runner')).value !== r0.value) fail.push('a refused patch changed something')
const plan = await fetch(`${SVC}/api/training/plan`).then((r) => r.json())
say('the splat plan reports', { via: plan.via, runner: plan.runner, pinned: plan.pinned })
if (!('pinned' in plan)) fail.push('the plan does not say which runner the setting pins')

if (errs.length) { say('page errors', [...new Set(errs)].slice(0, 3)); fail.push(`${errs.length} page errors`) }
console.log(fail.length ? `\nFAIL:\n  ${fail.join('\n  ')}` : '\nPASS: TRELLIS set from the UI is what the asset service dials, and reset puts it back')
await browser.close()
process.exit(fail.length ? 1 : 0)
