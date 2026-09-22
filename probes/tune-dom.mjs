import { chromium } from 'playwright'
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] })
const p = await b.newPage({ viewport: { width: 1280, height: 900 } })
await p.route('**/@vite/client', (r) => r.abort())
p.on('pageerror', (e) => console.log('pageerror:', e.message))
p.on('console', (m) => { if (m.type() === 'error') console.log('console.error:', m.text()) })
await p.goto('http://localhost:5207/#frederick-i70', { waitUntil: 'load' })
await p.waitForTimeout(4000)
console.log(await p.evaluate(() => {
  const h = document.querySelector('#tunehost')
  return JSON.stringify({
    tuneBtn: !!document.querySelector('#tune'),
    tunehost: !!h,
    hostClass: h?.className,
    children: h ? [...h.children].map((c) => c.className || c.tagName) : null,
    tabButtons: document.querySelectorAll('.tunetabs button').length,
    anyPanel: document.querySelectorAll('.tunepanel, [class*=tune]').length,
  })
}))
await p.click('#tune').catch((e) => console.log('click failed', e.message))
await p.waitForTimeout(800)
console.log('after click:', await p.evaluate(() => {
  const h = document.querySelector('#tunehost')
  return JSON.stringify({ hostClass: h?.className, tabs: [...document.querySelectorAll('.tunetabs button')].map((x) => x.textContent), rect: h?.getBoundingClientRect().toJSON() })
}))
await p.screenshot({ path: '/tmp/claude-1000/-workspaces-apex-conduit/852c47cd-1ff2-4179-a0f5-3c394595dfac/scratchpad/tune-dom.png' })
await b.close()
