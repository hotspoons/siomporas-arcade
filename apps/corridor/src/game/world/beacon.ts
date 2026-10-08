// The avatar beacon: finding your car — later, you on foot — after you have flown away from it.
//
// Rich, 2026-10-07: *"from the free-fly mode, we need to have a notable 3d arrow pointing down to
// where the hero car's embodiment (later personal avatar on foot) ... and when that isn't on screen
// we need an arrow that follows the edge of the screen pointing in the direction where we can find
// it until it is on screen, similar to the 2d map and level goals."*
//
// ONE TARGET, TWO INDICATORS. While the target is in frame, an arrow of the `home` amber
// (markers.ts) hovers over it and points down at it, growing with distance so it stays legible
// from a high pass. The moment it leaves the frame the world arrow is traded for a tick pinned to
// the edge of the screen, turned to face the way the target went and carrying the distance — the
// minimap's rim tick (`minimap.ts`, `edgeArrow`) lifted out of the map and onto the whole view.
//
// It is deliberately not tied to a car: `update` is handed a world position, so the day the hero
// is a person on foot the same beacon points at them.
import * as THREE from 'three'

/** the `home` point's amber (markers.ts): this is the thing you came from */
const COLOUR = 0xffd54f
/** how high the arrow's tip rides above the target, metres, before the distance scale */
const HOVER_M = 6
/** the arrow's vertical bob, metres, before the distance scale */
const BOB_M = 0.4
/** the distance scale is clamped to this, so it cannot become a billboard or a speck */
const SCALE_MIN = 1
const SCALE_MAX = 6
/** the tick canvas, in device-independent pixels, and how far it is held off the screen edge */
const TICK_PX = 96
const EDGE_MARGIN = 64

export class AvatarBeacon {
  /** the world arrow; add it to the scene once */
  readonly object = new THREE.Group()
  /** the arrow itself, tip at its local origin so it can be scaled from the tip */
  private readonly arrow = new THREE.Group()
  private readonly beam: THREE.Mesh
  private readonly root = document.createElement('div')
  private readonly tick = document.createElement('canvas')
  private readonly dist = document.createElement('div')
  private phase = 0
  private readonly view = new THREE.Vector3()
  private readonly ndc = new THREE.Vector3()

