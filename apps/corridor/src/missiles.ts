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
import * as T from './tuning'

export interface MissileHit {
  x: number
  y: number
  z: number
}

interface Missile {
  mesh: THREE.Object3D
  pos: THREE.Vector3
  vel: THREE.Vector3
  flown: number
  age: number
}

interface Flash {
  mesh: THREE.Mesh
  light: THREE.PointLight
  age: number
}

export class MissileLayer {
  readonly group = new THREE.Group()
  private live: Missile[] = []
  private flashes: Flash[] = []
  /** the first solid thing along a segment, or null: the app supplies it from the physics world */
  private hitTest: (from: THREE.Vector3, to: THREE.Vector3) => THREE.Vector3 | null
  private groundAt: (x: number, z: number) => number | null
  private onHit: (at: MissileHit) => void
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
    const mesh = new THREE.Mesh(
      new THREE.ConeGeometry(0.14, 1.1, 8),
      new THREE.MeshStandardMaterial({ color: 0xdddddd, emissive: 0xff5500, emissiveIntensity: 0.8, roughness: 0.4, metalness: 0.5 }),
    )
    // a cone points up +Y; turn it to fly along `d`
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d)
    mesh.position.copy(from)
    this.group.add(mesh)
    this.live.push({ mesh, pos: from.clone(), vel: d.multiplyScalar(T.MISSILE_SPEED + Math.max(0, carry)), flown: 0, age: 0 })
    this.fired++
  }

  tick(dt: number): void {
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
      m.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), m.vel.clone().normalize())
    }
    for (const f of [...this.flashes]) {
      f.age += dt
      const t = f.age / 0.45
      if (t >= 1) {
        this.group.remove(f.mesh, f.light)
        f.mesh.geometry.dispose()
        ;(f.mesh.material as THREE.Material).dispose()
        this.flashes.splice(this.flashes.indexOf(f), 1)
        continue
      }
      f.mesh.scale.setScalar(1 + t * T.MISSILE_RADIUS * 0.8)
      ;(f.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t)
      f.light.intensity = 40 * (1 - t)
    }
  }

  private flash(at: THREE.Vector3): void {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffaa33, transparent: true, opacity: 0.9, depthWrite: false }))
    mesh.position.copy(at)
    const light = new THREE.PointLight(0xffaa55, 40, T.MISSILE_RADIUS * 4)
    light.position.copy(at)
    this.group.add(mesh, light)
    this.flashes.push({ mesh, light, age: 0 })
  }

  get inFlight(): number {
    return this.live.length
  }

  dispose(): void {
    for (const m of this.live) this.group.remove(m.mesh)
    for (const f of this.flashes) this.group.remove(f.mesh, f.light)
    this.live = []
    this.flashes = []
    this.group.removeFromParent()
  }
}
