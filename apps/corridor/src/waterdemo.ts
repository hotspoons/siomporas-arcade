// Standalone water demo. Two modes:
//   ?mode=lagoon (default) — a wide shallow body over a sand bed under a real sky environment, so
//                            the reflection and the see-through depth that give water its look are
//                            both present. This is the honest test of the shader.
//   ?mode=site             — the real water of a baked site on a plain background (ribbons only).
// Query: ?mode= &site=<slug> &look=<preset> &line=<id>
import * as THREE from 'three'
import { buildWater } from './world/water'
import { WATER_LOOK_NAMES, WATER_PRESETS } from './world/waterShader'

const err = document.getElementById('err')!
window.addEventListener('error', (e) => { err.textContent = String(e.message) })

function makeSky(): THREE.Texture {
  const w = 1024, h = 512
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const g = c.getContext('2d')!
  const grad = g.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0.0, '#1d5fbe')
  grad.addColorStop(0.42, '#4f92d4')
  grad.addColorStop(0.5, '#8fb9dd')
  grad.addColorStop(0.53, '#9aa9a0')
  grad.addColorStop(1.0, '#4d5a4f')
  g.fillStyle = grad
  g.fillRect(0, 0, w, h)
  const sx = 0.66 * w, sy = 0.24 * h
  const rg = g.createRadialGradient(sx, sy, 0, sx, sy, 90)
  rg.addColorStop(0, 'rgba(255,252,240,0.95)')
  rg.addColorStop(0.25, 'rgba(255,246,214,0.5)')
  rg.addColorStop(1, 'rgba(255,246,214,0)')
  g.fillStyle = rg
  g.beginPath(); g.arc(sx, sy, 150, 0, Math.PI * 2); g.fill()
  const tex = new THREE.CanvasTexture(c)
  tex.mapping = THREE.EquirectangularReflectionMapping
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

async function main() {
  const q = new URLSearchParams(location.search)
  const mode = q.get('mode') ?? 'lagoon'
  const site = q.get('site') ?? 'braddock-i70'
  const wantLook = q.get('look')
  const wantLine = q.get('line')

  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true })
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.setPixelRatio(1)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.95
  document.body.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  const sky = makeSky()
  const pmrem = new THREE.PMREMGenerator(renderer)
  scene.environment = pmrem.fromEquirectangular(sky).texture
  scene.background = sky
  scene.fog = new THREE.FogExp2(0xc7d6dc, 0.0016)

  const sun = new THREE.DirectionalLight(0xfff2dc, 1.9)
  sun.position.set(0.4, 0.45, 0.8)
  scene.add(sun)
  scene.add(new THREE.HemisphereLight(0xbcd6e6, 0x4a4636, 0.75))

  const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 30000)

  const toWorld = (p: [number, number, number]) => new THREE.Vector3(p[0], p[2], -p[1])

  let layer: any
  if (mode === 'site') {
    const manifest = await (await fetch(`/sites/${site}/web/manifest.json`)).json()
    layer = manifest.water
  } else {
    // a straight, wide, shallow channel: a lagoon with a shelving shore
    const pts: [number, number, number][] = []
    for (let i = 0; i <= 12; i++) pts.push([i * 40 - 80, 0, 0])
    layer = {
      lines: [{ id: 'demo-lagoon', kind: 'river', name: 'lagoon', width_m: 260, culvert: false, length_m: 480, fall_m: 0, pts, falls: [] }],
      areas: [],
    }
  }

  const water = buildWater(layer, () => null)
  scene.add(water.group)
  if (wantLook) water.setLook?.(wantLook)

  // a bed the water can be seen through (the refraction substitute)
  const bedY = mode === 'lagoon' ? -1.5 : null
  if (bedY !== null) {
    const bed = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 4000, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x8f7d55, roughness: 0.98, metalness: 0 }),
    )
    bed.rotateX(-Math.PI / 2)
    bed.position.set(0, bedY, 0)
    scene.add(bed)
  }

  if (mode === 'site') {
    const lines: any[] = (layer?.lines ?? []).filter((l: any) => !l.culvert && l.pts.length >= 2)
    const pick = (wantLine && lines.find((l) => l.id === wantLine)) || lines.slice().sort((a, b) => b.length_m - a.length_m)[0]
    if (pick) {
      const mid = Math.floor(pick.pts.length * 0.6)
      const p = toWorld(pick.pts[mid])
      const back = toWorld(pick.pts[Math.max(0, mid - 6)])
      const t = toWorld(pick.pts[Math.max(0, mid - 2)])
      const dir = new THREE.Vector3().subVectors(p, back).setY(0).normalize()
      const side = new THREE.Vector3(dir.z, 0, -dir.x)
      camera.position.copy(p).addScaledVector(dir, -10).addScaledVector(side, 5).add(new THREE.Vector3(0, 4, 0))
      camera.lookAt(t.x, t.y + 0.1, t.z)
      const bed = new THREE.Mesh(
        new THREE.PlaneGeometry(4000, 4000, 1, 1),
        new THREE.MeshStandardMaterial({ color: 0x6b5f43, roughness: 0.98, metalness: 0 }),
      )
      bed.rotateX(-Math.PI / 2)
      bed.position.set(p.x, p.y - 0.7, p.z)
      scene.add(bed)
    }
  } else {
    // a little above the water, looking down and across so the bed shows through
    camera.position.set(-70, 22, 130)
    camera.lookAt(60, -0.4, -20)
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
    setLook: (n: string | null) => water.setLook?.(n),
    line: mode === 'site' ? (layer?.lines?.[0]?.id ?? null) : 'demo-lagoon',
    lines: water.lines,
    areas: water.areas,
    looks: water.looks,
  }
}

main().catch((e) => { err.textContent = String(e?.stack ?? e) })
