// Missiles: something to fire at the traffic, and the bang when it lands.
//
// Rich, 2026-09-30: *"We also need to be able to launch missiles at cars and when they hit explode
// them and make them go flying. Need that baked into traffic physics."*
//
// A missile is not a rigid body — a small fast body is the thing a physics engine is worst at —
// but a point flown by hand each frame, with a ray cast over the ground it covered: the first
// solid thing on that ray is where it lands. Landing is a blast (`physics.explode`, after the
// traffic layer has woken every car in reach so the blast can throw them) and a flash. The
// numbers are the rocket launcher's from weaponpresets.ts, over the F6 knobs.

import * as THREE from 'three'
import * as T from '../../tuning'

export interface MissileHit {
  x: number
  y: number
  z: number
}

interface Missile {
  mesh: THREE.Object3D
  /** the mesh's own forward axis, to turn along the flight: +Y for the cone, +X for a model */
  axis: THREE.Vector3
  pos: THREE.Vector3
  vel: THREE.Vector3
  flown: number
  age: number
}

interface Flash {
  mesh: THREE.Mesh
  /** a light from the fixed pool, or null once a newer flash has taken it over */
  light: THREE.PointLight | null
  age: number
}

/**
 * How many flash lights the pool keeps.
 *
 * ONE, not six. Three bakes the visible light COUNT into every material's shader and includes a
 * light even at `intensity: 0`, so this pool is a permanent per-fragment cost for as long as the car
 * is armed. Measured parked, same geometry, 2026-10-03: six lights cost ~13 ms/frame (~2.2 ms each),
 * one costs ~0.9 ms. One still lights the ground under a missile without the bill; a second
 * overlapping flash shares it (the newest takes it over). The count must still never change, which
 * is the whole point of the pool.
 */
const FLASH_LIGHTS = 1

/** the fallback missile's cone, made once (see weaponfx.ts `builtinMissile` for why) */
let flashGeo: THREE.SphereGeometry | null = null
let coneGeo: THREE.ConeGeometry | null = null
let coneMat: THREE.MeshStandardMaterial | null = null

export class MissileLayer {
  readonly group = new THREE.Group()
  private live: Missile[] = []
  private flashes: Flash[] = []
  /**
   * The flash lights, a FIXED pool made once and never removed.
   *
   * Three bakes the scene's light COUNT into every material's shader, so a `new PointLight` per
   * explosion recompiled the whole world on that frame — a 200-280 ms stall on the first missile
   * and on any new overlapping count after it. Holding `numPointLights` still (fade to zero,
   * never remove) means a landing missile compiles nothing.
   */
  private readonly flashLights: THREE.PointLight[] = Array.from({ length: FLASH_LIGHTS }, () => {
    const l = new THREE.PointLight(0xffaa55, 0, T.MISSILE_RADIUS * 4)
    this.group.add(l)
    return l
  })
  private flashCursor = 0
  /** the first solid thing along a segment, or null: the app supplies it from the physics world */
  private hitTest: (from: THREE.Vector3, to: THREE.Vector3) => THREE.Vector3 | null
  private groundAt: (x: number, z: number) => number | null
  private onHit: (at: MissileHit) => void
  /** the round's model, pointing +X — a fixture override or the built-in; null draws the cone */
  model: (() => THREE.Object3D) | null = null
  /** fired and landed, for the HUD and for a probe */
  fired = 0
  landed = 0
  /** where the last one landed, for a probe */
  lastHit: MissileHit | null = null

  constructor(o: { hitTest: MissileLayer['hitTest']; groundAt: MissileLayer['groundAt']; onHit: MissileLayer['onHit'] }) {
    this.group.name = 'missiles'
    this.hitTest = o.hitTest
    this.groundAt = o.groundAt
    this.onHit = o.onHit
  }

  /** Away it goes: from a point, along a direction, at the missile speed plus whatever `carry` is. */
  fire(from: THREE.Vector3, dir: THREE.Vector3, carry = 0): void {
    const d = dir.clone().normalize()
    const custom = this.model?.() ?? null
    // the plain cone shares one geometry and material: a landed missile is dropped, not disposed
    const mesh: THREE.Object3D = custom ?? new THREE.Mesh((coneGeo ??= new THREE.ConeGeometry(0.14, 1.1, 8)), (coneMat ??= new THREE.MeshStandardMaterial({ color: 0xdddddd, emissive: 0xff5500, emissiveIntensity: 0.8, roughness: 0.4, metalness: 0.5 })))
    // a cone points up +Y and a model +X; turn it to fly along `d`
    const axis = custom ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
    mesh.quaternion.setFromUnitVectors(axis, d)
    mesh.position.copy(from)
    this.group.add(mesh)
    this.live.push({ mesh, axis, pos: from.clone(), vel: d.multiplyScalar(T.MISSILE_SPEED + Math.max(0, carry)), flown: 0, age: 0 })
    this.fired++
  }

