#!/usr/bin/env node
// The new adjustment keys, end to end: select an area, set each new key through the PANEL (the
// same DOM a human uses, not the model behind it), save, and read the file back off disk.
import { chromium } from 'playwright'

const slug = process.argv[2] ?? 'frederick-i70'
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const p = await b.newPage({ viewport: { width: 1400, height: 950 } })
await p.route('**/@vite/client', (r) => r.abort())
p.on('pageerror', (e) => console.log('pageerror:', e.message))
await p.goto(`http://localhost:5207/editor.html#${slug}:areas`, { waitUntil: 'load' })
await p.waitForFunction(() => document.querySelector('#status')?.textContent === '' && !!window.corridor?.site, null, { timeout: 300000 })
await p.waitForTimeout(1200)

const id = await p.evaluate(() => {
  const a = window.corridor.areas.doc.areas[0]
  window.corridor.areas.select(a.id)
  return a.id
})
console.log('selected', id)

/** set a <select> by its visible label, the way a person does */
const pick = async (label, value) => {
  const ok = await p.evaluate(({ label, value }) => {
    for (const f of document.querySelectorAll('#body .field')) {
      if (f.querySelector('span')?.textContent !== label) continue
      const sel = f.querySelector('select')
      if (!sel) return 'no select'
      sel.value = value
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return 'ok'
    }
    return 'no field'
  }, { label, value })
  console.log(`  ${label} = ${value}: ${ok}`)
  await p.waitForTimeout(250)
}

await pick('markings', 'full')
await pick('centre line', 'solid')
await pick('ground cover', 'crop')
await pick('crop', 'corn')

console.log('after cover=crop, panel shows:', await p.evaluate(() =>
  [...document.querySelectorAll('#body .field span:first-child')].map((s) => s.textContent).join(' | ')))

await p.keyboard.down('Control'); await p.keyboard.press('s'); await p.keyboard.up('Control')
await p.waitForFunction(() => /saved/.test(document.querySelector('#status')?.textContent ?? ''), null, { timeout: 30000 })
console.log('status:', await p.textContent('#status'))
console.log('in memory:', await p.evaluate((id) => JSON.stringify(window.corridor.areas.doc.areas.find((a) => a.id === id).adjust), id))
await b.close()
