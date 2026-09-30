// The World tab: a world picks its textures from the library, saves them, and the road redraws.
//
// Rich, 2026-09-30: "per world we can pick the textures from the place editor". Also: the
// palette lists what the library has (no hand-typed boxes), and Grow is a tab inside Place.
import { chromium } from 'playwright'
import { readFileSync, unlinkSync, existsSync } from 'node:fs'
const FILE = 'tools/corridor/data/sites/crofton-triangle/surfaces.json'
const before = existsSync(FILE) ? readFileSync(FILE, 'utf8') : null
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 1200, height: 800 } })
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)))
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext = () => ({ accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, on(){}, off(){}, send(){}, data:{} }); export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u; export const ErrorOverlay = class {}; export default {}' }))
let bad = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }
await p.goto('http://127.0.0.1:5185/editor.html#crofton-triangle:world', { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.corridor?.site, null, { timeout: 240000 })
await p.keyboard.press('7')
await p.waitForFunction(() => document.querySelectorAll('.inspector-body .world-surfaces select').length > 0, null, { timeout: 60000 }).catch(() => {})
const r = await p.evaluate(async () => {
  const insp = document.querySelector('.inspector-body')
  const selects = [...insp.querySelectorAll('.world-surfaces select')]
  const roadSel = selects[0]
  const opts = [...roadSel.options].map((o) => o.value)
  // choose chipseal for the first road class, one wall and one roof, and save
  const pick = opts.find((v) => v === 'chipseal') ?? opts[1]
  roadSel.value = pick
  roadSel.dispatchEvent(new Event('change', { bubbles: true }))
  const chips = [...insp.querySelectorAll('.world-surfaces .palette .chip')]
  chips[0]?.click()
  chips[chips.length - 1]?.click()
  const roadName = window.corridor.site.group.getObjectByName('road')?.children.map((c) => c.name).filter((n) => n.startsWith('road:'))
  insp.querySelector('.world-surfaces button.primary').click()
  await new Promise((r) => setTimeout(r, 2500))
  const surfaces = window.corridor.site.surfaces()
  // the palette in Place: chips come from the library merge; none of the old box entries
  window.corridor.setMode('place')
  await new Promise((r) => setTimeout(r, 400))
  const palChips = [...document.querySelectorAll('.inspector-body .palette .chip .nm')].map((x) => x.textContent)
  const tabs = [...document.querySelectorAll('.inspector-body .tab')].map((x) => x.textContent.trim())
  return { selects: selects.length, options: opts.length, pick, chips: chips.length, surfaces, roadName, palChips: palChips.length, hasBox: palChips.some((n) => /gas station|strip mall|big-box/i.test(n ?? '')), tabs }
})
console.log(JSON.stringify(r))
check(r.selects >= 3 && r.options > 2, `the World tab lists the road classes and the grasses with the library's materials (${r.selects} selects, ${r.options} choices)`)
check(r.chips >= 10, `and the wall and roof pools as chips (${r.chips})`)
check(r.surfaces?.road && Object.values(r.surfaces.road)[0] === r.pick && (r.surfaces.buildings?.walls?.length ?? 0) >= 1, `saving writes the choices and the site takes them (${JSON.stringify(r.surfaces)})`)
const saved = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : null
check(!!saved?.road, `surfaces.json is on disk (${saved ? Object.keys(saved).join(',') : 'missing'})`)
check(r.palChips > 5 && !r.hasBox, `the Place palette draws from the library, without the hand-typed boxes (${r.palChips} chips)`)
check(r.tabs.some((t) => /grow/i.test(t)), `Grow is a tab inside Place (${r.tabs.join(' | ')})`)
// leave the world as it was
if (before === null) { if (existsSync(FILE)) unlinkSync(FILE) } else { const { writeFileSync } = await import('node:fs'); writeFileSync(FILE, before) }
await b.close()
process.exit(bad ? 1 : 0)
