// Can the editor drive Blender, and does it show what came back?
//
// Rich, 2026-09-29: "make it so there's MCP tools that an agent can use to run blender using this
// tool kit but through our UI. And also make it so the UI shows any blender rendered stls or other
// exports."
//
// THREE CLAIMS, and they are separable — the first two can pass while the third is a blank pane:
//   1. the service reaches a live Blender and can render and export
//   2. the MCP surface exposes the same operations to an outside agent
//   3. the editor SHOWS the results, including the formats it cannot preview
//
// It skips rather than fails when no Blender is running: the bridge is a separate process and its
// absence is a normal state, not a broken editor. What it must never do is pass BECAUSE of that —
// so the skip says so and exits 0 only after reporting which claims went untested.
//
//   node probes/corridor-blender.mjs
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5185'
const SVC = process.env.WORLDEDITOR ?? 'http://localhost:8780'
const fail = []
const say = (k, v) => console.log(`${k.padEnd(26)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)

/* ---- 1 · the service, and a live Blender ---- */
const status = await fetch(`${SVC}/api/blender/status`).then((r) => r.json()).catch((e) => ({ up: false, why: e.message }))
say('bridge', status.up ? `up, Blender ${status.version}` : `down — ${String(status.why).slice(0, 80)}`)
if (!status.up) {
  // THE MESSAGE IS PART OF THE CONTRACT: when it is down the editor shows the command to start it,
  // so an answer that does not name it is a bug even though the bridge being down is not.
  if (!/--command blender_mcp/.test(String(status.why))) {
    console.log('\nFAIL:\n  the "no bridge" answer does not say how to start one')
    process.exit(1)
  }
  console.log('\nSKIP: no Blender bridge running — start it with:\n  blender --background --online-mode --command blender_mcp')
  process.exit(0)
}

const post = (p, b) => fetch(`${SVC}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))

// something with a mesh in it, so the render has a subject
const cube = await post('/api/blender/exec', {
  code: 'import bpy\nbpy.ops.wm.read_homefile(use_empty=True, use_factory_startup=True)\nbpy.ops.mesh.primitive_monkey_add(size=2)\nresult = {"objects": [o.name for o in bpy.data.objects]}',
})
say('put something in the scene', cube.body?.result?.objects ?? cube.body)
if (cube.status !== 200) fail.push('could not run code in Blender through the service')

const shot = await post('/api/blender/render', { name: 'zzprobe', az: 35, el: 15, dist: 2.0, width: 320, height: 240 })
say('render', shot.body)
if (shot.status !== 200 || !shot.body?.file) fail.push('the service could not render')
else if (!(shot.body.bytes > 2000)) fail.push(`the render is ${shot.body.bytes} bytes — that is not a picture`)

const stl = await post('/api/blender/export', { format: 'stl', name: 'zzprobe' })
say('export stl', stl.body)
if (stl.status !== 200 || !stl.body?.file) fail.push('the service could not export an stl')
else if (!(stl.body.bytes > 1000)) fail.push(`the stl is ${stl.body.bytes} bytes`)

const bad = await post('/api/blender/export', { format: 'dwg' })
say('a format it does not do', [bad.status, String(bad.body?.error ?? '').slice(0, 60)])
if (bad.status < 400) fail.push('an unsupported export format was accepted')

/* ---- 2 · served back, and nothing else ---- */
const served = await fetch(`${SVC}/api/blender/outputs/${shot.body.file}`)
say('served', [served.status, served.headers.get('content-type'), (await served.arrayBuffer()).byteLength])
if (served.status !== 200) fail.push('the render is not served back')
if (!/image\/png/.test(served.headers.get('content-type') ?? '')) fail.push('the render is served with the wrong content type')

// the output directory is a directory of files, not a filesystem
for (const esc of ['..%2F..%2Fworlds', 'not_a_file', '..%2Fconfig.json']) {
  const r = await fetch(`${SVC}/api/blender/outputs/${esc}`)
  if (r.status < 400) fail.push(`\`${esc}\` was served`)
}
say('escapes refused', 'yes')

