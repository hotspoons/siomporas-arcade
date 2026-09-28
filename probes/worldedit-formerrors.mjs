// A form says what is wrong ON the form.
//
// Rich, 2026-09-28: "need error marking on forms (e.g. red outline on text boxes) and focus
// handling for things like 'give it a slug first' and no toast for this, just show it on the form
// and hide once you start filling."
//
// Both of those checks used to be `toast(..., 'warn')`: a message about a specific field, shown
// somewhere else on the screen, for four seconds, with no indication of which field and no way to
// read it again. On a form long enough to scroll, the field it is about may not even be in view.
//
// So this asserts the absence of the toast as hard as it asserts the presence of the marking —
// a version that did both would still be wrong.
//
//   PORT=5185 node probes/worldedit-formerrors.mjs
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 160)))
await page.goto(`http://localhost:${PORT}/world.html`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction(() => window.__we?.ready?.() === true, null, { timeout: 90000 })

const fails = []
const ok = (name, cond, detail) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name} — ${detail}`); if (!cond) fails.push(name) }

const slugState = () => page.evaluate(() => {
  const f = [...document.querySelectorAll('#panel .field.text')].find((n) => n.textContent.trim().startsWith('slug'))
  if (!f) return null
  const input = f.querySelector('input')
  const cs = getComputedStyle(input)
  return {
    invalid: f.classList.contains('invalid'),
    message: f.querySelector('.field-error')?.textContent ?? null,
    focused: document.activeElement === input,
    aria: input.getAttribute('aria-invalid'),
    borderColor: cs.borderColor,
  }
})
const toasts = () => page.evaluate(() => document.querySelectorAll('.toast, [class*="toast"]').length)
const clickCreate = () => page.evaluate(() => {
  const b = [...document.querySelectorAll('#panel > .panel-actions button')]
    .find((n) => /create world|save changes/i.test(n.textContent ?? ''))
  b?.click()
  return !!b
})

await page.evaluate(() => window.__we.setMode('define'))
await page.waitForFunction(() => window.__we.map.mode === 'draw', null, { timeout: 10000 })
await page.waitForTimeout(300)

// Nothing drawn, nothing typed. Submit.
const before = await toasts()
ok('there is a Create button to press', await clickCreate(), 'found it')
await page.waitForTimeout(400)

const s = await slugState()
ok('the slug field is marked invalid', s?.invalid === true, `invalid=${s?.invalid}`)
ok('with the reason under it', !!s?.message, JSON.stringify(s?.message))
ok('the outline is actually red, not just a class name',
  /rgb\(\s*(2[0-9]{2}|1[89][0-9])/.test(s?.borderColor ?? ''), s?.borderColor ?? 'none')
ok('and it is announced to assistive tech', s?.aria === 'true', `aria-invalid=${s?.aria}`)
ok('the cursor is put in it', s?.focused === true, `focused=${s?.focused}`)
// THE POINT: no toast.
ok('and NO toast was raised', (await toasts()) <= before, `${await toasts()} toasts (was ${before})`)

// The extent is not a text field, so its complaint goes on the group it lives under.
const extent = await page.evaluate(() => {
  const g = [...document.querySelectorAll('#panel .group')].find((n) => /extent/i.test(n.querySelector('.group-head')?.textContent ?? ''))
  return { invalid: g?.classList.contains('invalid') ?? false, message: g?.querySelector('.group-error')?.textContent ?? null }
})
ok('the extent says so on its group, since it is the map that is empty',
  extent.invalid && !!extent.message, extent.message ?? 'no message')

// "hide once you start filling" — on the first keystroke, not on blur.
await page.evaluate(() => {
  const f = [...document.querySelectorAll('#panel .field.text')].find((n) => n.textContent.trim().startsWith('slug'))
  const input = f.querySelector('input')
  input.focus()
})
await page.keyboard.type('c')
await page.waitForTimeout(150)
const after = await slugState()
ok('the error clears at the FIRST keystroke, without leaving the field',
  after?.invalid === false && !after?.message, `invalid=${after?.invalid}, message=${JSON.stringify(after?.message)}`)

// And drawing an area clears the extent complaint the same way.
await page.mouse.move(400, 320)
await page.mouse.down()
for (let i = 1; i <= 8; i += 1) await page.mouse.move(400 + 25 * i, 320 + 20 * i)
await page.mouse.up()
await page.waitForFunction(() => !!window.__we.define.preview, null, { timeout: 60000 }).catch(() => {})
await page.waitForTimeout(300)
const extentAfter = await page.evaluate(() => {
  const g = [...document.querySelectorAll('#panel .group')].find((n) => /extent/i.test(n.querySelector('.group-head')?.textContent ?? ''))
  return { invalid: g?.classList.contains('invalid') ?? false, message: g?.querySelector('.group-error')?.textContent ?? null }
})
ok('and drawing an area clears the extent complaint', !extentAfter.invalid && !extentAfter.message,
  `invalid=${extentAfter.invalid}`)

await browser.close()
console.log(fails.length ? `\nFAIL: ${fails.length} — ${fails.join('; ')}` : '\nPASS: the form says what is wrong, on the form')
process.exit(fails.length ? 1 : 0)
