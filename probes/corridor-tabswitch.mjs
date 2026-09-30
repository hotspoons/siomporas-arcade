// Switching library tabs shows ONE screen.
//
// Rich, 2026-09-29: "clicking actors and weapons stacks the tabs instead of switching them". The
// cause was a CSS `display` rule outranking the UA's `[hidden] { display: none }`, so this asserts
// the RENDERED HEIGHT of each panel, not the attribute — the attribute was correct the whole time
// and that is exactly why nothing caught it.
import { chromium } from 'playwright'
const svc = process.env.ASSETSVC ?? 'http://localhost:8770'
const url = process.env.EDITOR ?? 'http://127.0.0.1:5185/editor.html'
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 1280, height: 900 } })
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)))
await p.goto(`${url}?assetsvc=${svc}#bowie-racetrack-rd`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.__apexEditorAssets, null, { timeout: 180000 })
await p.waitForTimeout(12000)
await p.evaluate(() => window.__apexEditorAssets())
await p.waitForTimeout(1500)

const visible = () => p.evaluate(() => [...document.querySelectorAll('.bld-screen')]
  .filter((n) => n.getBoundingClientRect().height > 0).length)

let bad = 0
for (const tab of ['Vehicles', 'Actors', 'Weapons', 'Vehicles']) {
  await p.evaluate((t) => [...document.querySelectorAll('.tab')].find((b) => b.textContent.trim() === t)?.click(), tab)
  await p.waitForTimeout(2500)
  const n = await visible()
  console.log(`${tab}: ${n} build screen(s) rendered`)
  if (n !== 1) { bad++; console.log(`  FAIL — expected exactly 1`) }
}

/*
 * PROVE THE CHECK CAN FAIL. Put the display rule back the way it was and the same measurement must
 * report three — otherwise this probe passes for a reason that has nothing to do with the bug.
 */
await p.addStyleTag({ content: '.bld-screen[hidden] { display: flex !important; }' })
await p.waitForTimeout(600)
const broken = await visible()
console.log(`with the fix defeated: ${broken} rendered`)
if (broken < 2) { bad++; console.log('  FAIL — the check cannot detect the bug it exists for') }

console.log(bad ? `FAILED (${bad})` : 'OK — one screen at a time, and the check can fail')
await b.close()
process.exit(bad ? 1 : 0)
