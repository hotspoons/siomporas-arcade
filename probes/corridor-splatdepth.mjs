// THE FIRST QUESTION ABOUT SPLATS IN THIS VIEWER: does a gaussian splat obey the depth buffer in a
// renderer built with logarithmicDepthBuffer? Everything in docs/corridor/PLAN-SPLAT-CORRIDORS.md
// rests on the answer.
//
// It is asked on a page with three objects and no time (apps/corridor/splatdepth.html): an opaque
// wall, the splat in front of it, the splat behind it. An earlier version of this probe differenced
// two frames of the LIVING viewer and spent its life measuring something else moving — the clock
// advancing the sun, grass sway, an animated stream, the lazy build pump, the canopy shade easing
// after a camera move. A question about depth does not need a world.
//   PORT=5185 node probes/corridor-splatdepth.mjs
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5185'
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const p = await b.newPage({ viewport: { width: 400, height: 400 } })
const errs = []
p.on('pageerror', (e) => errs.push(e.message.slice(0, 200)))
await p.route('**/@vite/client', (r) => r.abort())
await p.goto(`http://localhost:${PORT}/splatdepth.html`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.__splatdepth, null, { timeout: 180000 })
const r = await p.evaluate(() => window.__splatdepth)
await b.close()
let fails = 0
const ok = (what, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`); if (!cond) fails++ }
if (r.error) { console.log('FAIL the harness threw —', r.error); process.exit(1) }
for (const n of r.notes ?? []) console.log('    ', n)
ok('the renderer really has a logarithmic depth buffer', r.logDepth === true)
ok('with nothing in the way, the wall is what you see', r.cases.wallOnly.verdict === 'wall', JSON.stringify(r.cases.wallOnly))
ok('a splat in front of the wall draws over it', r.cases.splatInFront.verdict === 'the splat', JSON.stringify(r.cases.splatInFront))
ok('a splat BEHIND the wall is hidden by it', r.cases.splatBehind.verdict.startsWith('the wall'), JSON.stringify(r.cases.splatBehind))
ok('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '))
console.log(fails ? `FAIL ${fails}` : 'PASS')
process.exit(fails ? 1 : 0)
