// A machine gun for the car, and the pieces of hardware a weapon shows: the launcher on the
// roof, the guns on the bonnet, the missile itself.
//
// Rich, 2026-09-30: *"missiles and machine guns as game mechanics that we can attach to vehicles
// and later actors ... rudimentary baked in missile launcher and gun models and missiles and
// bullets and muzzle flashes ... available for override in the placement editor ... anything but
// bullets which should probably just be a shader."*
//
// So: the models here are BUILT-INS — a few boxes and cylinders, sized in metres, pointing +X (the
// car's forward) — and the fixture classes `missile-launcher`, `machine-gun` and `missile`
// (fixtures.ts) let the Fixtures tab put a generated asset in each one's place. A bullet is a
// tracer: a thin quad with a gradient shader, additive, gone in a tenth of a second, and a hitscan
// underneath it — a sweep along the shot, the way the missile's flight is tested — so it lands on
// the first solid thing and the traffic layer is told where and which way.

import * as THREE from 'three'
import * as T from '../../tuning'

/* ---- built-in hardware ------------------------------------------------------------------------ */

const steel = () => new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.55, metalness: 0.7 })
const dark = () => new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.7, metalness: 0.4 })

/** a twin-tube launcher on a rail: 1.3 m long, sits on a roof rack */
export function builtinLauncher(): THREE.Group {
  const g = new THREE.Group()
  g.name = 'launcher'
  const rail = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.08, 0.7), dark())
  rail.position.set(0, 0.04, 0)
  g.add(rail)
  for (const z of [-0.2, 0.2]) {
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 1.3, 12), steel())
    tube.rotation.z = Math.PI / 2
    tube.position.set(0.05, 0.22, z)
    g.add(tube)
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.16, 0.08), dark())
    post.position.set(0, 0.14, z)
    g.add(post)
  }
  return g
}

/** a gun: a receiver box, a barrel with a muzzle, an ammunition can; the muzzle is at +0.75 m */
export function builtinGun(): THREE.Group {
  const g = new THREE.Group()
  g.name = 'gun'
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.14), dark())
  body.position.set(0, 0.1, 0)
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.7, 10), steel())
  barrel.rotation.z = Math.PI / 2
  barrel.position.set(0.5, 0.12, 0)
  const brake = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.12, 10), steel())
  brake.rotation.z = Math.PI / 2
  brake.position.set(0.8, 0.12, 0)
  const can = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.1), new THREE.MeshStandardMaterial({ color: 0x4d5a3a, roughness: 0.8 }))
  can.position.set(-0.05, 0.1, 0.14)
  const mount = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.1, 8), dark())
  mount.position.set(0, 0.01, 0)
  g.add(body, barrel, brake, can, mount)
  return g
}

/** a missile: a body, a nose, four fins; 1.1 m, pointing +X */
export function builtinMissile(): THREE.Group {
  const g = new THREE.Group()
  g.name = 'missile'
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.8, 10), new THREE.MeshStandardMaterial({ color: 0xdcdcdc, roughness: 0.4, metalness: 0.5 }))
  body.rotation.z = Math.PI / 2
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.3, 10), new THREE.MeshStandardMaterial({ color: 0xd23c1e, roughness: 0.5 }))
  nose.rotation.z = -Math.PI / 2
  nose.position.set(0.55, 0, 0)
  g.add(body, nose)
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.16, 0.01), dark())
    fin.position.set(-0.32, 0, 0)
    fin.rotation.x = (i * Math.PI) / 2
    fin.translateY(0.12)
    g.add(fin)
  }
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.35, 8), new THREE.MeshBasicMaterial({ color: 0xffaa33, transparent: true, opacity: 0.85, depthWrite: false }))
  flame.rotation.z = Math.PI / 2
  flame.position.set(-0.55, 0, 0)
  g.add(flame)
  return g
}

/* ---- the bullet: a shader, not a model -------------------------------------------------------- */

const TRACER_VERT = `
varying float vAlong;
void main() {
  vAlong = uv.x;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`
