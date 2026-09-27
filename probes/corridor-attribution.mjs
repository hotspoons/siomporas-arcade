// Does the attribution actually collapse?
//
// Rich, 2026-09-27: "this expand/collapse on the attribution isn't working" — with a screenshot
// showing both the collapsed pill AND the expanded list on screen at once.
//
// The cause was CSS, not JavaScript: `#attribution .attrib-list { display: grid }` overrides
// `[hidden]`, which is only a user-agent rule of `display: none`. So the code set `hidden = true`,
// the attribute landed, `aria-expanded` flipped and the caret turned — every observable thing a
// unit test would assert was correct, and the list stayed on screen.
//
// So this asserts what a person sees: the rendered HEIGHT of the list, not the attribute.
//
//   PORT=5185 node probes/corridor-attribution.mjs [slug]
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-triangle'
const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 160)))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://localhost:${PORT}/?lite=1#${slug}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForSelector('#attribution .attrib-short', { timeout: 900000 })
// WAIT FOR THE CREDITS, not just the button. The widget is built at startup and populated when a
// site's manifest lands, so clicking early toggles an empty list — which passes the height check
// and asserts nothing about the thing a person reads.
await page.waitForFunction(() => document.querySelectorAll('#attribution .attrib-row').length >= 2, null, { timeout: 900000 })

const shot = async () =>
  page.evaluate(() => {
    const list = document.querySelector('#attribution .attrib-list')
    const short = document.querySelector('#attribution .attrib-short')
    const r = list.getBoundingClientRect()
    return {
      height: Math.round(r.height),
      display: getComputedStyle(list).display,
      hidden: list.hasAttribute('hidden'),
      expanded: short.getAttribute('aria-expanded'),
      rows: list.querySelectorAll('.attrib-row').length,
      label: short.querySelector('.attrib-label')?.textContent ?? '',
    }
  })

const closed = await shot()
await page.click('#attribution .attrib-short')
await page.waitForTimeout(250)
const open = await shot()
await page.click('#attribution .attrib-short')
await page.waitForTimeout(250)
const again = await shot()

console.log(JSON.stringify({ closed, open, again }, null, 1))
await browser.close()
const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1 }
// HEIGHT, not the attribute: the attribute was right the whole time it was broken
if (closed.height !== 0) fail(`collapsed, the list is still ${closed.height}px tall (display ${closed.display}) — it is on screen under the pill`)
else if (!(open.height > 0)) fail('expanded, the list has no height — clicking does nothing')
else if (open.rows < 2) fail(`expanded, only ${open.rows} credit rows: the list did not populate`)
else if (again.height !== 0) fail(`clicking again left it ${again.height}px tall — it opens and does not close`)
else if (closed.expanded !== 'false' || open.expanded !== 'true') fail(`aria-expanded is ${closed.expanded} then ${open.expanded}`)
else console.log(`PASS: collapsed 0px, expanded ${open.height}px with ${open.rows} credits ("${open.label}"), collapsed again 0px.`)