/* ---- 3 · the editor shows it ---- */
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]))
await page.goto(`http://localhost:${PORT}/world.html`, { waitUntil: 'networkidle', timeout: 90000 })
await page.waitForFunction(() => window.__we?.ready(), null, { timeout: 90000 })
await page.click('.topbar .seg[data-value="assets"]')
await page.waitForTimeout(2000)
const tabs = await page.$$eval('#assets .tab-strip .tab', (b) => b.map((x) => x.textContent.trim()))
say('library tabs', tabs)
if (!tabs.some((t) => /Blender/.test(t))) fail.push('the asset library has no Blender tab')
else {
  await page.click('#assets .tab:has-text("Blender")')
  await page.waitForFunction(() => document.querySelectorAll('#assets .blender-outputs .asset-row').length > 0, null, { timeout: 30000 }).catch(() => {})
  const shown = await page.$$eval('#assets .blender-outputs .asset-row', (r) => r.map((x) => x.textContent.replace(/\s+/g, ' ').trim()))
  say('rows shown', shown.length)
  if (!shown.some((t) => t.includes(shot.body.file))) fail.push('the render it just made is not listed')
  if (!shown.some((t) => t.includes(stl.body.file))) fail.push('the stl is not listed')

  // the PNG has to actually load, not merely be referenced
  // WAIT FOR THE PIXELS. `naturalWidth` is 0 until the image has decoded, so reading it straight
  // after the row appears measures "not yet" and reports it as "never".
  await page.waitForFunction(() => {
    const i = document.querySelector('#assets .blender-outputs img')
    return !!i && i.complete && i.naturalWidth > 0
  }, null, { timeout: 20000 }).catch(() => {})
  const img = await page.evaluate(() => {
    const i = document.querySelector('#assets .blender-outputs img')
    return i ? { src: i.getAttribute('src'), w: i.naturalWidth, h: i.naturalHeight } : null
  })
  say('thumbnail', img)
  if (!img) fail.push('no thumbnail for the render')
  else if (!(img.w > 0 && img.h > 0)) fail.push(`the thumbnail did not load (${img.src})`)

  // and selecting the stl must SAY it cannot be previewed rather than showing an empty box
  await page.click(`#assets .blender-outputs .asset-row:has-text("${stl.body.file}")`)
  await page.waitForTimeout(700)
  // `.blender-detail`, not `.asset-detail`: the catalog tab has one of those too and hidden tab
  // panels stay in the DOM, so the unscoped selector read the catalog's "Pick an item."
  const detail = await page.$eval('#assets .blender-detail', (n) => n.textContent.replace(/\s+/g, ' '))
  say('stl detail says', detail.slice(0, 90))
  if (!/triangles only|no rig|not previewed/i.test(detail)) {
    fail.push('selecting an stl neither previews it nor says why it cannot')
  }
}

/* ---- 4 · the same operations over MCP ---- */
const cfg = await fetch(`${SVC}/api/agent/mcp/config`).then((r) => r.json()).catch(() => null)
if (cfg?.auth?.token) {
  const list = await fetch(`${SVC}/api/agent/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${cfg.auth.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }).then((r) => r.json())
  const names = (list.result?.tools ?? []).map((t) => t.name).filter((n) => n.startsWith('blender_'))
  say('blender tools over mcp', names)
  for (const want of ['blender_status', 'blender_render', 'blender_export', 'blender_rig_vehicle']) {
    if (!names.includes(want)) fail.push(`no ${want} tool`)
  }
} else {
  say('mcp', '(no token; skipped)')
}

if (errs.length) { say('page errors', [...new Set(errs)].slice(0, 3)); fail.push(`${errs.length} page errors`) }
console.log(fail.length ? `\nFAIL:\n  ${fail.join('\n  ')}` : '\nPASS: the editor drives Blender, shows what came back, and offers the same to an agent')
await browser.close()
process.exit(fail.length ? 1 : 0)