const TRACER_FRAG = `
uniform float uFade;
uniform vec3 uColour;
varying float vAlong;
void main() {
  float head = smoothstep(0.0, 0.15, vAlong) * smoothstep(1.0, 0.7, vAlong);
  gl_FragColor = vec4(uColour * (0.6 + 0.4 * vAlong), head * uFade);
}`

function tracerMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uFade: { value: 1 }, uColour: { value: new THREE.Color(0xffd27a) } },
    vertexShader: TRACER_VERT,
    fragmentShader: TRACER_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
}

export interface GunHit {
  /** where the round landed, world (three) frame */
  at: THREE.Vector3
  /** the way it was going, unit */
  dir: THREE.Vector3
}

interface Tracer { mesh: THREE.Mesh; age: number; life: number }
interface Flash { sprite: THREE.Sprite; age: number }

/** the two planes of a tracer, crossed, so it reads from any side */
const TRACER_GEOM = (() => {
  const g = new THREE.BufferGeometry()
  const w = 0.05
  // two quads along +X of unit length, crossed about X; uv.x runs tail→head
  const v: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  const quad = (ax: number, ay: number, az: number) => {
    const base = v.length / 3
    v.push(0, -ay * w, -az * w, 1, -ay * w, -az * w, 1, ay * w, az * w, 0, ay * w, az * w)
    uv.push(0, 0, 1, 0, 1, 1, 0, 1)
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    void ax
  }
  quad(0, 1, 0)
  quad(0, 0, 1)
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  return g
})()

let flashTexture: THREE.Texture | null = null
function flashMap(): THREE.Texture | null {
  if (flashTexture) return flashTexture
  if (typeof document === 'undefined') return null // a headless test: a flash with no picture
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const ctx = c.getContext('2d')!
  const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255,255,220,1)')
  grad.addColorStop(0.35, 'rgba(255,190,90,0.9)')
  grad.addColorStop(1, 'rgba(255,120,30,0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 64, 64)
  flashTexture = new THREE.CanvasTexture(c)
  return flashTexture
}

/**
 * The machine gun: hold to fire at `GUN_RATE`, rounds alternating between the muzzles, each a
 * hitscan along the aim with a little spread, drawn as a tracer, with a flash at the muzzle and a
 * spark where it lands.
 */
export class GunLayer {
  readonly group = new THREE.Group()
  private tracers: Tracer[] = []
  private flashes: Flash[] = []
  private cooldown = 0
  private next = 0
  fired = 0
  hits = 0
  lastHit: GunHit | null = null
  private hitTest: (from: THREE.Vector3, to: THREE.Vector3) => THREE.Vector3 | null
  private groundAt: (x: number, z: number) => number | null
  private onHit: (hit: GunHit) => void

  constructor(o: { hitTest: GunLayer['hitTest']; groundAt: GunLayer['groundAt']; onHit: GunLayer['onHit'] }) {
    this.group.name = 'gun'
    this.hitTest = o.hitTest
    this.groundAt = o.groundAt
    this.onHit = o.onHit
  }

  /** The trigger is held this frame. `muzzles` are world points; `aim` is the unit direction. */
  fire(muzzles: THREE.Vector3[], aim: THREE.Vector3, dt: number): void {
    if (!muzzles.length) return
    this.cooldown -= dt
    const period = 1 / Math.max(1, T.GUN_RATE)
    let shots = 0
    while (this.cooldown <= 0 && shots < 4) {
      this.cooldown += period
      shots++
      const from = muzzles[this.next % muzzles.length]
      this.next++
      const dir = aim.clone().normalize()
      dir.x += (Math.random() - 0.5) * T.GUN_SPREAD
      dir.y += (Math.random() - 0.5) * T.GUN_SPREAD
      dir.z += (Math.random() - 0.5) * T.GUN_SPREAD
      dir.normalize()
      const far = from.clone().addScaledVector(dir, T.GUN_RANGE)
      let at = this.hitTest(from, far)
      if (!at) {
        // the ground, by walking the ray: the sweep only knows what has a collider
        for (let s = 4; s < T.GUN_RANGE; s += 4) {
          const p = from.clone().addScaledVector(dir, s)
          const g = this.groundAt(p.x, p.z)
          if (g !== null && p.y <= g) { at = p.setY(g); break }
        }
      }
      const end = at ?? far
      this.tracer(from, end)
      this.flash(from, 0.9)
      this.fired++
      if (at) {
        this.hits++
        this.flash(at, 0.5)
        this.lastHit = { at: at.clone(), dir: dir.clone() }
        this.onHit({ at, dir })
      }
    }
  }