  constructor() {
    this.object.name = 'avatar-beacon'
    this.object.visible = false
    // UNLIT AND THROUGH THE WORLD: this is furniture, not a surface — it has to read at midnight
    // on a black road and be visible from behind a ridge, so it ignores light, fog and depth.
    const mat = new THREE.MeshBasicMaterial({
      color: COLOUR, depthTest: false, toneMapped: false, fog: false, transparent: true, opacity: 0.97,
    })
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.95, 1.9, 4), mat)
    head.rotation.x = Math.PI // apex down: the tip is the point you read as "there"
    head.position.y = 0.95
    head.renderOrder = 22
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 2.4, 8), mat)
    shaft.position.y = 3.1
    shaft.renderOrder = 22
    // never frustum-culled on its own: when the car sits at the very top of the frame the arrow is
    // half out of it, and a culled child is an arrow that vanishes while the thing it marks is
    // still on screen
    head.frustumCulled = shaft.frustumCulled = false
    this.arrow.add(head, shaft)
    // a faint cord from the target up to the tip, so the arrow visibly points AT something
    this.beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, 1, 6),
      new THREE.MeshBasicMaterial({ color: COLOUR, depthTest: false, toneMapped: false, fog: false, transparent: true, opacity: 0.35 }),
    )
    this.beam.renderOrder = 21
    this.beam.frustumCulled = false
    this.object.add(this.arrow, this.beam)

    this.root.className = 'avatar-beacon'
    this.root.hidden = true
    this.tick.width = TICK_PX
    this.tick.height = TICK_PX
    this.tick.className = 'avatar-beacon-tick'
    this.dist.className = 'avatar-beacon-dist'
    this.root.append(this.tick, this.dist)
    document.body.append(this.root)
  }

  /**
   * Every frame: where the target is in three's world, and the camera it is judged against. A null
   * target hides both indicators. `dt` only drives the bob.
   */
  update(camera: THREE.PerspectiveCamera, target: THREE.Vector3 | null, dt: number): void {
    this.phase += dt
    if (!target) {
      this.object.visible = false
      this.root.hidden = true
      return
    }
    camera.updateMatrixWorld()
    const view = this.view.copy(target).applyMatrix4(camera.matrixWorldInverse)
    const ndc = this.ndc.copy(target).project(camera)
    // `view.z > 0` is behind the eye; the NDC of a point behind the camera is mirrored, so it cannot
    // be trusted for the on-screen test — hence the two of them.
    const onScreen = view.z <= 0 && Math.abs(ndc.x) < 0.94 && Math.abs(ndc.y) < 0.94
    if (onScreen) {
      this.root.hidden = true
      this.object.visible = true
      const dist = camera.position.distanceTo(target)
      const s = Math.min(SCALE_MAX, Math.max(SCALE_MIN, dist / 80))
      const tip = target.y + HOVER_M * s + Math.sin(this.phase * 2.1) * BOB_M * s
      this.arrow.position.set(target.x, tip, target.z)
      this.arrow.scale.setScalar(s)
      this.beam.position.set(target.x, (target.y + tip) / 2, target.z)
      this.beam.scale.set(1, Math.max(0.01, tip - target.y), 1)
      return
    }
    this.object.visible = false
    this.root.hidden = false
    /*
     * WHICH WAY TO TURN. In camera space x is right and y is up; screen y is down, so the screen
     * direction is (view.x, -view.y) — and that reads correctly whether the target is beside the
     * eye or behind it, where the projected NDC would point the wrong way. Dead ahead or dead
     * behind leaves no direction at all, and the arrow points down.
     */
    let dx = view.x
    let dy = -view.y
    const len = Math.hypot(dx, dy)
    if (len < 1e-4) {
      dx = 0
      dy = 1
    } else {
      dx /= len
      dy /= len
    }
    const W = window.innerWidth
    const H = window.innerHeight
    const halfW = Math.max(1, W / 2 - EDGE_MARGIN)
    const halfH = Math.max(1, H / 2 - EDGE_MARGIN)
    // where the ray from the middle leaves the inset rectangle: the tick's seat on the rim
    const t = Math.min(halfW / Math.max(1e-4, Math.abs(dx)), halfH / Math.max(1e-4, Math.abs(dy)))
    const ex = W / 2 + dx * t
    const ey = H / 2 + dy * t
    this.tick.style.left = `${ex}px`
    this.tick.style.top = `${ey}px`
    // the tick is drawn pointing up; turn it to the direction that brings the target back
    this.tick.style.transform = `translate(-50%, -50%) rotate(${Math.atan2(dx, -dy)}rad)`
    this.dist.style.left = `${ex - dx * 58}px`
    this.dist.style.top = `${ey - dy * 58}px`
    this.dist.style.transform = 'translate(-50%, -50%)'
    const d = camera.position.distanceTo(target)
    this.dist.textContent = d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d)} m`
    this.drawTick()
  }

  /** the rim tick: a chevron with a dark near face, the same language as the waypoint arrow */
  private drawTick(): void {
    const ctx = this.tick.getContext('2d')
    if (!ctx) return
    const W = this.tick.width
    const H = this.tick.height
    ctx.clearRect(0, 0, W, H)
    const tipY = 10
    const baseY = H - 16
    ctx.beginPath()
    ctx.moveTo(W / 2, tipY)
    ctx.lineTo(W - 16, baseY)
    ctx.lineTo(W / 2, baseY - 20)
    ctx.lineTo(16, baseY)
    ctx.closePath()
    ctx.fillStyle = 'rgba(120, 80, 0, 0.85)'
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)'
    ctx.lineWidth = 2
    ctx.fill()
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(W / 2, tipY + 6)
    ctx.lineTo(W - 22, baseY - 8)
    ctx.lineTo(W / 2, baseY - 26)
    ctx.lineTo(22, baseY - 8)
    ctx.closePath()
    ctx.fillStyle = '#ffd54f'
    ctx.fill()
  }
}
