// PARKOUR / ARCHER — the second game on top of the corridor world.
//
// Rich's nine-year-old: "a real life parkour and gymnastics game where the main character gets
// points for pirouetting off of a tree or a house and landing crazy moves — and they are also an
// archer, and they will need to clear baddies. Occasionally they will get into a battle and will
// need to fend off enemies from the first person."
//
// A first pass, and honest about it: the character is a capsule with a head, not a rigged
// figure, and there are no animations. What IS here is the game: a third-person runner on the
// real ground, real houses to jump onto (the bake's footprints and lidar heights are the
// obstacles — a roof is a roof because the building record says so), a jump with air control
// that scores spin, roof landings and clean rolls, a bow whose arrows fall under gravity, and
// goblins that wander the road network, chase when you are close, and go down to an arrow.
// Aiming pulls the camera to the shoulder; within a few metres of a goblin it is first person.
//
//   W A S D   run, in the direction the camera looks        Shift  sprint
//   Space     jump; in the air, A / D spin (a full turn is a pirouette)
//   Space     again just before landing: roll it out clean (bonus); miss it and you stumble
//   F (hold)  draw the bow, click to loose an arrow          Esc    put the bow away
//   mouse     left-drag orbits the camera round the runner
import * as THREE from 'three'
import type { Site } from '../scene'
import { BoundsIndex } from '../strip'
import { el, toast } from '../ui/shell'
import { icon } from '../ui/icons'

const G = 18 // stronger than earth: a game jump reads better with a snappier fall
const RUN = 6.5
const SPRINT = 10
const JUMP = 8.2
const SPIN = 4.6 // rad/s of air spin with a key held
const MANTLE_UP = 2.6 // a top this far above the feet can be climbed
const EYE = 1.55

interface Roof { ring: [number, number][]; bounds: [number, number, number, number]; top: number; base: number }
interface Goblin { mesh: THREE.Group; pos: THREE.Vector3; yaw: number; down: number; wander: number; hp: number }
interface Arrow { mesh: THREE.Mesh; pos: THREE.Vector3; vel: THREE.Vector3; life: number }

function inside(ring: [number, number][], x: number, z: number): boolean {
  let hit = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit
  }
  return hit
}

