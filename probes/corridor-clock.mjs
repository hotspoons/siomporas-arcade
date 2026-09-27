// Can you set the date and the time, and do the fields keep up while time runs?
//
// Rich, 2026-09-27: "we need a couple of time controls — date and time start offset (should
// constantly update with time acceleration)".
//
// The second half is the hard half. At 600x a simulated day goes by in four minutes, so the
// fields rewrite themselves several times a second — and a field that rewrites itself under the
// cursor cannot be typed in, while one that stops updating when focused and never resumes is a
// lie. Both are checked here, because both are the kind of thing that works when you build it and
// is broken by the next change.
//
//   PORT=5185 node probes/corridor-clock.mjs [slug]
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-triangle'
const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 620, height: 820 } })
const errors = []
page.on('pageerror', (e) => { errors.push(e.message.slice(0, 160)); console.log('pageerror', e.message.slice(0, 200)) })
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://localhost:${PORT}/?lite=1#${slug}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 900000 })
await page.keyboard.press('F6')
await page.waitForTimeout(800)
// the clock lives in environment -> time of day
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.tab-strip .tab')].find((x) => /environment/i.test(x.textContent))
  b?.click()
})
await page.waitForTimeout(600)

const found = await page.evaluate(() => ({
  date: !!document.querySelector('.timectl input[type=date]'),
  time: !!document.querySelector('.timectl input[type=time]'),
  now: !!document.querySelector('.timectl-now'),
  offset: document.querySelector('.timectl-offset')?.textContent ?? null,
}))

// 1. SETTING a date and time must move the sun
await page.evaluate(() => window.corridor.tune.set('TIME_RATE', 0))
const setTo = async (d, t) => {
  await page.evaluate(
    ({ d, t }) => {
      const dd = document.querySelector('.timectl input[type=date]')
      const tt = document.querySelector('.timectl input[type=time]')
      dd.value = d
      tt.value = t
      tt.dispatchEvent(new Event('change', { bubbles: true }))
    },
    { d, t },
  )
  await page.waitForTimeout(500)
  return page.evaluate(() => ({ sunEl: +window.corridor.time.sun().el.toFixed(1), parts: window.corridor.time.parts() }))
}
const noon = await setTo('2026-06-21', '12:00')
const midnight = await setTo('2026-06-21', '00:00')

// 2. RUNNING: with the rate up, the fields must follow
//
// POLLED, not a fixed wait. A software rasteriser building five million triangles of Crofton
// stalls this tab for tens of seconds at a time -- measured, 0 frames in 5 s -- and the world's
// clock advances on the app's own frame loop, so a fixed sleep measures the stall and calls the
// clock broken. Waiting for the change with a timeout measures the clock.
await page.evaluate(() => {
  const dd = document.querySelector('.timectl input[type=date]')
  const tt = document.querySelector('.timectl input[type=time]')
  dd.value = '2026-06-21'
  tt.value = '06:00'
  tt.dispatchEvent(new Event('change', { bubbles: true }))
  window.corridor.tune.set('TIME_RATE', 3600)
})
const field = () => page.evaluate(() => document.querySelector('.timectl input[type=time]').value)
/** poll until `want(v)`, up to ms; returns the last value seen either way */
const until = async (want, ms) => {
  const t0 = Date.now()
  let v = await field()
  while (Date.now() - t0 < ms) {
    if (want(v)) return { v, waited: Date.now() - t0, ok: true }
    await page.waitForTimeout(250)
    v = await field()
  }
  return { v, waited: Date.now() - t0, ok: false }
}
const t0 = await field()
const ran = await until((v) => v !== t0, 60000)
const t1 = ran.v

// 3. FOCUSED: while you are typing in it, the field must hold still -- WHILE THE CLOCK RUNS.
//
// "the field did not change for eight seconds" is free if the tab was wedged for eight seconds,
// so the window is defined by the simulated clock moving half an hour, not by the wall clock, and
// the field is watched across it.
await page.focus('.timectl input[type=time]')
const f0 = await field()
const simAt = () => page.evaluate(() => window.corridor.time.ms)
const simStart = await simAt()
let held = { changed: false, simMoved: 0, samples: 0 }
for (let i = 0; i < 240; i++) {
  await page.waitForTimeout(250)
  held.samples++
  held.simMoved = ((await simAt()) - simStart) / 60000
  if ((await field()) !== f0) held.changed = true
  if (held.simMoved > 30) break
}
const f1 = await field()
// 4. and resume the moment you leave it
await page.evaluate(() => document.querySelector('.timectl input[type=time]').blur())
const resumed = await until((v) => v !== f1, 60000)
const f2 = resumed.v
const offset = await page.evaluate(() => document.querySelector('.timectl-offset')?.textContent ?? '')

console.log(JSON.stringify({ found, noon, midnight, running: { t0, t1, waitedMs: ran.waited }, focused: { f0, f1, simMovedMin: +held.simMoved.toFixed(1), changed: held.changed }, afterBlur: { f2, waitedMs: resumed.waited }, offset, errors }, null, 1))
await browser.close()

const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1 }
if (errors.length) fail(`the page threw while the clock was driven: ${errors.slice(0, 3).join(' | ')}`)
else if (!found.date || !found.time || !found.now) fail(`the clock is not in the panel (date ${found.date}, time ${found.time}, now ${found.now})`)
// midsummer noon over Maryland is a high sun; midnight is well below the horizon
else if (!(noon.sunEl > 60)) fail(`noon on 21 June put the sun at ${noon.sunEl} degrees — setting the date and time did not reach the sun`)
else if (!(midnight.sunEl < -20)) fail(`midnight on 21 June put the sun at ${midnight.sunEl} degrees`)
else if (!ran.ok) fail(`with the rate at 3600x the time field stayed at ${t0} for ${(ran.waited / 1000).toFixed(0)} s — it is not following the clock`)
// focused: it must not move under the cursor
else if (!(held.simMoved > 30)) fail(`the simulated clock only moved ${held.simMoved.toFixed(1)} min while the field was focused — the hold was never tested`)
else if (held.changed) fail(`the time field changed from ${f0} to ${f1} with the cursor in it, across ${held.simMoved.toFixed(0)} min of simulated time — you cannot type into that`)
// and it must come back
else if (!resumed.ok) fail(`after blur the field stayed at ${f2} for ${(resumed.waited / 1000).toFixed(0)} s — it stopped following the clock and never resumed`)
else console.log(`PASS: noon ${noon.sunEl} deg and midnight ${midnight.sunEl} deg set from the fields; at 3600x it ran ${t0} -> ${t1} in ${ran.waited} ms, held at ${f0} through ${held.simMoved.toFixed(0)} simulated minutes of focus, and resumed to ${f2} ${resumed.waited} ms after blur. Offset reads "${offset}".`)
