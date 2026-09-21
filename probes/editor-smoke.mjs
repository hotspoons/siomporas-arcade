#!/usr/bin/env node
// Does the whole editor still work? Four modes, the preview, and a save — after other agents'
// merges land in this shared tree. Cheap to run, and the thing most likely to catch a break that
// tsc cannot see: a panel that throws, a mode that renders nothing, a save path that 404s.
//   node probes/editor-smoke.mjs [slug]
import { chromium } from 'playwright'

const slug = process.argv[2] ?? 'frederick-i70'
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const p = await b.newPage({ viewport: { width: 1500, height: 950 } })
await p.route('**/@vite/client', (r) => r.abort())
const errs = []
p.on('pageerror', (e) => errs.push(e.message))
p.on('console', (m) => { if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errs.push(`console: ${m.text()}`) })
p.on('dialog', (d) => d.accept())

await p.goto(`http://localhost:5207/editor.html#${slug}:areas`, { waitUntil: 'load' })
await p.waitForFunction(() => document.querySelector('#status')?.textContent === '' && !!window.corridor?.site, null, { timeout: 300000 })
await p.waitForTimeout(1200)
let bad = 0
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); if (!ok) bad++ }

check('site loaded', await p.evaluate(() => !!window.corridor.site), await p.evaluate(() => window.corridor.site.manifest.slug))
check('areas seeded', (await p.evaluate(() => window.corridor.areas.doc.areas.length)) > 0, `${await p.evaluate(() => window.corridor.areas.doc.areas.length)} areas`)

for (const [key, mode] of [['1', 'areas'], ['2', 'place'], ['3', 'grow'], ['4', 'structures']]) {
  await p.keyboard.press(key)
  await p.waitForTimeout(500)
  const n = await p.evaluate(() => document.querySelector('#body')?.childElementCount ?? 0)
  check(`mode ${mode} renders a panel`, n > 0, `${n} nodes`)
}

// the area detail panel is where the new keys live
await p.keyboard.press('1')
await p.evaluate(() => window.corridor.areas.select(window.corridor.areas.doc.areas[0].id))
await p.waitForTimeout(400)
const fields = await p.evaluate(() => [...document.querySelectorAll('#body .field span:first-child')].map((s) => s.textContent))
check('area panel has the new keys', ['markings', 'centre line', 'ground cover'].every((k) => fields.includes(k)), fields.length + ' fields')

// generate, then save through the real button
await p.keyboard.press('3')
await p.waitForTimeout(300)
await p.evaluate(async () => { await window.corridor.grow.run(window.corridor.site, window.corridor.place.assets) })
await p.waitForTimeout(1500)
const placed = await p.evaluate(() => window.corridor.place.doc.items.length)
check('grow places items', placed > 0, `${placed} items`)

await p.keyboard.down('Control'); await p.keyboard.press('s'); await p.keyboard.up('Control')
await p.waitForTimeout(2500)
const st = await p.textContent('#status')
check('save writes a file', /saved/.test(st ?? ''), st ?? '')

check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '))
console.log(bad ? `\n${bad} FAILED` : '\nall good')
await b.close()
process.exit(bad ? 1 : 0)
