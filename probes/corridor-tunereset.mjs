// Reset buttons in the tuning panel: one per knob, one per section, one per tab.
//   PORT=5185 node probes/corridor-tunereset.mjs
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5185'
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const p = await b.newPage({ viewport: { width: 1200, height: 800 } })
p.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await p.route('**/@vite/client', (r) => r.abort())
await p.goto(`http://localhost:${PORT}/?lite=1&fresh#crofton-triangle`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.corridor?.site, null, { timeout: 600000 })
await p.waitForTimeout(2500)
let fails = 0
const ok = (what, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`); if (!cond) fails++ }
const get = (n) => p.evaluate((n) => window.corridor.tune.get(n), n)
const set = (n, v) => p.evaluate(({ n, v }) => window.corridor.tune.set(n, v), { n, v })
await p.keyboard.press('F6')
await p.waitForTimeout(800)
ok('F6 opens the panel', await p.evaluate(() => !!document.querySelector('.group')))
// move two knobs in the same section, and one in another
const A = 'GRASS_WIND', B = 'GRASS_DRY_ADD', C = 'TREE_CELL_M'
const defs = { A: await get(A), B: await get(B), C: await get(C) }
await set(A, defs.A + 0.2); await set(B, defs.B + 0.3); await set(C, defs.C + 4)
await p.waitForTimeout(600)
// the section holding A should now be marked, and show a reset button
const marked = await p.evaluate((name) => {
  for (const g of document.querySelectorAll('.group')) {
    if (![...g.querySelectorAll('.field-label')].some((l) => l.textContent === name)) continue
    return { changed: g.classList.contains('changed'), hasAction: !!g.querySelector('.group-actions .btn'), title: g.querySelector('.group-head span')?.textContent }
  }
  return null
}, A)
ok('the section holding a moved knob is marked', marked?.changed === true, JSON.stringify(marked))
ok('and carries its own reset button', marked?.hasAction === true)
// the per-knob reset appears on the moved knob and puts just that one back
const clicked = await p.evaluate((name) => {
  for (const f of document.querySelectorAll('.field.slider')) {
    if (f.querySelector('.field-label')?.textContent !== name) continue
    const btn = f.querySelector('.field-reset')
    if (!btn) return 'no button'
    if (getComputedStyle(btn).display === 'none') return 'button hidden'
    btn.click()
    return 'clicked'
  }
  return 'field not found'
}, A)
ok('the moved knob shows a reset', clicked === 'clicked', clicked)
await p.waitForTimeout(400)
ok('and clicking it restores only that knob', Math.abs((await get(A)) - defs.A) < 1e-9 && Math.abs((await get(B)) - (defs.B + 0.3)) < 1e-9, `${A}=${await get(A)} (want ${defs.A}), ${B}=${await get(B)} (want ${defs.B + 0.3})`)
// the section reset puts the rest of that section back but leaves other sections alone
await p.evaluate((name) => {
  for (const g of document.querySelectorAll('.group')) {
    if (![...g.querySelectorAll('.field-label')].some((l) => l.textContent === name)) continue
    g.querySelector('.group-actions .btn')?.click()
    return
  }
}, B)
await p.waitForTimeout(600)
ok('the section reset restores its own knobs', Math.abs((await get(B)) - defs.B) < 1e-9, `${B}=${await get(B)} want ${defs.B}`)
ok('and leaves other sections alone', Math.abs((await get(C)) - (defs.C + 4)) < 1e-9, `${C}=${await get(C)} want ${defs.C + 4}`)
const unmarked = await p.evaluate((name) => {
  for (const g of document.querySelectorAll('.group')) if ([...g.querySelectorAll('.field-label')].some((l) => l.textContent === name)) return g.classList.contains('changed')
  return null
}, B)
ok('the section stops being marked once it is back', unmarked === false)
await set(C, defs.C)
console.log(fails ? `FAIL ${fails}` : 'PASS')
await b.close()
process.exit(fails ? 1 : 0)
