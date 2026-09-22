#!/usr/bin/env node
// Does the tuning panel fit, and can you reach it? Measures each tab at a viewport and reports
// overflow AND occlusion — an element that is on screen but under something else is just as
// unusable as one that is off the edge, and that is what phone width does here.
//   node probes/tune-layout.mjs [width height] [--shots <dir>]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const args = process.argv.slice(2)
const W = +(args[0] ?? 1280), H = +(args[1] ?? 900)
const shotDir = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null
if (shotDir) mkdirSync(shotDir, { recursive: true })

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: W, height: H } })
await page.route('**/@vite/client', (r) => r.abort())
page.on('pageerror', (e) => console.log('pageerror:', e.message))
await page.goto('http://localhost:5207/#frederick-i70', { waitUntil: 'load' })
// wait for the PANEL, not for the static #tune button: the tune host is built near the end of
// main.ts and clicking too early opens an empty host and reports "no tabs"
await page.waitForFunction(() => document.querySelectorAll('.tunetabs button').length > 0, null, { timeout: 300000 })

// open it in the page, not with a real click — a real click measures occlusion by failing, which
// tells you nothing about WHERE the problem is
await page.evaluate(() => document.querySelector('#tune').click())
await page.waitForTimeout(500)

const report = await page.evaluate(() => {
  const host = document.querySelector('#tunehost')
  const strip = host.querySelector('.tunetabs')
  const R = (e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] }
  /** who actually receives a click at the centre of this element? */
  const topAt = (e) => {
    const r = e.getBoundingClientRect()
    const t = document.elementFromPoint(Math.min(innerWidth - 2, Math.max(2, r.left + r.width / 2)), Math.min(innerHeight - 2, Math.max(2, r.top + r.height / 2)))
    if (!t) return 'nothing (off screen)'
    return t === e || e.contains(t) ? 'itself' : `${t.tagName.toLowerCase()}${t.id ? '#' + t.id : ''}${t.className ? '.' + String(t.className).split(' ')[0] : ''}`
  }
  const out = { vw: innerWidth, vh: innerHeight, host: R(host), strip: R(strip), tuneBtn: null, tabs: [], panel: null }
  const tb = document.querySelector('#tune')
  if (tb) out.tuneBtn = { rect: R(tb), reachable: topAt(tb) }
  for (const b of strip.querySelectorAll('button')) out.tabs.push({ name: b.textContent, rect: R(b), reachable: topAt(b) })
  const p = [...host.children].find((c) => c !== strip && c.getBoundingClientRect().height > 0)
  if (p) {
    const pr = p.getBoundingClientRect()
    const rows = [...p.querySelectorAll('input, button, label')]
    out.panel = {
      rect: R(p),
      hscroll: p.scrollWidth > p.clientWidth ? `${p.scrollWidth}>${p.clientWidth}` : 'none',
      vscroll: p.scrollHeight > p.clientHeight ? `${p.scrollHeight}>${p.clientHeight}` : 'none',
      offRight: Math.round(pr.right) > innerWidth,
      offBottom: Math.round(pr.bottom) > innerHeight,
      // horizontally clipped only: a row below the fold is what scrolling is for, and counting
      // those made the panel look broken when it was merely long
      clipped: rows.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > pr.right + 1 }).length,
      // Only count something as OCCLUDED if it is inside the panel's own visible box. A row
      // scrolled out of `.tune-body` is not unreachable, you scroll to it — reporting those as
      // bugs is how a layout probe cries wolf.
      firstUnreachable: rows
        .filter((e) => {
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.top >= pr.top - 1 && r.bottom <= pr.bottom + 1 && r.top >= 0 && r.bottom <= innerHeight
        })
        .map((e) => [e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).split(' ')[0] : ''), topAt(e)])
        .filter(([, t]) => t !== 'itself')
        .slice(0, 3),
    }
  }
  return out
})

console.log(`viewport ${report.vw}x${report.vh}`)
console.log(`  #tunehost   ${report.host.join(',')}`)
console.log(`  .tunetabs   ${report.strip.join(',')}`)
console.log(`  #tune btn   ${report.tuneBtn ? report.tuneBtn.rect.join(',') + '  click lands on: ' + report.tuneBtn.reachable : 'absent'}`)
for (const t of report.tabs) console.log(`    tab ${String(t.name).padEnd(10)} ${t.rect.join(',').padEnd(20)} click lands on: ${t.reachable}`)
if (report.panel) {
  const p = report.panel
  console.log(`  panel       ${p.rect.join(',')}  hscroll ${p.hscroll}  vscroll ${p.vscroll}` +
    `${p.offRight ? '  OFF-RIGHT' : ''}${p.offBottom ? '  OFF-BOTTOM' : ''}  clipped rows ${p.clipped}`)
  if (p.firstUnreachable.length) console.log(`  UNREACHABLE controls: ${p.firstUnreachable.map(([t, w]) => `${t} under ${w}`).join(' | ')}`)
}
if (shotDir) await page.screenshot({ path: `${shotDir}/tune-${W}.png`, timeout: 120000 }).catch((e) => console.log('shot failed:', e.message.split('\n')[0]))
await browser.close()
