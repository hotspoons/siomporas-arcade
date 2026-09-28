#!/usr/bin/env node
// Look at the mesh. A proportion that reads like a car does not prove the thing is a car.
//
//   node tools/assetlib/turntable.mjs --id rx7-fd
//   node tools/assetlib/turntable.mjs --class hero-car --out /tmp/sheet
//
// Renders each finished glb from four yaws into one contact sheet, so the half TRELLIS invented
// from a single three-quarter view is visible next to the half it was shown. That far flank is the
// known cost of single-view reconstruction (see README) and this is how we judge whether the cost
// is acceptable per asset rather than assuming it.
//
// A DRACOLoader IS MANDATORY and its absence does not warn — GLTFLoader simply rejects, so a
// `.catch(() => placeholder)` anywhere in a consumer turns a real model into a box silently. The
// decoder is the vendored copy the corridor viewer already ships.

import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIB = path.resolve(HERE, '..')
const ROOT = path.resolve(LIB, '../..')

const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.html': 'text/html' }

const PAGE = (url, size) => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#8a8f96}canvas{display:block}</style>
<script type="importmap">{"imports":{
  "three":"/node_modules/three/build/three.module.js",
  "three/addons/":"/node_modules/three/examples/jsm/"}}</script></head><body>
<script type="module">
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

const S = ${size}
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setSize(S, S); document.body.appendChild(renderer.domElement)
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x8a8f96)
// Lit, not unlit: these keep their PBR material because corridor lights its own scene, so a flat
// render here would be lying about what the game will show.
scene.add(new THREE.HemisphereLight(0xffffff, 0x444450, 1.4))
const pmrem = new THREE.PMREMGenerator(renderer)
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
const key = new THREE.DirectionalLight(0xffffff, 2.0); key.position.set(3, 5, 4); scene.add(key)
const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100)

const draco = new DRACOLoader(); draco.setDecoderPath('/apps/corridor/public/assets/vendor/draco/')
const loader = new GLTFLoader(); loader.setDRACOLoader(draco)

window.__shots = []
const gltf = await loader.loadAsync(${JSON.stringify(url)})
const root = gltf.scene
const box = new THREE.Box3().setFromObject(root)
const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3())
root.position.sub(c)
const pivot = new THREE.Group(); pivot.add(root); scene.add(pivot)
const r = Math.max(s.x, s.y, s.z)

for (const yaw of [0, 90, 180, 270]) {
  pivot.rotation.y = yaw * Math.PI / 180
  camera.position.set(0, r * 0.45, r * 2.6); camera.lookAt(0, 0, 0)
  renderer.render(scene, camera)
  window.__shots.push(renderer.domElement.toDataURL('image/png'))
}
window.__done = true
</script></body></html>`

async function shoot(browser, server, port, glb, out, size) {
  const page = await browser.newPage({ viewport: { width: size, height: size } })
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  // Served, not setContent: an import map is resolved against the DOCUMENT's URL, and on the
  // about:blank document setContent gives you every bare specifier resolves to null and the page
  // dies with "blocked by a null value".
  const rel = `/${path.relative(ROOT, glb)}`
  await page.goto(`http://127.0.0.1:${port}/__render?glb=${encodeURIComponent(rel)}&size=${size}`)
  try {
    await page.waitForFunction('window.__done === true', null, { timeout: 60000 })
  } catch {
    await page.close()
    // Loud: a silent black frame is exactly how a rejected DRACOLoader looks.
    throw new Error(`render never completed${errs.length ? `: ${errs[0]}` : ' (no page error — check the decoder path)'}`)
  }
  const shots = await page.evaluate('window.__shots')
  await page.close()
  return shots.map((d) => Buffer.from(d.split(',')[1], 'base64'))
}

const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1] }
const outDir = path.resolve(flag('out', path.join(LIB, 'sheets')))
const size = Number(flag('size', 420))
const id = flag('id')

const dir = path.join(LIB, 'out')
// --glb renders one explicit file, which is how a variant (a glass split, a debug selection) gets
// looked at without pretending to be the asset's shipped mesh.
const explicit = flag('glb')
const ids = explicit ? [explicit]
  : (id ? [id] : readdirSync(dir)).filter((d) => existsSync(path.join(dir, d, `${d}-finished.glb`)))
if (!ids.length) { console.error('nothing finished to render'); process.exit(1) }
mkdirSync(outDir, { recursive: true })

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/__render') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGE(u.searchParams.get('glb'), Number(u.searchParams.get('size')) || 420))
    return
  }
  const f = path.join(ROOT, decodeURIComponent(u.pathname))
  if (!f.startsWith(ROOT) || !existsSync(f)) { res.writeHead(404).end(); return }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream' })
  res.end(readFileSync(f))
}).listen(0)
await new Promise((r) => server.once('listening', r))
const port = server.address().port

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
for (const one of ids) {
  const glb = explicit ? path.resolve(explicit) : path.join(dir, one, `${one}-finished.glb`)
  const label = explicit ? path.basename(explicit, '.glb') : one
  try {
    const shots = await shoot(browser, server, port, glb, outDir, size)
    for (const [i, buf] of shots.entries()) writeFileSync(path.join(outDir, `${label}-${i}.png`), buf)
    const { execFileSync } = await import('node:child_process')
    execFileSync('magick', [...shots.map((_, i) => path.join(outDir, `${label}-${i}.png`)), '+append', path.join(outDir, `${label}.png`)])
    for (const [i] of shots.entries()) execFileSync('rm', ['-f', path.join(outDir, `${label}-${i}.png`)])
    console.log(`${label}.png  4 yaws`)
  } catch (e) { console.error(`${one}: ${e.message}`) }
}
await browser.close()
server.close()
