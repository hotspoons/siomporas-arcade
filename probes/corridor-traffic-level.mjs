// A level that asks for traffic gets traffic: cars on the roads, in lanes, moving, and solid.
//
// The level `probe-traffic` (written through the editor's MCP tools) asks for a world-wide
// density on arrowhead, which also has painted zones. The checks are the ones that fail silently:
// a plan of zero cars, cars that never move, cars drawn but with no body, cars off the road.
import { chromium } from 'playwright'

const VIEWER = process.env.VIEWER ?? 'http://127.0.0.1:5185/index.html'
const LEVEL = process.env.LEVEL ?? 'probe-traffic'
const SLUG = process.env.SLUG ?? 'arrowhead-farms-network'

const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 900, height: 640 } })
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)))
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: [
  'export const createHotContext = () => ({ accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, on(){}, off(){}, send(){}, data:{} })',
  'export const updateStyle = () => {}', 'export const removeStyle = () => {}', 'export const injectQuery = (u) => u', 'export const ErrorOverlay = class {}', 'export default {}',
].join('\n') }))
let bad = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }

// the level, written the way an agent writes it: through the editor's MCP endpoint
{
  const EDITOR = process.env.WORLDEDITOR ?? 'http://127.0.0.1:8780'
  const cfg = await (await fetch(`${EDITOR}/api/agent/mcp/config`)).json()
  const level = { id: LEVEL, world: SLUG, mode: 'drive', program: 'probe/traffic.ts', simulations: [{ kind: 'traffic', density: 0.15, seed: 3, max: 150 }] }
  const r = await fetch(`${EDITOR}/api/agent/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.auth?.token ?? ''}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_document', arguments: { path: `levels/${LEVEL}.json`, content: JSON.stringify(level) } } }) })
  const j = await r.json()
  check(!j.error && !j.result?.isError, `the level was written over MCP (${j.result?.content?.[0]?.text ?? j.error?.message})`)
}

await p.goto(`${VIEWER}?level=${LEVEL}#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.__apex?.site, null, { timeout: 240000 })
await p.waitForFunction(() => !!window.__apex?.traffic, null, { timeout: 120000 }).catch(() => {})
await p.waitForTimeout(3000)
const r = await p.evaluate(async () => {
  const ap = window.__apex
  const t = ap.traffic
  if (!t) return { none: true, physics: !!ap.physics }
  const { Transform, OnRoad, Vehicle } = await import('/src/actors.ts')
  const es = t.entities
  const snap = () => es.map((e) => [Transform.x[e], Transform.y[e], OnRoad.s[e], Vehicle.speed[e]])
  const before = snap()
  // step the simulation ourselves: headless frames are far too slow to wait on
  for (let i = 0; i < 300; i++) t.tick(1 / 60, ap.camera.position)
  const after = snap()
  let moved = 0
  let onRoad = 0
  let sumSpeed = 0
  for (let i = 0; i < es.length; i++) {
    if (Math.hypot(after[i][0] - before[i][0], after[i][1] - before[i][1]) > 0.5) moved++
    const info = ap.site.roadAt(after[i][0], -after[i][1])
    if (info && info.d < 12) onRoad++
    sumSpeed += after[i][3]
  }
  const meshes = t.group.children.length
  const bodies = ap.physics ? ap.physics.stats().bodies : null
  return { count: t.count, problems: t.problems, moved, onRoad, meanSpeed: +(sumSpeed / Math.max(1, es.length)).toFixed(1), meshes, bodies, physics: !!ap.physics, sample: after.slice(0, 3).map((a) => a.map((v) => +v.toFixed(1))) }
})
console.log(JSON.stringify(r))
check(!r.none, 'the level built a traffic layer')
if (!r.none) {
  check(r.count > 20, `it planned cars (${r.count})`)
  check(r.meshes === r.count, `every car is drawn (${r.meshes} meshes)`)
  check(r.physics && r.bodies > r.count, `every car has a body (${r.bodies} bodies in the world, physics ${r.physics})`)
  check(r.moved > r.count * 0.5, `most cars moved in five seconds (${r.moved} of ${r.count})`)
  check(r.onRoad > r.count * 0.9, `and they are on a road (${r.onRoad} of ${r.count} within 12 m of one)`)
  check(r.meanSpeed > 2, `and moving at road speed (mean ${r.meanSpeed} m/s)`)
}
console.log(bad ? `FAILED (${bad})` : 'OK')
await b.close()
process.exit(bad ? 1 : 0)