  tick(dt: number): void {
    // A hitch used to arrive here as the raw gap between frames. At 120 m/s that is a shape-cast
    // hundreds of metres long through every heightfield tile along the way, which is the one- and
    // two-second freeze on firing. The frame is capped, and each cast covers at most a few metres,
    // so the query stays on the tiles the missile is actually crossing.
    const total = Math.min(0.1, Math.max(0, dt))
    let left = total
    while (left > 1e-4 && this.live.length) {
      const h = Math.min(left, this.slice(left))
      left -= h
      this.advance(h)
    }
    this.ageFlashes(total)
  }

  /** How long the fastest missile may fly before its cast would cover more than a few metres. */
  private slice(left: number): number {
    let speed = 1
    for (const m of this.live) speed = Math.max(speed, m.vel.length())
    return Math.min(left, 6 / speed)
  }

  private advance(dt: number): void {
    for (const m of [...this.live]) {
      const next = m.pos.clone().addScaledVector(m.vel, dt)
      // a touch of gravity, so a long shot drops; enough to feel, not enough to aim around
      m.vel.y -= 2.5 * dt
      m.age += dt
      m.flown += m.vel.length() * dt
      let at: THREE.Vector3 | null = this.hitTest(m.pos, next)
      if (!at) {
        const g = this.groundAt(next.x, next.z)
        if (g !== null && next.y <= g + 0.2) at = new THREE.Vector3(next.x, g + 0.2, next.z)
      }
      if (at || m.flown > 500 || m.age > 8) {
        this.group.remove(m.mesh)
        this.live.splice(this.live.indexOf(m), 1)
        if (at) {
          this.landed++
          this.lastHit = { x: at.x, y: at.y, z: at.z }
          this.flash(at)
          this.onHit({ x: at.x, y: at.y, z: at.z })
        }
        continue
      }
      m.pos.copy(next)
      m.mesh.position.copy(next)
      m.mesh.quaternion.setFromUnitVectors(m.axis, m.vel.clone().normalize())
    }
  }

  private ageFlashes(dt: number): void {
    for (const f of [...this.flashes]) {
      f.age += dt
      const t = f.age / 0.45
      if (t >= 1) {
        this.group.remove(f.mesh)
        this.flashPool.push(f.mesh.material as THREE.MeshBasicMaterial)
        if (f.light) f.light.intensity = 0 // back to the pool: dim, never removed
        this.flashes.splice(this.flashes.indexOf(f), 1)
        continue
      }
      f.mesh.scale.setScalar(1 + t * T.MISSILE_RADIUS * 0.8)
      ;(f.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t)
      if (f.light) f.light.intensity = 40 * (1 - t)
    }
  }

  /** spent flash materials, kept: disposing the last one released its program and the next landing compiled it again */
  private flashPool: THREE.MeshBasicMaterial[] = []

  private flash(at: THREE.Vector3): void {
    const mat = this.flashPool.pop() ?? new THREE.MeshBasicMaterial({ color: 0xffaa33, transparent: true, opacity: 0.9, depthWrite: false })
    mat.opacity = 0.9
    const mesh = new THREE.Mesh((flashGeo ??= new THREE.SphereGeometry(1, 16, 12)), mat)
    mesh.position.copy(at)
    // A light from the pool, round-robin. If every one is busy the oldest is taken over; the count
    // is what matters and it never changes.
    const light = this.flashLights[this.flashCursor++ % this.flashLights.length]
    const taken = this.flashes.find((f) => f.light === light)
    if (taken) taken.light = null
    light.position.copy(at)
    light.intensity = 40
    this.group.add(mesh)
    this.flashes.push({ mesh, light, age: 0 })
  }

  get inFlight(): number {
    return this.live.length
  }

  dispose(): void {
    for (const m of this.live) this.group.remove(m.mesh)
    for (const f of this.flashes) this.group.remove(f.mesh)
    this.live = []
    this.flashes = []
    this.group.removeFromParent() // the pool lights ride the group out
  }
}
