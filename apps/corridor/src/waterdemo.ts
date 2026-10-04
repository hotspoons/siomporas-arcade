// Standalone water demo — the corridor water system on a plain background, without the terrain,
// trees or road. Used to check the shader compiles and to shoot before/after frames fast; the real
// thing is built by scene.ts. Query: ?site=<slug>&look=<preset>&line=<id>
import * as THREE from 'three'
import { buildWater } from './world/water'
import { WATER_LOOK_NAMES, WATER_PRESETS } from './world/waterShader'

const err = document.getElementById('err')!
window.addEventListener('error', (e) => { err.textContent = String(e.message) })

async function main() {
  const q = new URLSearchParams(location.search)
  const site = q.get('site') ?? 'braddock-i70'
  const wantLook = q.get('look')
  const wantLine = q.get('line')

  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true })
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.setPixelRatio(1)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  document.body.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x9db6c4)
  scene.fog = new THREE.FogExp2(0xaebfca, 0.0035)
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 20000)

  const sun = new THREE.DirectionalLight(0xfff3e0, 2.6)
  sun.position.set(0.4, 1.0, 0.35)
  scene.add(sun)
  scene.add(new THREE.HemisphereLight(0xbcd3e0, 0x2a2a22, 1.2))

  const manifest = await (await fetch(`/sites/${site}/web/manifest.json`)).json()
  const layer = manifest.water
  const water = buildWater(layer, () => null)
  scene.add(water.group)
  if (wantLook) water.setLook?.(wantLook)

  const toWorld = (p: [number, number, number]) => new THREE.Vector3(p[0], p[2], -p[1])
  const lines: any[] = (layer?.lines ?? []).filter((l: any) => !l.culvert && l.pts.length >= 2)
  const pick = (wantLine && lines.find((l) => l.id === wantLine)) || lines.slice().sort((a, b) => b.length_m - a.length_m)[0]
  if (pick) {
    const mid = Math.floor(pick.pts.length * 0.6)
    const p = toWorld(pick.pts[mid])
    const back = toWorld(pick.pts[Math.max(0, mid - 6)])
    const t = toWorld(pick.pts[Math.max(0, mid - 2)])
    const dir = new THREE.Vector3().subVectors(p, back).setY(0).normalize()
    const side = new THREE.Vector3(dir.z, 0, -dir.x)
    camera.position.copy(p).addScaledVector(dir, -6).addScaledVector(side, 4).add(new THREE.Vector3(0, 3.2, 0))
    camera.lookAt(t.x, t.y + 0.1, t.z)
    const bed = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 4000),
      new THREE.MeshStandardMaterial({ color: 0x3b3a2c, roughness: 0.95, metalness: 0 }),
    )
    bed.rotateX(-Math.PI / 2)
    bed.position.set(p.x, p.y - 1.1, p.z)
    scene.add(bed)
  } else {
    camera.position.set(0, 3, 12)
  }

  const clock = new THREE.Clock()
  renderer.setAnimationLoop(() => {
    water.tick(clock.getElapsedTime())
    renderer.render(scene, camera)
  })

  ;(window as any).__wd = {
    ready: true,
    THREE, scene, camera, water,
    names: WATER_LOOK_NAMES,
    presets: WATER_PRESETS,
    setLook: (n: string | null) => water.setLook(n),
    line: pick?.id ?? null,
    lines: water.lines,
    areas: water.areas,
    looks: water.looks,
  }
}

main().catch((e) => { err.textContent = String(e?.stack ?? e) })
