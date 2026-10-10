// Stages from the viewer, and L for the lights.
//
// Rich, 2026-09-30: "we need a way to select stages from the viewer interface (currently no
// facility exists). And keep automatic lights at night, but add a key shortcut, L, to turn them
// on and off." The drawer lists the stages set in the world on screen with the open one marked;
// L overrides the automatic headlights until the night changes.
import { chromium } from 'playwright'
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 900, height: 640 } })
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)))
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext = () => ({ accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, on(){}, off(){}, send(){}, data:{} }); export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u; export const ErrorOverlay = class {}; export default {}' }))
let bad = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }
await p.goto('http://127.0.0.1:5185/index.html#crofton-triangle?level=crofton-jam', { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.__apex?.traffic && !!window.__apex?.drive?.on && window.__apex?.car?.constructor?.name === 'RapierCar', null, { timeout: 240000 })
// the stage list arrives after the level; give it a moment
await p.waitForFunction(() => [...document.querySelectorAll('.drawer-section')].some((s) => s.querySelector('h3')?.textContent === 'Stages' && s.querySelectorAll('.drawer-item').length > 0), null, { timeout: 30000 }).catch(() => {})
const r = await p.evaluate(() => {
  const ap = window.__apex
  const sec = [...document.querySelectorAll('.drawer-section')].find((s) => s.querySelector('h3')?.textContent === 'Stages')
  const items = sec ? [...sec.querySelectorAll('.drawer-item')].map((b) => ({ label: b.querySelector('.drawer-item-label')?.textContent, on: b.classList.contains('on') })) : null
  const lit = () => ap.car.body.lightsOn
  const press = () => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyL', key: 'l', bubbles: true }))
  const before = lit()
  press()
  const after1 = lit()
  press()
  const after2 = lit()
  return { items, before, after1, after2 }
})
console.log(JSON.stringify(r))
check(Array.isArray(r.items) && r.items.some((i) => i.label === 'crofton-jam' && i.on), `the drawer lists the world's stages with the open one marked (${JSON.stringify(r.items)})`)
check(r.items?.some((i) => i.label === 'Free roam'), 'and offers free roam while a stage is open')
check(r.items?.some((i) => i.label === 'crofton-dusk'), 'the other stage set on this world is there too')
// the headless clock is UTC, so 'now' may be dusk and the lamps already dimly on: L flips
// whatever they are, and flips them back
const litBefore = r.before > 0.05
check((litBefore ? r.after1 < 0.05 : r.after1 > 0.9) && (litBefore ? r.after2 > 0.9 : r.after2 < 0.05), `L turns the lights ${litBefore ? 'off, and again on' : 'on, and again off'} (${r.before.toFixed(2)} → ${r.after1} → ${r.after2})`)
await b.close()
process.exit(bad ? 1 : 0)