export class Parkour {
  readonly group = new THREE.Group()
  readonly hud: HTMLElement
  readonly player = new THREE.Group()
  pos = new THREE.Vector3()
  vel = new THREE.Vector3()
  yaw = 0
  score = 0
  private site: Site
  private camera: THREE.PerspectiveCamera
  private orbit: { target: THREE.Vector3; enabled: boolean; update: () => void; minDistance: number; maxDistance: number }
  private keys = new Set<string>()
  private grounded = true
  private onRoof: Roof | null = null
  private air = 0
  private spun = 0
  private lastSpace = -1
  private t = 0
  private roofs: BoundsIndex<Roof>
  private goblins: Goblin[] = []
  private arrows: Arrow[] = []
  private aiming = false
  private hurtAt = -9
  private scoreEl: HTMLElement
  private trickEl: HTMLElement
  private statusEl: HTMLElement
  private bow: THREE.Group
  private onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'SELECT' || (e.target as HTMLElement).tagName === 'INPUT') return
    this.keys.add(e.code)
    if (e.code === 'Space') { this.lastSpace = this.t; e.preventDefault() }
    if (e.code === 'KeyF') this.setAim(true)
    if (e.code === 'Escape') this.setAim(false)
  }
  private onKeyUp = (e: KeyboardEvent) => { this.keys.delete(e.code); if (e.code === 'KeyF') this.setAim(false) }
  private onClick = () => { if (this.aiming) this.loose() }

  constructor(site: Site, camera: THREE.PerspectiveCamera, orbit: Parkour['orbit'], canvas: HTMLElement, parent: HTMLElement) {
    this.site = site
    this.camera = camera
    this.orbit = orbit
    this.group.name = 'game:parkour'

    // the obstacles: every building as a solid with a roof at its measured height
    const items: Roof[] = []
    for (const b of (site.manifest.buildings ?? []) as { ring?: [number, number][]; height_m?: number }[]) {
      const ring = (b.ring ?? []).map(([x, y]) => [x, -y] as [number, number])
      if (ring.length < 3) continue
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, base = Infinity
      for (const [x, z] of ring) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; const g = site.groundAt(x, z); if (g !== null && g < base) base = g }
      if (!Number.isFinite(base)) continue
      base -= 0.3
      const h = Math.max(2.4, b.height_m ?? 6)
      // the walkable top is the eaves of a gabled house (buildings.ts puts the eaves at 70 % of
      // the height on anything house-sized) and the flat roof of anything else
      const gable = ring.length >= 3 && h < 12
      items.push({ ring, bounds: [x0, z0, x1, z1], top: base + (gable ? h * 0.7 : h), base })
    }
    this.roofs = new BoundsIndex(items, 100, 1)

    // the runner: a capsule, a head, and a bow that only shows when drawn
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.9, 4, 12), new THREE.MeshStandardMaterial({ color: 0x3f7fe8, roughness: 0.6 }))
    body.position.y = 0.77
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 12), new THREE.MeshStandardMaterial({ color: 0xffd6b0, roughness: 0.7 }))
    head.position.y = 1.55
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 6), new THREE.MeshBasicMaterial({ color: 0xe8a080 }))
    nose.rotation.x = -Math.PI / 2
    nose.position.set(0, 1.5, -0.28)
    this.bow = new THREE.Group()
    const limb = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.03, 6, 20, Math.PI), new THREE.MeshStandardMaterial({ color: 0x8a5a2a, roughness: 0.8 }))
    limb.rotation.z = Math.PI / 2
    limb.rotation.y = Math.PI / 2
    const string = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 1.1, 4), new THREE.MeshBasicMaterial({ color: 0xeeeeee }))
    string.position.z = 0.02
    this.bow.add(limb, string)
    this.bow.position.set(-0.35, 1.1, -0.35)
    this.bow.visible = false
    this.player.add(body, head, nose, this.bow)
    this.group.add(this.player)

    // start on the road at the photo station, facing along it
    const p = site.spineAt(site.manifest.spine.photo_s)
    this.pos.set(p.pos.x, p.pos.y, p.pos.z)
    this.yaw = Math.atan2(p.dir.x, p.dir.z)
    this.player.position.copy(this.pos)
    this.spawnGoblins(6)

    this.hud = el('div', 'parkour-hud')
    this.hud.id = 'parkour'
    const title = el('div', 'parkour-title')
    title.append(icon('bolt', 16), el('span', '', 'Parkour'))
    this.scoreEl = el('div', 'parkour-score', '0')
    this.trickEl = el('div', 'parkour-trick', 'Run. Space jumps. A/D in the air spins. Space again before you land to roll it out.')
    this.statusEl = el('div', 'parkour-status', '')
    this.hud.append(title, this.scoreEl, this.trickEl, this.statusEl)
    parent.append(this.hud)
    site.group.add(this.group)

    addEventListener('keydown', this.onKeyDown)
    addEventListener('keyup', this.onKeyUp)
    canvas.addEventListener('click', this.onClick)
    orbit.enabled = true
    orbit.minDistance = 2.5
    orbit.maxDistance = 14
    this.orbit.target.copy(this.pos).add(new THREE.Vector3(0, EYE, 0))
    this.camera.position.copy(this.orbit.target).add(new THREE.Vector3(-Math.sin(this.yaw) * 6, 2.5, -Math.cos(this.yaw) * 6))
    orbit.update()
  }

  /** the highest surface under x,z that the feet could stand on: a roof if inside one, else the ground */
  private standAt(x: number, z: number, feetY: number): { y: number; roof: Roof | null } {
    const g = this.site.groundAt(x, z) ?? 0
    const roof = this.roofs.firstAt(x, z, (r) => (inside(r.ring, x, z) && feetY >= r.top - 0.6 ? r : null))
    return roof ? { y: Math.max(g, roof.top), roof } : { y: g, roof: null }
  }

  /** a building the feet are inside of and below the roof of: push out, or mantle if the top is close */
  private collide(next: THREE.Vector3, feetY: number, dt: number): boolean {
    const r = this.roofs.firstAt(next.x, next.z, (r) => (inside(r.ring, next.x, next.z) && feetY < r.top - 0.4 ? r : null))
    if (!r) return false
    if (r.top - feetY <= MANTLE_UP && this.keys.has('Space')) {
      // mantle: over the edge and onto the top
      this.pos.y = r.top
      this.vel.set(0, 0, 0)
      this.grounded = true
      this.onRoof = r
      this.trick('mantled onto a roof', 50)
      return true
    }
    // slide along the wall: keep the old x/z, cancel the velocity into it
    next.x = this.pos.x
    next.z = this.pos.z
    this.vel.x *= Math.exp(-20 * dt)
    this.vel.z *= Math.exp(-20 * dt)
    return true
  }

  private trick(what: string, points: number) {
    this.score += points
    this.scoreEl.textContent = String(this.score)
    this.trickEl.textContent = `${what}  +${points}`
  }

  private setAim(on: boolean) {
    if (this.aiming === on) return
    this.aiming = on
    this.bow.visible = on
    this.statusEl.textContent = on ? 'drawn — click to loose' : ''
  }

  private loose() {
    const dir = this.camera.getWorldDirection(new THREE.Vector3())
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.8, 5), new THREE.MeshStandardMaterial({ color: 0xd8c8a0 }))
    const pos = this.pos.clone().add(new THREE.Vector3(0, 1.3, 0)).add(dir.clone().multiplyScalar(0.6))
    this.group.add(mesh)
    this.arrows.push({ mesh, pos, vel: dir.multiplyScalar(42), life: 4 })
  }

  private spawnGoblins(n: number) {
    const len = this.site.manifest.spine.length_m
    for (let i = 0; i < n; i++) {
      const s = Math.min(len - 5, Math.max(5, this.site.manifest.spine.photo_s + (i + 1) * 45 * (i % 2 ? 1 : -1)))
      const p = this.site.spineAt(s)
      const side = p.dir.clone().cross(new THREE.Vector3(0, 1, 0)).multiplyScalar(i % 2 ? 6 : -6)
      const mesh = new THREE.Group()
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.7, 4, 10), new THREE.MeshStandardMaterial({ color: 0x8fbf3f, roughness: 0.7 }))
      body.position.y = 0.65
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 10), new THREE.MeshStandardMaterial({ color: 0x6f9f2f, roughness: 0.7 }))
      head.position.y = 1.3
      const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 5), new THREE.MeshBasicMaterial({ color: 0xff3030 }))
      const eyeR = eyeL.clone()
      eyeL.position.set(-0.1, 1.36, -0.24)
      eyeR.position.set(0.1, 1.36, -0.24)
      mesh.add(body, head, eyeL, eyeR)
      const pos = p.pos.clone().add(side)
      pos.y = this.site.groundAt(pos.x, pos.z) ?? pos.y
      mesh.position.copy(pos)
      this.group.add(mesh)
      this.goblins.push({ mesh, pos, yaw: Math.random() * Math.PI * 2, down: 0, wander: 0, hp: 1 })
    }
  }

  tick(dt: number) {
    this.t += dt
    const k = this.keys
    // the camera's heading is the runner's frame
    const fwd = this.camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize()
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x)
    const mf = Number(k.has('KeyW') || k.has('ArrowUp')) - Number(k.has('KeyS') || k.has('ArrowDown'))
    const ms = Number(k.has('KeyD') || k.has('ArrowRight')) - Number(k.has('KeyA') || k.has('ArrowLeft'))
    const speed = k.has('ShiftLeft') || k.has('ShiftRight') ? SPRINT : RUN

    if (this.grounded) {
      const want = fwd.clone().multiplyScalar(mf).add(right.clone().multiplyScalar(ms))
      if (want.lengthSq() > 0) {
        want.normalize().multiplyScalar(this.aiming ? speed * 0.5 : speed)
        this.yaw = Math.atan2(want.x, want.z)
      }
      // run: ease to the wanted speed on the ground
      this.vel.x += (want.x - this.vel.x) * (1 - Math.exp(-12 * dt))
      this.vel.z += (want.z - this.vel.z) * (1 - Math.exp(-12 * dt))
      if (k.has('Space') && this.t - this.lastSpace < 0.15) {
        this.vel.y = JUMP
        this.grounded = false
        this.air = 0
        this.spun = 0
        this.lastSpace = -1
      }
    } else {
      // air: a little steering, and spin on A / D
      this.vel.x += (fwd.x * mf) * 8 * dt
      this.vel.z += (fwd.z * mf) * 8 * dt
      const spin = Number(k.has('KeyD') || k.has('ArrowRight')) - Number(k.has('KeyA') || k.has('ArrowLeft'))
      this.yaw += spin * SPIN * dt
      this.spun += Math.abs(spin * SPIN * dt)
      this.air += dt
      this.vel.y -= G * dt
    }

    const next = this.pos.clone().addScaledVector(this.vel, dt)
    const feet = next.y
    this.collide(next, feet, dt)
    // the floor under the new spot: ground or a roof
    const stand = this.standAt(next.x, next.z, feet)
    if (this.grounded) {
      // walked off an edge? fall
      if (stand.y < this.pos.y - 0.6) { this.grounded = false; this.air = 0; this.spun = 0; this.vel.y = 0 } else next.y = stand.y
    } else if (this.vel.y <= 0 && next.y <= stand.y) {
      // landing
      next.y = stand.y
      this.vel.y = 0
      this.grounded = true
      const clean = this.t - this.lastSpace < 0.3
      const turns = Math.floor(this.spun / (Math.PI * 2) + 0.15)
      const half = this.spun >= Math.PI * 0.85 && turns === 0
      let pts = Math.round(this.air * 10)
      let what = 'landed'
      if (turns >= 1) { pts += 100 * turns; what = turns === 1 ? 'pirouette' : `${turns}x spin` }
      else if (half) { pts += 40; what = 'half turn' }
      if (stand.roof && !this.onRoof) { pts += 150; what += ' onto a roof' }
      if (this.air > 0.9) { pts += 50; what += ', big air' }
      if (clean) { pts = Math.round(pts * 1.5); what += ' — rolled clean' } else if (this.air > 0.6 || turns) { what += ' — stumbled'; this.vel.x *= 0.2; this.vel.z *= 0.2 }
      if (pts > 0) this.trick(what, pts)
      this.onRoof = stand.roof
    }
    this.pos.copy(next)
    if (this.grounded) this.onRoof = stand.roof
    this.player.position.copy(this.pos)
    this.player.rotation.y = this.yaw

    // the camera: orbit around the runner's head; drawn bow pulls it to the shoulder, a goblin
    // within arm's reach makes it first person
    const near = this.goblins.some((g) => g.down <= 0 && g.pos.distanceTo(this.pos) < 4)
    this.orbit.target.copy(this.pos).add(new THREE.Vector3(0, EYE, 0))
    const want = near ? 0.6 : this.aiming ? 2.6 : 7
    const off = this.camera.position.clone().sub(this.orbit.target)
    const d = off.length() || 1
    off.multiplyScalar(1 + (want / d - 1) * (1 - Math.exp(-6 * dt)))
    this.camera.position.copy(this.orbit.target).add(off)
    this.orbit.update()
    this.player.visible = !near

    // arrows
    for (const a of [...this.arrows]) {
      a.vel.y -= 9.8 * dt
      a.pos.addScaledVector(a.vel, dt)
      a.mesh.position.copy(a.pos)
      a.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), a.vel.clone().normalize())
      a.life -= dt
      const g = this.site.groundAt(a.pos.x, a.pos.z)
      let gone = a.life <= 0 || (g !== null && a.pos.y < g)
      for (const gb of this.goblins) {
        if (gb.down > 0) continue
        if (a.pos.distanceTo(gb.pos.clone().add(new THREE.Vector3(0, 0.8, 0))) < 0.75) {
          gb.hp -= 1
          gone = true
          if (gb.hp <= 0) { gb.down = 20; gb.mesh.rotation.z = Math.PI / 2; gb.mesh.position.y = gb.pos.y + 0.3; this.trick('goblin down', 120) }
        }
      }
      if (gone) { this.group.remove(a.mesh); this.arrows.splice(this.arrows.indexOf(a), 1) }
    }

    // goblins: wander the verge, chase when close, knock you back on contact
    for (const gb of this.goblins) {
      if (gb.down > 0) { gb.down -= dt; if (gb.down <= 0) { gb.mesh.rotation.z = 0; gb.hp = 1 } continue }
      const toP = this.pos.clone().sub(gb.pos).setY(0)
      const dist = toP.length()
      let step: THREE.Vector3
      if (dist < 25) { step = toP.normalize().multiplyScalar(4.2 * dt); gb.yaw = Math.atan2(step.x, step.z) }
      else {
        gb.wander -= dt
        if (gb.wander <= 0) { gb.yaw += (Math.random() - 0.5) * 2; gb.wander = 1 + Math.random() * 2 }
        step = new THREE.Vector3(Math.sin(gb.yaw), 0, Math.cos(gb.yaw)).multiplyScalar(1.6 * dt)
      }
      const nx = gb.pos.x + step.x, nz = gb.pos.z + step.z
      // stay off the pavement's far side and out of the houses
      if (!this.roofs.firstAt(nx, nz, (r) => (inside(r.ring, nx, nz) ? true : null)) && Math.abs(this.site.edgeDistance(nx, nz)) < 40) {
        gb.pos.x = nx
        gb.pos.z = nz
      } else gb.yaw += Math.PI / 2
      gb.pos.y = this.site.groundAt(gb.pos.x, gb.pos.z) ?? gb.pos.y
      gb.mesh.position.copy(gb.pos)
      gb.mesh.rotation.y = gb.yaw
      if (dist < 1.1 && this.t - this.hurtAt > 1.5) {
        this.hurtAt = this.t
        this.vel.add(toP.normalize().multiplyScalar(6)).y = 3
        this.grounded = false
        this.score = Math.max(0, this.score - 50)
        this.scoreEl.textContent = String(this.score)
        this.trickEl.textContent = 'ouch! a goblin got you  −50'
        toast('a goblin got you — draw the bow with F', 'warn', 1500)
      }
    }
  }

  dispose() {
    removeEventListener('keydown', this.onKeyDown)
    removeEventListener('keyup', this.onKeyUp)
    this.site.group.remove(this.group)
    this.group.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose() })
    this.hud.remove()
    this.orbit.minDistance = 0
    this.orbit.maxDistance = Infinity
  }
}
