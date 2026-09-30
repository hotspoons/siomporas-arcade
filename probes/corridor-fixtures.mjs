// Fixtures, colliders and race furniture, in the world Rich drives.
//
// Rich, 2026-09-30: an invisible wall under the traffic lights (the mast's collider spanned its
// arm), stop-sign faces left floating or vanished when the post went flying (two batches, one
// detached), street signs that could not be hit (no collider at all), a start ring flat on the
// road with nothing to drive through, no finish line in sight — and the ask that all of these be
// managed as fixtures with variants. `fixtures.json` on crofton-triangle (written over MCP) puts
// a stand-in model on every stop sign and makes the gates nine metres and orange.
import { chromium } from 'playwright'

const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 900, height: 640 } })
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)))
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext = () => ({ accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, on(){}, off(){}, send(){}, data:{} }); export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u; export const ErrorOverlay = class {}; export default {}' }))
let bad = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }
await p.goto('http://127.0.0.1:5185/index.html?level=crofton-jam#crofton-triangle', { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.__apex?.traffic && !!window.__apex?.races && !!window.__apex?.fixtures, null, { timeout: 240000 })
await p.waitForTimeout(4000)
const r = await p.evaluate(async () => {
  const ap = window.__apex
  const { catalogue } = await import('/src/worldbodies.ts')
  const props = catalogue(ap.site, { max: 20000 })
  const signal = props.find((x) => x.kind.startsWith('furniture:signal'))
  const blade = props.find((x) => x.kind === 'blades' || x.kind.startsWith('blade'))
  const stopPost = props.find((x) => x.kind === 'furniture:sign:stop')
  const gates = ap.races.group.getObjectByName ? ap.races.group.children[1].children : []
  const gate = gates[0]
  const post = gate?.children.find((c) => c.geometry?.type === 'CylinderGeometry')
  const stripe = gate?.getObjectByName('stripe')
  const banner = gate?.getObjectByName('banner')
  const entry = ap.races.group.children[0].children[0]
  let hidden = 0, shown = 0
  ap.site.layers.furniture.traverse((o) => { if (o.name === 'furniture:sign:stop') { if (o.visible) shown++; else hidden++ } })
  return {
    signal: signal ? { hx: +signal.hx.toFixed(2), hz: +signal.hz.toFixed(2), hy: +signal.hy.toFixed(2) } : null,
    blade: !!blade, bladeKind: blade?.kind, bladeBreak: blade?.breakAt,
    stopBreak: stopPost?.breakAt,
    gates: gates.length, postH: post ? +post.geometry.parameters.height.toFixed(1) : null, stripe: !!stripe, bannerColour: banner ? '#' + banner.material.color.getHexString() : null,
    arch: !!entry?.getObjectByName('arch'), ring: !!entry?.getObjectByName('ring'),
    placed: ap.fixtures.placed, problems: ap.fixtures.problems, stopHidden: hidden, stopShown: shown,
    // what fixtures.json actually asks for, so the checks below follow the document rather than a
    // number typed here on the night it was authored
    doc: await (await fetch('/sites/crofton-triangle/fixtures.json', { cache: 'no-cache' })).json().catch(() => null),
  }
})
console.log(JSON.stringify(r))
check(r.signal && r.signal.hx <= 0.3 && r.signal.hz <= 0.3 && r.signal.hy > 2, `a signal mast's collider is its post, not its arm (half ${r.signal?.hx} × ${r.signal?.hz} m, ${r.signal?.hy} m tall)`)
// street-name blades are one merged mesh per site and cannot be detached yet — see worldbodies.ts
const gateWant = r.doc?.choices?.['race-gate']?.settings ?? {}
check(r.gates === 5 && r.stripe && (gateWant.height_m === undefined || r.postH === gateWant.height_m) && (gateWant.colour === undefined || r.bannerColour === gateWant.colour), `every gate stands at idle with posts, a stripe and fixtures.json's height and colour (${r.gates} gates, posts ${r.postH} m vs ${gateWant.height_m}, ${r.bannerColour} vs ${gateWant.colour})`)
check(r.arch && r.ring, 'the entry marker has a ring to trigger on and an arch to drive through')
if (r.doc?.choices?.['stop-sign']?.asset) check((r.placed['stop-sign'] ?? 0) > 100 && r.stopHidden > 0 && r.stopShown === 0, `the chosen stop-sign variant stands on every stop sign and the built-in batch is hidden (${r.placed['stop-sign']} placed, ${r.stopHidden} batches hidden)`)
else check(r.stopShown > 0 && r.stopHidden === 0, `no stop-sign variant is chosen, so the built-in batch stands (${r.stopShown} shown)`)
console.log(bad ? `FAILED (${bad})` : 'OK')
await b.close()
process.exit(bad ? 1 : 0)
