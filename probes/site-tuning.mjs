#!/usr/bin/env node
// Per-site knob overrides: does the file win over the browser, and does leaving the site put the
// previous values back? The leak is the interesting case — a value from site A silently surviving
// into site B looks like a bug in B.
import { chromium } from 'playwright'
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const p = await b.newPage({ viewport: { width: 1000, height: 700 } })
await p.route('**/@vite/client', (r) => r.abort())
p.on('pageerror', (e) => console.log('pageerror:', e.message))
const read = () => p.evaluate(() => ({ grass: window.corridor.tune.get('GRASS_RADIUS'), tree: window.corridor.tune.get('TREE_NEAR_RADIUS') }))

// site WITH a file
await p.goto('http://localhost:5207/#frederick-i70', { waitUntil: 'load' })
await p.waitForFunction(() => !!window.corridor?.site, null, { timeout: 300000 })
await p.waitForTimeout(2500)
console.log('frederick-i70 (has tuning.json GRASS_RADIUS=44, TREE_NEAR_RADIUS=180):', JSON.stringify(await read()))
console.log('  status:', await p.textContent('#status'))

// switch to a site WITHOUT one — the previous file must be undone
await p.selectOption('#site', 'south-mountain-i70')
await p.waitForFunction(() => window.corridor?.site?.manifest.slug === 'south-mountain-i70', null, { timeout: 300000 })
await p.waitForTimeout(2000)
const after = await read()
console.log('south-mountain-i70 (no tuning.json):', JSON.stringify(after))
const defaults = await p.evaluate(() => ({ grass: 106, tree: 240 }))
console.log(`  VERDICT: ${after.grass === defaults.grass && after.tree === defaults.tree ? 'restored to defaults — no leak' : 'LEAKED from the previous site'}`)
await b.close()
