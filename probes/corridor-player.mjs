// Can you say which car you drive, and does it survive the round trip?
//
// Rich, 2026-09-29: "I have no idea how to take a car model and attach a physics model to it,
// configure the engine sound and performance, overall car performance, and use it in a level."
// The last clause had no answer at all — a level could place a car as SCENERY and had no field
// for the one you sit in.
//
// THIS IS THE AUTHORING HALF ONLY. It asserts that the picker exists, that it lists what the
// library holds rather than a hard-coded roster, and that the choice reaches the document on
// disk. Whether the VIEWER then drives that car is a separate claim and this does not make it.
//
//   node probes/corridor-player.mjs
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5185'
const SVC = process.env.WORLDEDITOR ?? 'http://localhost:8780'
const ID = 'zzprobe-player'
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]))
const fail = []
const say = (k, v) => console.log(`${k.padEnd(26)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)

await fetch(`${SVC}/api/levels/${ID}`, { method: 'DELETE' }).catch(() => {})

/* ---- 1 · the service takes it, and refuses the things it should ---- */
const worlds = await fetch(`${SVC}/api/worlds`).then((r) => r.json())
const world = (worlds.worlds ?? []).find((w) => w.baked)?.slug
if (!world) { console.log('\nSKIP: nothing baked on this volume'); await browser.close(); process.exit(0) }

const cars = await fetch('http://localhost:8790/catalog').then((r) => r.json()).then((j) => j.items.filter((i) => /hero-car|traffic|emergency|commercial-vehicle/.test(i.kind))).catch(() => [])
say('vehicles in the library', cars.length)
if (!cars.length) fail.push('the library holds no vehicles — nothing to pick')
const car = cars[0]?.id

// POST creates, PUT updates by id — the route, not a guess about it
const send = (body, method) => fetch(`${SVC}/api/levels${method === 'PUT' ? `/${ID}` : ''}`, {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
const create = (b) => send(b, 'POST')
const put = (b) => send(b, 'PUT')

const good = await create({ id: ID, world, mode: 'drive', player: { vehicle: car, profile: 'sim' } })
say('saved', good.status)
if (good.status >= 400) fail.push(`the service refused a valid player: ${JSON.stringify(good.body).slice(0, 140)}`)

const badProfile = await put({ id: ID, world, mode: 'drive', player: { vehicle: car, profile: 'realistic' } })
say('a profile that is not one', [badProfile.status, JSON.stringify(badProfile.body?.errors ?? badProfile.body?.error ?? '').slice(0, 60)])
if (badProfile.status < 400) fail.push('a made-up handling profile was accepted')

const noVehicle = await put({ id: ID, world, mode: 'drive', player: { profile: 'sim' } })
if (noVehicle.status < 400) fail.push('a player naming no vehicle was accepted')

// put the good one back, since the two refusals must not have changed it
await put({ id: ID, world, mode: 'drive', player: { vehicle: car, profile: 'sim' } })
const stored = await fetch(`${SVC}/api/levels/${ID}`).then((r) => r.json())
say('on disk', stored.level?.player ?? stored.player ?? 'nothing')
const onDisk = stored.level?.player ?? stored.player
if (onDisk?.vehicle !== car) fail.push(`the document says ${JSON.stringify(onDisk)} rather than ${car}`)

/* ---- 2 · the picker, in the editor ---- */
await page.goto(`http://localhost:${PORT}/world.html`, { waitUntil: 'networkidle', timeout: 90000 })
await page.waitForFunction(() => window.__we?.ready(), null, { timeout: 90000 })
await page.click('.topbar .seg[data-value="stage"]')
await page.waitForTimeout(2500)
await page.click(`#panel .row:has-text("${ID}")`).catch(() => {})
await page.waitForTimeout(1800)

const form = await page.evaluate(() => {
  const labels = [...document.querySelectorAll('#panel .field-label')].map((n) => n.textContent.trim())
  const sel = [...document.querySelectorAll('#panel select')]
  const vehicle = sel.find((s) => s.closest('.field')?.textContent?.startsWith('vehicle'))
  const handling = sel.find((s) => s.closest('.field')?.textContent?.startsWith('handling'))
  return {
    labels,
    options: vehicle ? vehicle.options.length : 0,
    chosen: vehicle?.value ?? null,
    profile: handling?.value ?? null,
    wheels: [...document.querySelectorAll('#panel .readout')].map((n) => n.textContent).find((t) => /wheels/.test(t)) ?? null,
  }
})
say('the form', { vehicle: form.labels.includes('vehicle'), handling: form.labels.includes('handling'), options: form.options })
say('it opened on', { chosen: form.chosen, profile: form.profile })
say('wheels readout', form.wheels)
if (!form.labels.includes('vehicle')) fail.push('the level form has no way to choose what you drive')
// the LIBRARY, not a roster: one option per vehicle plus "the built-in car"
if (form.options !== cars.length + 1) fail.push(`the picker offers ${form.options} options for ${cars.length} vehicles — it is not reading the library`)
if (form.chosen !== car) fail.push(`the picker opened on ${form.chosen}, not on what the document says (${car})`)
if (form.profile !== 'sim') fail.push(`the handling shows ${form.profile}, not the stored sim`)
// unrigged must not read as a problem
if (form.wheels && !/no rig — it drives the same/.test(form.wheels)) {
  if (!/bones — they will turn/.test(form.wheels)) fail.push(`the wheels readout says "${form.wheels}"`)
}

await fetch(`${SVC}/api/levels/${ID}`, { method: 'DELETE' }).catch(() => {})
if (errs.length) { say('page errors', [...new Set(errs)].slice(0, 3)); fail.push(`${errs.length} page errors`) }
console.log(fail.length ? `\nFAIL:\n  ${fail.join('\n  ')}` : '\nPASS: a level names the car you drive, the picker reads the library, and the choice is on disk')
await browser.close()
process.exit(fail.length ? 1 : 0)
