// Does the performance panel appear, and does it say anything true?
//
// Rich, 2026-09-29: *"Also toggling the stats panel has no effect"* — it had none, because the
// switch called an `onPerf` handler the viewer never passed. A settings toggle that does nothing is
// indistinguishable from a feature that is not there, so this drives the real switch and the real
// key and then reads the real numbers off the real panel.
import { chromium } from 'playwright'

const SLUG = process.env.SLUG ?? 'bowie-racetrack-rd'
const VIEWER = process.env.VIEWER ?? 'http://127.0.0.1:5185/index.html'
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 1100, height: 760 } })
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)))
let bad = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }

await p.goto(`${VIEWER}#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.__apex?.site, null, { timeout: 240000 })
await p.waitForTimeout(5000)

const shown = () => p.evaluate(() => {
  const el = document.querySelector('.perf-hud')
  if (!el) return { there: false }
  return { there: true, hidden: el.hidden, text: el.textContent ?? '', rect: el.getBoundingClientRect().width }
})

const before = await shown()
check(before.there, 'the panel exists in the page')
check(before.hidden, 'and starts hidden, because nobody has asked for it')

// THE KEY, the way a person presses it
await p.keyboard.press('F7')
await p.waitForTimeout(1200)
const on = await shown()
console.log('panel:', JSON.stringify(on.text.replace(/\s+/g, ' ').slice(0, 160)))
check(!on.hidden, 'F7 shows it')
check(on.rect > 100, `and it has a real width on screen (${on.rect?.toFixed?.(0)} px)`)
check(/fps/.test(on.text), 'it says what the frame rate is')
check(/p95/.test(on.text) && /p99/.test(on.text), 'and the tail, which is the reason it exists')
check(/draws/.test(on.text) && /tris/.test(on.text), 'and what the renderer did')

/*
 * THE NUMBERS HAVE TO BE REAL. A panel that renders "0 fps · 0.0 ms" forever looks like a working
 * panel in a screenshot; the meter only records while it is open, so this is also the check that
 * the frame loop is feeding it.
 */
await p.waitForTimeout(2500)
const live = await p.evaluate(() => {
  const r = window.__apex.perfMeter.read()
  return { frames: r.frames, fps: +r.fps.toFixed(1), p95: +r.p95.toFixed(1), cpu: +r.cpuMs.toFixed(2), calls: r.counts.calls, tris: r.counts.triangles }
})
console.log('reading:', JSON.stringify(live))
check(live.frames > 2, `the meter is recording frames (${live.frames})`)
check(live.fps > 0 && live.p95 > 0, `with a real rate and a real tail (${live.fps} fps, p95 ${live.p95} ms)`)
check(live.cpu > 0, `and our own cpu time inside the frame (${live.cpu} ms)`)
check(live.calls > 0 && live.tris > 0, `and the renderer's counters (${live.calls} draws, ${live.tris} tris)`)

// the settings switch, which is what was broken
await p.keyboard.press('F7')
await p.waitForTimeout(600)
check((await shown()).hidden, 'F7 again hides it')

const viaSettings = await p.evaluate(() => {
  const cog = [...document.querySelectorAll('button')].find((b) => /settings/i.test(b.title ?? ''))
  cog?.click()
  return !!cog
})
await p.waitForTimeout(700)
check(viaSettings, 'the settings dialog opens')
const toggled = await p.evaluate(async () => {
  // the dialog's tabs are `.tab` buttons; `[role=tab]` matches nothing here and a loose text match
  // finds the top bar's own buttons first
  const tab = [...document.querySelectorAll('.tab, .tabs button, [data-tab]')].find((e) => e.textContent?.trim() === 'Display')
  tab?.click()
  await new Promise((r) => setTimeout(r, 300))
  const row = [...document.querySelectorAll('label.field')].find((e) => /stats panel/i.test(e.textContent ?? ''))
  const input = row?.querySelector('input') ?? null
  input?.click()
  return { foundTab: !!tab, foundRow: !!row, clicked: !!input, checked: input?.checked ?? null }
})
await p.waitForTimeout(900)
console.log('settings:', JSON.stringify(toggled))
check(toggled.foundRow, 'Settings → Display offers the stats panel')
check(toggled.clicked && !(await shown()).hidden, 'and the switch really shows it')
// and it is remembered, which is what the key and the switch both write
check(await p.evaluate(() => localStorage.getItem('corridor.perf') === '1'), 'and it is remembered for next time')

console.log(bad ? `FAILED (${bad})` : 'OK')
await b.close()
process.exit(bad ? 1 : 0)
