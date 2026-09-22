// Exercise grow mode and the preview dialog headlessly.
//   node probes/editor-grow.mjs <slug> <out.png> [actions...]
// actions: gen · invent · clear · lock:ID · del:ID · preview · drive:SECONDS · shot:PATH
import { chromium } from 'playwright'

const [, , slug = 'frederick-i70', out = '/tmp/grow.png', ...actions] = process.argv
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
await page.route('**/@vite/client', (r) => r.abort())
const logs = []
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`))
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`))
page.on('dialog', (d) => d.accept())

await page.goto(`http://localhost:5207/editor.html#${slug}:grow`, { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && !!window.corridor?.site, null, { timeout: 300000 })
await page.waitForTimeout(1500)

for (const a of actions) {
  const [verb, arg] = a.split(':')
  if (verb === 'gen') {
    // time the RULES alone, separately from spawning the scene objects: on a big site those are
    // two very different costs and only one of them is autogen's fault
    const t = await page.evaluate(async () => {
      const { site, place, grow } = window.corridor
      const ag = await import('/src/editor/autogen.ts')
      const t0 = performance.now()
      const r = ag.generate(site.manifest, site, place.assets, grow.params)
      const rules = performance.now() - t0
      const t1 = performance.now()
      await grow.run(site, place.assets)
      return { rules: Math.round(rules), total: Math.round(performance.now() - t1), placed: r.items.length, skipped: r.skipped }
    })
    console.log(`  rules ${t.rules} ms -> ${t.placed} items; spawn+rules again ${t.total} ms`)
    console.log('  skipped:', JSON.stringify(t.skipped))
    await page.waitForTimeout(1500)
  } else if (verb === 'invent') {
    await page.evaluate(() => { window.corridor.grow.params.invent = true })
  } else if (verb === 'params') {
    // params:key=value,key=value
    await page.evaluate((kv) => {
      for (const pair of kv.split(',')) {
        const [k, v] = pair.split('=')
        window.corridor.grow.params[k] = v === 'true' ? true : v === 'false' ? false : Number(v)
      }
    }, arg)
  } else if (verb === 'clear') {
    await page.evaluate(() => window.corridor.grow.clear())
  } else if (verb === 'lock') {
    // a human edit through the same funnel the panel uses, so `locked` is set the real way
    await page.evaluate((id) => {
      window.corridor.place.select(id)
      window.corridor.place.key({ key: 'E', shiftKey: true, preventDefault() {} })
    }, arg)
  } else if (verb === 'inv') {
    // what the invented pass actually produced, by mix and by asset
    console.log('  invented:', await page.evaluate(() => {
      const inv = window.corridor.place.doc.items.filter((p) => p.id.startsWith('g-inv'))
      const by = (k) => inv.reduce((a, p) => ((a[p.tags.find((t) => k.includes(t)) ?? '?'] = (a[p.tags.find((t) => k.includes(t)) ?? '?'] ?? 0) + 1), a), {})
      const assets = inv.reduce((a, p) => ((a[p.asset] = (a[p.asset] ?? 0) + 1), a), {})
      return JSON.stringify({ n: inv.length, mix: by(['strip', 'hamlet']), assets })
    }))
  } else if (verb === 'report') {
    const r = await page.evaluate(() => {
      const d = window.corridor.place.doc
      const f = (id) => d.items.find((p) => p.id === id)
      const KINDS = ['house','retail_unit','house_large','townhouse','big_box','warehouse','restaurant','shed','apartments','office','school','church','hotel','gas_station','barn','strip_mall','utility']
      const by = {}
      for (const p of d.items) for (const t of p.tags ?? []) if (KINDS.includes(t)) by[t] = (by[t] ?? 0) + 1
      return { n: d.items.length, by, locked: d.items.filter((p) => p.locked).map((p) => `${p.id}@${p.yaw_deg}`), deleted: d.autogen?.deleted ?? [], g88: !!f('g-88') }
    })
    console.log('  report:', JSON.stringify(r))
  } else if (verb === 'del') {
    await page.evaluate((id) => window.corridor.place.remove(id), arg)
  } else if (verb === 'preview') {
    await page.evaluate(() => document.querySelector('#preview').click())
    await page.waitForFunction(() => window.corridor?.preview?.open === true, null, { timeout: 300000 })
    await page.waitForTimeout(3000)
  } else if (verb === 'pfly') {
    // fly mode in the preview, parked above the biggest thing autogen placed
    await page.evaluate((h) => {
      const { preview, place, site } = window.corridor
      preview.setMode?.('fly')
      preview.mode = 'fly'
      const big = place.doc.items.filter((p) => p.asset.startsWith('bigbox') || p.asset.startsWith('stripmall') || p.asset.startsWith('school'))[0] ?? place.doc.items[0]
      const z = site.groundAt(big.x, -big.y) ?? 0
      preview.fly.pos.set(big.x, z + h, -big.y + h * 1.6)
      preview.fly.yaw = Math.PI
      preview.fly.pitch = -0.45
    }, Number(arg ?? 90))
  } else if (verb === 'drive') {
    await page.keyboard.down('KeyW')
    await page.waitForTimeout(Number(arg ?? 3) * 1000)
    await page.keyboard.up('KeyW')
    await page.waitForTimeout(700)
  } else if (verb === 'shot') {
    await page.screenshot({ path: arg, timeout: 180000 })
  } else if (verb === 'mode') {
    await page.keyboard.press(arg === 'place' ? '2' : arg === 'grow' ? '3' : '1')
  } else if (verb === 'wait') {
    await page.waitForTimeout(Number(arg))
  } else if (verb === 'save') {
    await page.keyboard.down('Control')
    await page.keyboard.press('s')
    await page.keyboard.up('Control')
    await page.waitForFunction(() => /saved|failed/.test(document.querySelector('#status')?.textContent ?? ''), null, { timeout: 60000 })
    console.log('  save:', await page.textContent('#status'))
  } else {
    // A verb this probe does not implement used to be skipped in silence: I asked it to `save`,
    // it did nothing, reported success, and the file I then went to read was not there. An
    // instruction that is not carried out has to say so.
    console.error(`unknown action "${a}" — known: gen, invent, params, clear, lock, del, report, inv, preview, put, obl, drive, shot, mode, wait, save`)
    process.exitCode = 2
    break
  }
  await page.waitForTimeout(400)
}

await page.waitForTimeout(1200)
await page.screenshot({ path: out, timeout: 180000 })
console.log(logs.filter((l) => !l.startsWith('log:')).slice(0, 12).join('\n') || 'no console errors')
console.log('status:', await page.textContent('#status'))
console.log(await page.evaluate(() => {
  const d = window.corridor.place.doc
  const gen = d.items.filter((p) => p.id.startsWith('g-'))
  return `items ${d.items.length} · generated ${gen.length} · locked ${gen.filter((p) => p.locked).length} · deleted ${d.autogen?.deleted?.length ?? 0} · preview ${window.corridor.preview.open}`
}))
await browser.close()
