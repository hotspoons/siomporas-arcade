// Does the tuning panel fit, and did the reshuffle drop anything?
//
// Rich, 2026-09-27: "Way too many tuning settings was placed under grass — we need an environment
// panel and put weather (and expand weather by default, not sure why it is collapsed) and time,
// and should never scroll horizontally … Need a plan for too many tabs to fit horizontally which
// is the case now for the side docked tuning panel … I kept accidentally changing things as I
// clicked to scroll … Sidewalks has no settings and hides intersections tuning."
//
// Moving twenty-eight sections between tabs by hand is exactly the kind of edit that silently
// loses one, so the first assertion is that every knob still has a home and no knob has two.
//
//   PORT=5185 node probes/corridor-tunelayout.mjs
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
// a NARROW window: the side dock is where the tab strip ran out of room
const page = await browser.newPage({ viewport: { width: 520, height: 780 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://localhost:${PORT}/#crofton-triangle?lite=1`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.tune, null, { timeout: 600000 })

// the knob table, independent of the DOM
const table = await page.evaluate(() => {
  const tabs = window.corridor.tune.sections ?? window.corridor.tune.tabs ?? null
  if (!tabs) return { error: 'no tune table exposed' }
  const seen = {}
  const out = { tabs: [], dupes: [], empty: [] }
  for (const t of tabs) {
    const names = []
    for (const s of t.sections ?? []) for (const k of s.keys ?? []) {
      names.push(k.name)
      if (seen[k.name]) out.dupes.push(`${k.name} (${seen[k.name]} and ${t.name})`)
      seen[k.name] = t.name
    }
    out.tabs.push({ name: t.name, sections: (t.sections ?? []).length, keys: names.length })
    if (!names.length) out.empty.push(t.name)
  }
  out.total = Object.keys(seen).length
  return out
})

// open it, dock it to a side, and measure the layout
await page.keyboard.press('F6')
await page.waitForTimeout(600)
await page.evaluate(() => window.corridor.tuneDialog?.dock?.('right'))
await page.waitForTimeout(600)

const layout = await page.evaluate(() => {
  const strip = document.querySelector('.tab-strip')
  const body = document.querySelector('.tab-body')
  if (!strip || !body) return { error: 'panel did not open' }
  const cs = getComputedStyle(strip)
  return {
    tabCount: strip.querySelectorAll('.tab').length,
    tabRows: new Set([...strip.querySelectorAll('.tab')].map((t) => Math.round(t.getBoundingClientRect().top))).size,
    stripWrap: cs.flexWrap,
    stripOverflowX: strip.scrollWidth - strip.clientWidth,
    bodyOverflowX: body.scrollWidth - body.clientWidth,
    panelW: Math.round(document.querySelector('.dialog').getBoundingClientRect().width),
  }
})

// the environment tab: weather must be OPEN
const env = await page.evaluate(() => {
  const strip = document.querySelector('.tab-strip')
  const btn = [...strip.querySelectorAll('.tab')].find((b) => /environment/i.test(b.textContent))
  if (!btn) return { error: 'no environment tab' }
  btn.click()
  const groups = [...document.querySelectorAll('.tab-body .group')].map((g) => ({
    title: g.querySelector('.group-head span')?.textContent ?? '?',
    collapsed: g.classList.contains('collapsed'),
    fields: g.querySelectorAll('.group-body .field').length,
  }))
  const ranges = [...document.querySelectorAll('.tab-body input.range')]
  return { groups, touchAction: ranges.length ? getComputedStyle(ranges[0]).touchAction : null, rangeCount: ranges.length }
})

// and the furniture tab: sidewalks must have its knobs, and intersections must be reachable
const furn = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.tab-strip .tab')].find((b) => /furniture/i.test(b.textContent))
  if (!btn) return { error: 'no furniture tab' }
  btn.click()
  return [...document.querySelectorAll('.tab-body .group')].map((g) => ({
    title: g.querySelector('.group-head span')?.textContent ?? '?',
    collapsed: g.classList.contains('collapsed'),
    // a collapsed group still has its fields in the DOM; this is what it WOULD show
    fields: g.querySelectorAll('.group-body .field').length,
  }))
})

console.log(JSON.stringify({ table, layout, env, furn }, null, 1))
await browser.close()

const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1 }
const weather = env.groups?.find((g) => /weather/i.test(g.title))
const sidewalks = furn.find?.((g) => /sidewalk/i.test(g.title))
const inter = furn.find?.((g) => /intersection/i.test(g.title))
if (table.error) fail(table.error)
else if (layout.error) fail(layout.error)
else if (env.error) fail(env.error)
else if (table.dupes.length) fail(`a knob is in two tabs: ${table.dupes.join('; ')}`)
else if (table.empty.length) fail(`empty tab(s): ${table.empty.join(', ')}`)
else if (!(table.total > 180)) fail(`only ${table.total} knobs reachable — the reshuffle dropped a section`)
// liveness: a run where the panel never got narrow could not have caught the overflow
else if (!(layout.panelW < 600)) fail(`the docked panel is ${layout.panelW}px wide — not narrow enough to test the tab strip`)
else if (layout.stripOverflowX > 1) fail(`the tab strip scrolls sideways by ${layout.stripOverflowX}px at ${layout.panelW}px wide`)
else if (layout.bodyOverflowX > 1) fail(`the tab body scrolls sideways by ${layout.bodyOverflowX}px`)
else if (layout.stripWrap !== 'wrap') fail(`the tab strip is ${layout.stripWrap}, so it hides tabs instead of wrapping them`)
else if (!weather) fail('no weather section in the environment tab')
else if (weather.collapsed) fail('weather still starts collapsed')
else if (env.touchAction !== 'pan-y') fail(`sliders have touch-action: ${env.touchAction} — a vertical swipe will drag them instead of scrolling`)
// Rich's report was that sidewalks "has no settings and hides intersections tuning" — both
// sections are long, both were shut by the length rule, and two headings with nothing under them
// is indistinguishable from two empty sections. They start OPEN.
else if (!sidewalks || sidewalks.fields < 10) fail(`the sidewalks section has ${sidewalks?.fields ?? 0} fields`)
else if (sidewalks.collapsed) fail('the sidewalks section still starts collapsed, which is what read as "no settings"')
else if (!inter || inter.fields < 10) fail(`the intersections section has ${inter?.fields ?? 0} fields`)
else if (inter.collapsed) fail('the intersections section still starts collapsed')
else console.log(`PASS: ${table.total} knobs across ${table.tabs.length} tabs, ${layout.tabCount} tabs on ${layout.tabRows} row(s) at ${layout.panelW}px, no sideways scroll, weather open, sliders pan-y`)
