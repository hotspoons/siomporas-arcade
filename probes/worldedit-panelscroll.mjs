// Can you reach the bottom of a long form, and are the buttons still there when you get there?
//
// Rich, 2026-09-28, with a screenshot cut off mid-panel: "this is cut off part way down, couldn't
// figure it out. Buttons need to be fixed on the bottom, if the form overflows it needs to scroll
// above the buttons."
//
// `.inspector-body` already said `flex: 1; overflow-y: auto`, which looks like a panel that
// scrolls and is not one: a flex item's automatic minimum size is its CONTENT, so the body grew
// past the bottom of the fixed panel and the overflow had nowhere to happen. Nothing about the
// CSS looked wrong, which is why this probe measures GEOMETRY — is the last control inside the
// panel's box, can the panel be scrolled, do the buttons stay — rather than asserting properties.
//
//   PORT=5185 node probes/worldedit-panelscroll.mjs
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch()
// Deliberately short: the bug only exists when the form is taller than the panel, and a tall
// window hides it. 720 is a laptop.
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 160)))
await page.goto(`http://localhost:${PORT}/world.html`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction(() => window.__we?.ready?.() === true, null, { timeout: 90000 })

const fails = []
const ok = (name, cond, detail) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name} — ${detail}`); if (!cond) fails.push(name) }

// Draw a world, which is what makes the Define panel long: extent, contents, roads, look, name.
await page.evaluate(() => window.__we.setMode('define'))
await page.waitForFunction(() => window.__we.map.mode === 'draw', null, { timeout: 10000 })
await page.mouse.move(380, 300)
await page.mouse.down()
for (let i = 1; i <= 10; i += 1) await page.mouse.move(380 + 24 * i, 300 + 18 * i)
await page.mouse.up()
await page.waitForFunction(() => !!window.__we.define.preview, null, { timeout: 60000 }).catch(() => {})
await page.waitForTimeout(500)

const geom = await page.evaluate(() => {
  const body = document.querySelector('#panel')
  const panel = document.querySelector('aside.inspector')
  const acts = body?.querySelector('.panel-actions')
  const r = (n) => { const b = n.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: b.height } }
  return {
    overflows: body.scrollHeight > body.clientHeight + 1,
    scrollHeight: body.scrollHeight, clientHeight: body.clientHeight,
    bodyBox: r(body), panelBox: r(panel),
    hasActions: !!acts,
    actionsBox: acts ? r(acts) : null,
    buttons: acts ? acts.querySelectorAll('button').length : 0,
  }
})

ok('the form is longer than the panel, which is the case worth testing',
  geom.overflows, `${geom.scrollHeight}px of content in ${geom.clientHeight}px`)
/*
 * AND THE BODY FILLS THE PANEL. Not a nicety: a `display` rule beats the `hidden` attribute, and
 * `.inspector-body` sets `display: grid` — so the second body this page carries for the Place
 * mode, and the actions row beside it, kept their share of the column while showing nothing. The
 * visible body was 299px inside a 657px panel and the only symptom was "the panel seems short".
 */
ok('the scrolling body fills the panel rather than sharing it with hidden siblings',
  geom.bodyBox.h > (geom.panelBox.h - 120) * 0.85,
  `body ${geom.bodyBox.h.toFixed(0)}px of a ${geom.panelBox.h.toFixed(0)}px panel`)
// THE ACTUAL BUG: the body grew past the panel instead of scrolling inside it.
ok('the scrolling area stays inside the panel',
  geom.bodyBox.bottom <= geom.panelBox.bottom + 1,
  `body ends at ${geom.bodyBox.bottom.toFixed(0)}px, panel at ${geom.panelBox.bottom.toFixed(0)}px`)

ok('the panel has its action buttons', geom.hasActions && geom.buttons >= 2, `${geom.buttons} buttons`)

// Scroll to the bottom and check the buttons are ON SCREEN there — the "fixed on the bottom" half.
const after = await page.evaluate(() => {
  const body = document.querySelector('#panel')
  body.scrollTop = body.scrollHeight
  const acts = body.querySelector('.panel-actions')
  const a = acts.getBoundingClientRect()
  const p = document.querySelector('aside.inspector').getBoundingClientRect()
  return { scrolled: body.scrollTop > 0, actTop: a.top, actBottom: a.bottom, panelBottom: p.bottom, panelTop: p.top }
})
ok('it really scrolls', after.scrolled, `scrollTop ${after.scrolled}`)
ok('and the buttons are on screen at the bottom of the scroll',
  after.actBottom <= after.panelBottom + 1 && after.actTop >= after.panelTop,
  `buttons at ${after.actTop.toFixed(0)}–${after.actBottom.toFixed(0)}px, panel ${after.panelTop.toFixed(0)}–${after.panelBottom.toFixed(0)}px`)

// And at the TOP of the scroll too: that is what "fixed on the bottom" means, as opposed to
// "last in the document and therefore reachable if you scroll".
const atTop = await page.evaluate(() => {
  const body = document.querySelector('#panel')
  body.scrollTop = 0
  const a = body.querySelector('.panel-actions').getBoundingClientRect()
  const p = document.querySelector('aside.inspector').getBoundingClientRect()
  return { actBottom: a.bottom, panelBottom: p.bottom, visible: a.top < p.bottom && a.bottom > p.top }
})
ok('the buttons are still visible without scrolling at all',
  atTop.visible && atTop.actBottom <= atTop.panelBottom + 1,
  `buttons end at ${atTop.actBottom.toFixed(0)}px, panel at ${atTop.panelBottom.toFixed(0)}px`)

/*
 * NO LABEL IS A COLUMN OF SINGLE LETTERS.
 *
 * The inspector sets `overflow-wrap: anywhere` so that one long road name cannot push the panel
 * sideways — and that rule reaches labels too, so "Spine", squeezed between the panel edge and a
 * select holding "Crofton Parkway — 6.6 km", broke one letter per line.
 *
 * THE PANEL IS NARROWED ON PURPOSE. At its default width nothing breaks and this check passed
 * against the broken CSS, which makes it a decoration. At 200 px the label is 90 px tall — five
 * lines of one letter — and 18 px once the label is told not to wrap inside a word.
 */
await page.evaluate(() => document.documentElement.style.setProperty('--inspector-w', '200px'))
await page.waitForTimeout(300)
const labels = await page.evaluate(() => {
  const out = []
  for (const n of document.querySelectorAll('#panel .field-label')) {
    const t = (n.textContent ?? '').trim()
    if (!t || t.includes(' ')) continue // one word only: a phrase is allowed to wrap
    const h = n.getBoundingClientRect().height
    const line = parseFloat(getComputedStyle(n).lineHeight) || 16
    out.push({ text: t, lines: +(h / line).toFixed(1) })
  }
  return out
})
const shattered = labels.filter((l) => l.lines > 2.2)
ok('the panel has one-word labels to check, so this can fail', labels.length >= 2, `${labels.length} labels`)
ok('none of them breaks inside the word at 200px',
  shattered.length === 0,
  shattered.length ? shattered.map((l) => `"${l.text}" over ${l.lines} lines`).join(', ')
    : `worst ${Math.max(...labels.map((l) => l.lines)).toFixed(1)} lines`)

await browser.close()
console.log(fails.length ? `\nFAIL: ${fails.length} — ${fails.join('; ')}` : '\nPASS: the panel scrolls and the buttons stay')
process.exit(fails.length ? 1 : 0)
