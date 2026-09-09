// The model viewer: /model.html
//
// Every shape in this game is seen for about four frames as a sprite forty pixels tall, which is a
// terrible way to judge whether it is the right shape. This page puts the actual meshes on a
// turntable so they can be looked at, turned around and argued with — lit exactly the way the sprite
// bake lights them, so what you see here is what ends up in the atlas.
//
// The camera presets match the yaws the atlas bakes, so "rear" and "flank" here are the frames the
// game will really draw.

import '../style.css'
import { AmbientLight, DirectionalLight, GridHelper, Group, HemisphereLight, Mesh, MeshStandardMaterial, Object3D, PerspectiveCamera, Scene, SRGBColorSpace, WebGLRenderer } from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { buildArch, buildBlock, buildDiner, buildFacade, buildGasStation, buildMotel, buildPrototype, buildSign, buildTower, ensureFonts, LIVERIES, PROCGEN_VERSION } from '../render/procgen'
import { MODELS } from '../render/models'

const app = document.querySelector<HTMLElement>('#app')!
app.innerHTML = `
  <div class="viewer">
    <canvas class="stage"></canvas>
    <div class="panel">
      <h1>Turbo Radrun · models</h1>
      <label>Model <select data-model></select></label>
      <label>Livery <select data-livery></select></label>
      <div class="views" data-views></div>
      <label class="check"><input type="checkbox" data-wire /> Wireframe</label>
      <label class="check"><input type="checkbox" data-spin checked /> Turntable</label>
      <p class="hint" data-hint>Drag to orbit · scroll to zoom · procgen v${PROCGEN_VERSION}</p>
    </div>
  </div>`

const canvas = app.querySelector<HTMLCanvasElement>('canvas.stage')!
const renderer = new WebGLRenderer({ canvas, antialias: true })
renderer.outputColorSpace = SRGBColorSpace
renderer.setClearColor(0x11151c)

const scene = new Scene()
// The bake's lighting, verbatim: a model that reads here reads in the atlas.
scene.add(new AmbientLight(0xffffff, 0.35))
scene.add(new HemisphereLight(0xffffff, 0x8080a0, 0.7))
const sun = new DirectionalLight(0xffffff, 1.6)
sun.position.set(3, 6, 4)
scene.add(sun)
const grid = new GridHelper(20, 20, 0x44506a, 0x222a38)
scene.add(grid)
const holder = new Group()
scene.add(holder)

// The bake's lens, near enough: a long one, so the viewer foreshortens the way the sprite does.
const camera = new PerspectiveCamera(22, 1, 0.1, 200)
camera.position.set(10, 5, 13)
const controls = new OrbitControls(camera, canvas)
controls.target.set(0, 0.7, 0)
controls.enableDamping = true

/** Everything the viewer can show: the procedural models by name, plus every GLB in the manifest. */
const PROCEDURAL: Record<string, () => Object3D> = {
  'hero prototype': () => buildPrototype(LIVERIES[liverySelect.value] ?? LIVERIES.rosso),
  diner: buildDiner,
  motel: buildMotel,
  'gas station': buildGasStation,
  'tower (24 m)': () => buildTower(24, 0x8fa0b4),
  'facade (3 floors)': () => buildFacade(9, 3, 0xc8b8a0, 1, true),
  'block (12 m)': () => buildBlock(12, 10, 0x9aa8b8),
  sign: () => buildSign('MOTOR DINER', '#fff8e0', '#c83838'),
  arch: buildArch,
}

const modelSelect = app.querySelector<HTMLSelectElement>('[data-model]')!
const liverySelect = app.querySelector<HTMLSelectElement>('[data-livery]')!
const hint = app.querySelector<HTMLElement>('[data-hint]')!
for (const name of Object.keys(PROCEDURAL)) modelSelect.add(new Option(name, name))
for (const def of MODELS) if (def.file) modelSelect.add(new Option(`glb · ${def.kind}`, `glb:${def.file}`))
for (const name of Object.keys(LIVERIES)) liverySelect.add(new Option(name, name))
liverySelect.value = 'rosso'

const loader = new GLTFLoader()
let current: Object3D | null = null

async function show(): Promise<void> {
  const key = modelSelect.value
  if (current) holder.remove(current)
  current = null
  let model: Object3D
  if (key.startsWith('glb:')) {
    const gltf = await loader.loadAsync(key.slice(4))
    model = gltf.scene
  } else {
    model = PROCEDURAL[key]()
  }
  model.traverse((o) => {
    const m = o as Mesh
    if (m.isMesh) {
      const mats = Array.isArray(m.material) ? m.material : [m.material]
      for (const mat of mats) {
        const sm = mat as MeshStandardMaterial
        if (sm.isMeshStandardMaterial) sm.flatShading = true
        sm.wireframe = wireBox.checked
        sm.needsUpdate = true
      }
    }
  })
  holder.add(model)
  current = model
  liverySelect.disabled = key !== 'hero prototype'
  hint.textContent = `${key} · drag to orbit · scroll to zoom · procgen v${PROCGEN_VERSION}`
}

const wireBox = app.querySelector<HTMLInputElement>('[data-wire]')!
const spinBox = app.querySelector<HTMLInputElement>('[data-spin]')!
modelSelect.addEventListener('change', () => void show())
liverySelect.addEventListener('change', () => void show())
wireBox.addEventListener('change', () => void show())

// The angles the atlas bakes, so a preset here is a frame the game really draws.
const VIEWS: [string, number, number][] = [
  ['rear', 0, 9],
  ['3/4 rear', 24, 9],
  ['flank', 90, 9],
  ['3/4 front', 150, 9],
  ['front', 180, 9],
  ['from above', 24, 30],
]
const views = app.querySelector<HTMLElement>('[data-views]')!
for (const [label, yaw, pitch] of VIEWS) {
  const b = document.createElement('button')
  b.textContent = label
  b.addEventListener('click', () => {
    // Stop the turntable *and* put the model back to zero: a preset is only the bake's angle if the
    // car is facing the way the bake has it.
    spinBox.checked = false
    holder.rotation.y = 0
    // Far enough back for the long lens above to frame the whole car.
    const r = 16
    const yawR = (yaw * Math.PI) / 180
    const pitchR = (pitch * Math.PI) / 180
    camera.position.set(Math.sin(yawR) * r * Math.cos(pitchR), 0.7 + Math.sin(pitchR) * r, -Math.cos(yawR) * r * Math.cos(pitchR))
    controls.target.set(0, 0.7, 0)
    controls.update()
  })
  views.appendChild(b)
}

// A dev handle, so a headless pass can point the camera at a detail and screenshot it.
;(window as unknown as { __model: unknown }).__model = { scene, camera, controls, holder }

function resize(): void {
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (!w || !h) return
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}
window.addEventListener('resize', resize)

let last = performance.now()
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  resize()
  if (spinBox.checked) holder.rotation.y += dt * 0.5
  controls.update()
  renderer.render(scene, camera)
  requestAnimationFrame(frame)
}
void ensureFonts()
  .then(show)
  .then(() => requestAnimationFrame(frame))
