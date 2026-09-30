// Stand a loop-the-loop on a real road and photograph it.
//
// Rich has wanted this since he was a child, so the check is not "a mesh exists". It is: the ribbon
// keeps its width all the way round (the failure mode when the sideways direction is taken from
// world up is a pinch to zero at the vertical), the surface goes over the top, and the approach
// meets the road without a corner. Then a picture, because some of this is only judged by eye.
import { chromium } from 'playwright'

const SLUG = process.env.SLUG ?? 'bowie-racetrack-rd'
const EDITOR = process.env.EDITOR ?? 'http://127.0.0.1:5185/editor.html'
const dir = '/tmp/claude-1000/-workspaces-apex-conduit/12eaed6d-83ff-4605-9fb1-f5c0b0bc5019/scratchpad'

const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 1280, height: 900 } })
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)))
let bad = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }

await p.goto(`${EDITOR}#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.corridor?.site, null, { timeout: 180000 })
await p.waitForTimeout(6000)

const out = await p.evaluate(async () => {
  const { connectFixture, fixturePath } = await import('/src/stunts.ts')
  const { buildFixture } = await import('/src/stuntmesh.ts')
  // NO `import('three')` here: a bare specifier does not resolve in the page, and nothing in this
  // probe needs the library — the camera maths is four lines of arithmetic.
  const site = window.corridor.site
  const len = site.manifest.spine.length_m

  // Put it on the road, facing the way the road runs, straddling the midpoint.
  const mid = len / 2
  const a = site.spineAt(mid - 60).pos
  const bpos = site.spineAt(mid + 60).pos
  const here = site.spineAt(mid).pos
  const heading = Math.atan2(-(bpos.z - a.z), bpos.x - a.x) // site-frame bearing of travel

  const fixture = {
    id: 'loop-1', name: 'The loop', piece: 'loop',
    at: [here.x, -here.z],
    yaw_deg: (heading * 180) / Math.PI,
    entry_s: mid - 140, exit_s: mid + 140,
  }
  const road = (s) => {
    if (s < 0 || s > len) return null
    const q = site.spineAt(s)
    return { x: q.pos.x, y: -q.pos.z, z: q.pos.y, dx: q.dir.x, dy: -q.dir.z }
  }
  // `groundAt` goes to the CONNECTOR, not to the mesh: the path it returns is absolute, so the
  // renderer never adds a height and cannot add it twice.
  const ground = (x, y) => site.groundAt(x, -y) ?? site.heightAt(x, y) ?? 0
  const parts = connectFixture(fixture, road, { groundAt: ground })
  const built = buildFixture(fixture, parts)
  window.corridor.scene.add(built.group)

  // --- measure the ribbon rather than trust it ------------------------------------------------
  const through = parts.through
  const widths = []
  // the ribbon is a Mesh inside a Group of the same name, so look for the one with geometry on it
  let mesh = null
  built.group.traverse((o) => { if (o.isMesh && o.name === `stunt:${fixture.id}`) mesh = o })
  if (!mesh) return { error: 'no stunt mesh was built' }
  const pos = mesh.geometry.getAttribute('position')
  for (let i = 0; i < pos.count; i += 2) {
    widths.push(Math.hypot(
      pos.getX(i) - pos.getX(i + 1), pos.getY(i) - pos.getY(i + 1), pos.getZ(i) - pos.getZ(i + 1)))
  }
  const ups = through.map((q) => q.up.z)
  const heights = through.map((q) => q.z)
  const groundHere = ground(fixture.at[0], fixture.at[1])

  // point the camera at it from the side, low down, so the loop reads as a loop
  const cam = window.corridor.camera
  const tx = here.x, ty = here.y + 20, tz = here.z
  const sx = -Math.sin(heading), sz = -Math.cos(heading)
  cam.position.set(tx + sx * 190, here.y + 55, tz + sz * 190)
  cam.lookAt(tx, ty, tz)
  window.corridor.orbitTarget.set(tx, ty, tz)

  return {
    problems: parts.problems,
    samples: through.length,
    widthMin: Math.min(...widths), widthMax: Math.max(...widths),
    upMin: Math.min(...ups),
    climb: Math.max(...heights) - Math.min(...heights),
    approach: parts.approach.length, departure: parts.departure.length,
    baseZ: parts.baseZ, groundHere, mouthZ: through[0].z,
    joinStep: Math.abs(parts.approach[parts.approach.length - 1].z - through[0].z),
  }
})

console.log(JSON.stringify(out))
check(out.problems.length === 0, `it connects to the road (${out.problems.join('; ') || 'no problems'})`)
check(out.approach > 8 && out.departure > 8, 'there is a curve in and a curve out')
// A RIBBON THAT PINCHES is what you get when "across" comes from world up: at the top and bottom of
// a loop the tangent IS world up, the cross product goes to zero, and the road necks to nothing.
check(out.widthMin > 9.9 && out.widthMax < 10.1, `the road keeps its width all the way round (${out.widthMin.toFixed(2)}…${out.widthMax.toFixed(2)} m)`)
check(out.upMin < -0.9, `the surface goes over the top (lowest normal ${out.upMin.toFixed(2)})`)
check(out.climb > 30, `it climbs a loop's worth (${out.climb.toFixed(1)} m)`)
// THE HEIGHT IS APPLIED ONCE. Doubling it looks right from every angle except a low one.
check(Math.abs(out.mouthZ - out.groundHere) < 0.5, `the mouth sits ON the ground (${out.mouthZ.toFixed(1)} m against ${out.groundHere.toFixed(1)} m of terrain)`)
check(out.joinStep < 0.5, `the approach meets the mouth without a step (${out.joinStep.toFixed(2)} m)`)

await p.waitForTimeout(2500)
await p.screenshot({ path: `${dir}/loop.png` })
console.log('shot', `${dir}/loop.png`)
console.log(bad ? `FAILED (${bad})` : 'OK')
await b.close()
process.exit(bad ? 1 : 0)
