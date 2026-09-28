// Is anything in a panel covered by the panel's own furniture?
//
// The inspector pins a panel's TRAILING action bar to the bottom so a long form scrolls behind it
// ("buttons need to be fixed on the bottom, if the form overflows it needs to scroll above the
// buttons" — Rich, 2026-09-28). That rule matched EVERY `.panel-actions`, and its -48px bottom
// margin — there to undo the body's bottom padding so the bar reaches the edge — pulled whatever
// came next up underneath an opaque background with a z-index over it. The Assets panel opens with
// an actions block, so "Back to the roster" rendered at its full 32 px and was invisible.
//
// WHICH IS WHY THIS ASKS `elementFromPoint`, not `getBoundingClientRect`. The button was the right
// size, in the right place, and covered. Height told us nothing; so would `[hidden]`, so would
// `display`. What is actually on top of the middle of the thing is the question.
//
//   node probes/corridor-panelchrome.mjs
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5185'
const ASSETSVC = process.env.ASSETSVC ?? ''
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1200, height: 700 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
await page.goto(`http://localhost:${PORT}/world.html${ASSETSVC ? `?assetsvc=${ASSETSVC}` : ''}`, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForSelector('.seg', { timeout: 30000 })

const fail = []
const say = (k, v) => console.log(`${k.padEnd(30)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)

/** Every button in the inspector, and whether its own middle belongs to it. */
const audit = () => page.evaluate(() => {
  const panel = document.getElementById('panel')
  if (!panel) return { error: 'no #panel' }
  const out = []
  for (const b of panel.querySelectorAll('button')) {
    const r = b.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) { out.push({ label: b.textContent?.trim().slice(0, 28), why: 'no size', h: Math.round(r.height) }); continue }
    // only what is scrolled into view AND inside the window can be asked about: elementFromPoint
    // answers null for a point outside the viewport, which is not the same as "covered"
    const body = panel.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    if (r.bottom < body.top || r.top > body.bottom) continue
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue
    const at = document.elementFromPoint(cx, cy)
    if (!at || at === b || b.contains(at)) continue
    // BY DESIGN: the trailing bar is pinned and the form scrolls behind it. Something under that
    // particular element is the feature, not the bug — anything else on top is not.
    const bar = panel.lastElementChild?.classList.contains('panel-actions') ? panel.lastElementChild : null
    if (bar && (at === bar || bar.contains(at))) continue
    out.push({ label: b.textContent?.trim().slice(0, 28), why: 'covered', by: `${at.tagName}.${String(at.className).split(' ')[0]}` })
  }
  return { covered: out, buttons: panel.querySelectorAll('button').length }
})

for (const mode of ['Define', 'Bake', 'Stage', 'Assets', 'Splats', 'Program', 'Shell', 'Agent']) {
  const ok = await page.evaluate((m) => {
    const b = [...document.querySelectorAll('.seg')].find((x) => x.textContent?.trim() === m)
    if (!b) return false
    b.click()
    return true
  }, mode)
  if (!ok) { fail.push(`there is no ${mode} mode`); continue }
  await page.waitForTimeout(1200)
  // where a mode opens on a list, go one level in: that is where a panel has both a top actions
  // block and content under it, which is the shape that broke
  await page.evaluate(() => {
    const r = document.querySelector('#panel .row')
    if (r) r.click()
  })
  await page.waitForTimeout(1600)
  const r = await audit()
  say(mode, r.error ?? `${r.buttons} buttons, ${r.covered.length} covered`)
  for (const c of r.covered ?? []) {
    say('  ' + c.label, `${c.why}${c.by ? ` by ${c.by}` : ''}`)
    fail.push(`${mode}: "${c.label}" is ${c.why}${c.by ? ` by ${c.by}` : ''}`)
  }
}

// AND THE BAR STILL STICKS where it is supposed to: a panel whose actions ARE last must pin them,
// or this fix has broken the thing the rule was written for.
const sticky = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.seg')].find((x) => x.textContent?.trim() === 'Define')
  b?.click()
  return new Promise((r) => setTimeout(() => {
    const panel = document.getElementById('panel')
    const last = panel?.lastElementChild
    r({
      lastIsActions: last?.classList.contains('panel-actions') ?? false,
      position: last ? getComputedStyle(last).position : null,
      scrolls: panel ? panel.scrollHeight > panel.clientHeight + 8 : false,
    })
  }, 1500))
})
say('Define: trailing bar', sticky)
if (!sticky.lastIsActions) fail.push('the Define panel does not end with an actions bar, so stickiness was not tested')
else if (sticky.position !== 'sticky') fail.push(`a trailing actions bar is ${sticky.position}, not sticky — the fix broke what the rule was for`)

if (errs.length) fail.push('page errors: ' + errs.slice(0, 2).join(' | '))
try { await page.screenshot({ path: 'shots/panel-chrome.png', timeout: 60000 }) } catch { /* the verdict is the measurement */ }
await browser.close()
if (fail.length) { console.log('\nFAIL:\n  ' + fail.join('\n  ')); process.exit(1) }
console.log('\nPASS: nothing in a panel is covered by the panel, and a trailing bar still sticks')