  private tracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const d = to.clone().sub(from)
    const len = d.length()
    if (len < 0.5) return
    const mesh = new THREE.Mesh(TRACER_GEOM, tracerMaterial())
    mesh.position.copy(from)
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), d.divideScalar(len))
    mesh.scale.set(len, 1, 1)
    mesh.frustumCulled = false
    this.group.add(mesh)
    this.tracers.push({ mesh, age: 0, life: 0.09 })
  }

  private flash(at: THREE.Vector3, size: number): void {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashMap() ?? undefined, color: 0xffcc77, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }))
    sprite.position.copy(at)
    sprite.scale.setScalar(size * (0.8 + Math.random() * 0.5))
    sprite.material.rotation = Math.random() * Math.PI
    this.group.add(sprite)
    this.flashes.push({ sprite, age: 0 })
  }

  tick(dt: number): void {
    for (const t of [...this.tracers]) {
      t.age += dt
      const k = t.age / t.life
      if (k >= 1) {
        this.group.remove(t.mesh)
        ;(t.mesh.material as THREE.Material).dispose()
        this.tracers.splice(this.tracers.indexOf(t), 1)
        continue
      }
      ;(t.mesh.material as THREE.ShaderMaterial).uniforms.uFade.value = 1 - k
    }
    for (const f of [...this.flashes]) {
      f.age += dt
      const k = f.age / 0.06
      if (k >= 1) {
        this.group.remove(f.sprite)
        f.sprite.material.dispose()
        this.flashes.splice(this.flashes.indexOf(f), 1)
        continue
      }
      f.sprite.material.opacity = 1 - k
    }
  }

  get live(): number {
    return this.tracers.length
  }

  dispose(): void {
    for (const t of this.tracers) this.group.remove(t.mesh)
    for (const f of this.flashes) this.group.remove(f.sprite)
    this.tracers = []
    this.flashes = []
    this.group.removeFromParent()
  }
}

/* ---- where the hardware sits on a car ---------------------------------------------------------- */

export interface Mounted {
  root: THREE.Group
  /** the gun muzzles, in the car mesh's own frame (+X forward, +Y up, +Z right) */
  muzzles: THREE.Vector3[]
}

/**
 * Hang the launcher on the roof and a gun on each bonnet corner, from the chassis spec. The
 * models may be overrides (a fixture choice) or the built-ins; either is fitted by eye to the
 * car's size. Returns the group to add to the car mesh, and the muzzle points to fire from.
 */
export function mountWeapons(spec: { length: number; width: number; height: number }, models: { launcher: THREE.Object3D | null; gun: THREE.Object3D | null }): Mounted {
  const root = new THREE.Group()
  root.name = 'weapons'
  const launcher = models.launcher?.clone(true) ?? builtinLauncher()
  launcher.position.set(-spec.length * 0.08, spec.height * 0.95, 0)
  root.add(launcher)
  const muzzles: THREE.Vector3[] = []
  for (const side of [-1, 1]) {
    const gun = models.gun?.clone(true) ?? builtinGun()
    gun.position.set(spec.length * 0.28, spec.height * 0.62, side * spec.width * 0.3)
    root.add(gun)
    muzzles.push(gun.position.clone().add(new THREE.Vector3(0.85, 0.12, 0)))
  }
  return { root, muzzles }
}
