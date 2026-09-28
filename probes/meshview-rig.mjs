// A rigged character, read the way a rig editor has to read one.
//
// Rich, 2026-09-28: "we also want to lift the character pipeline from the 3d fighting game, should
// be essentially the same pipeline but there is a rig editor too we'll want."
//
// The fighter's Kestrel is a full Rigify control rig: 706 joints, of which only a few dozen deform
// the mesh. The rest is IK plumbing, roll helpers and the handles a human grabs in Blender. A rig
// editor that lists seven hundred bones flat is unusable, and — more importantly — a character
// exported with all of them is an AUTHORING rig rather than a runtime one, which is the sort of
// thing found much later and much more expensively.
//
// So this asserts the CLASSIFICATION, not just "a skeleton was found": the numbers have to add up
// and the deform set has to be a small fraction, because that is the fact a person needs.
//
//   node probes/meshview-rig.mjs [url-to-a-rigged.glb]
import { chromium } from 'playwright'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const GLB = path.resolve(process.argv[2] ?? 'apps/fighter/public/assets/crown/chars/kestrel/rigged-arms-clear.glb')
if (!(await stat(GLB).catch(() => null))) { console.error(`no glb at ${GLB}`); process.exit(1) }

// Serve the glb and the Draco decoder from one origin, so decodeAudioData's cousin — the
// DRACOLoader — can actually fetch its wasm.
const VENDOR = path.resolve('apps/corridor/public/assets/vendor/draco')
const server = createServer(async (req, res) => {
  const p = decodeURIComponent((req.url ?? '/').split('?')[0])
  try {
    if (p === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>rig</title>') }
    if (p === '/model.glb') { res.writeHead(200, { 'content-type': 'model/gltf-binary' }); return res.end(await readFile(GLB)) }
    if (p.startsWith('/assets/vendor/draco/')) {
      const f = path.join(VENDOR, path.basename(p))
      res.writeHead(200, { 'content-type': f.endsWith('.wasm') ? 'application/wasm' : 'application/javascript' })
      return res.end(await readFile(f))
    }
    res.writeHead(404); res.end('no')
  } catch { res.writeHead(404); res.end('no') }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

/*
 * `./shell` IS STUBBED, and only because of what it drags in.
 *
 * meshview.ts uses exactly one thing from it — `el`, a two-line element helper — but shell.ts
 * pulls in the whole UI kit, and something in that graph constructs a `URL` at module-eval time
 * and throws "Failed to construct 'URL': Invalid URL" on a page that is not the app. The bundle
 * then defined no global at all and the failure surfaced as "cannot read MeshView of undefined",
 * which says nothing about the cause.
 *
 * Stubbed rather than worked around in the product: the dependency is correct in the app, and a
 * probe that isolates one component should supply that component's edges.
 */
const shellStub = {
  name: 'shell-stub',
  setup(b) {
    b.onResolve({ filter: /^\.\/shell$/ }, () => ({ path: 'shell-stub', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `export const el = (tag, cls = '', text = '') => {
        const n = document.createElement(tag)
        if (cls) n.className = cls
        if (text) n.textContent = text
        return n
      }`,
      loader: 'js',
    }))
  },
}

const bundle = await build({
  stdin: { contents: "export * from './meshview'", resolveDir: 'apps/corridor/src/ui', loader: 'ts' },
  bundle: true, format: 'iife', globalName: 'MV', write: false, target: 'es2020',
  plugins: [shellStub],
  /*
   * `import.meta.url` HAS TO BE SOMETHING. three's DRACOLoader resolves its wasm paths at MODULE
   * level with `new URL('../libs/draco/...', import.meta.url)`, and an IIFE bundle has no module
   * URL — so that is `new URL(relative, undefined)`, which throws before a single line of our code
   * runs. The bundle then defines no global and the failure reads "cannot read MeshView of
   * undefined", which points nowhere near the cause.
   *
   * The value is never used: setDecoderPath() overrides those constants. It only has to parse.
   */
  define: { 'import.meta.url': JSON.stringify('http://localhost/') },
})

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await page.goto(`${base}/`)
page.on('console', (m) => { if (m.type() === 'error') console.log('console.error', m.text().slice(0, 200)) })
await page.addScriptTag({ content: bundle.outputFiles[0].text })
const loaded = await page.evaluate(() => typeof window.MV)
if (loaded !== 'object') { console.error(`the bundle did not define MV (typeof ${loaded})`); }

const fails = []
const ok = (name, cond, detail) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name} — ${detail}`); if (!cond) fails.push(name) }

const result = await page.evaluate(async (base) => {
  const v = new MV.MeshView()
  v.root.style.cssText = 'width:640px;height:480px'
  document.body.append(v.root)
  v.start()
  await v.load(`${base}/model.glb`)
  const rig = v.rig()
  const before = v.capture()
  v.setSkeleton(true)
  const after = v.capture()
  return { rig, size: v.size ? [v.size.x, v.size.y, v.size.z] : null, before, after }
}, base)

ok('the character loaded and has a skeleton', !!result.rig?.skinned, result.rig ? `${result.rig.bones} bones` : 'no skin found')
const r = result.rig ?? {}
ok('and it is recognised as a Rigify rig specifically', r.convention === 'rigify', `convention: ${r.convention}`)
// The roles matter more than the count for anything that is not a character, and a character
// should still report the ones it has — this is the same classifier a vehicle will go through.
ok('its bones map onto roles a game could drive',
  (r.roles?.limb ?? 0) > 0 && (r.roles?.spine ?? 0) > 0,
  JSON.stringify(r.roles))
// AND NOT ONTO THE WRONG ONES. `stick` is an excavator's second boom section; an earlier pattern
// for it included `arm`, which matches `upper_arm` and `forearm` on every character rig — so a
// person reported twenty-eight excavator sticks. A role vocabulary shared between characters and
// machines has to be checked in both directions.
ok('and not onto machine roles it has no business claiming',
  !r.roles?.stick && !r.roles?.boom && !r.roles?.bucket && !r.roles?.wheel,
  `machine roles present: ${Object.keys(r.roles ?? {}).filter((k) => ['stick','boom','bucket','wheel','slew'].includes(k)).join(', ') || 'none'}`)
ok('the bone classes add up to the total',
  r.deform + r.org + r.mch + r.control === r.bones,
  `${r.deform} deform + ${r.org} org + ${r.mch} mch + ${r.control} control = ${r.bones}`)
// THE POINT: deform is a small fraction. If everything came back as "control", the prefixes were
// not understood and the classification is decoration.
ok('the deform set is a small fraction of a control rig, which is what makes it worth separating',
  r.deform > 10 && r.deform < r.bones * 0.4,
  `${r.deform} of ${r.bones} (${((r.deform / r.bones) * 100).toFixed(0)}%)`)
ok('and it is recognised as an authoring rig, not a runtime one',
  r.mch + r.control > r.deform, `${r.mch + r.control} non-deform vs ${r.deform} deform`)

ok('the character is a sensible size in metres', (result.size?.[1] ?? 0) > 0.5 && (result.size?.[1] ?? 0) < 400,
  result.size ? result.size.map((n) => n.toFixed(2)).join(' x ') : 'no size')

// Something was drawn, and turning the skeleton on changed the picture.
ok('the mesh is drawn', result.before.max - result.before.min > 25,
  `luminance ${result.before.min}–${result.before.max}`)
ok('and the skeleton overlay actually changes what is on screen',
  Math.abs(result.after.mean - result.before.mean) > 0.3 || result.after.max !== result.before.max,
  `mean ${result.before.mean} → ${result.after.mean}`)

await browser.close()
server.close()
console.log(fails.length ? `\nFAIL: ${fails.length} — ${fails.join('; ')}` : '\nPASS: the rig reads as a rig')
process.exit(fails.length ? 1 : 0)
