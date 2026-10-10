// The editor's camera: trailworks' map navigation, ported whole.
//
// Rich, 2026-10-10: *"The place editor does not scale up to something like the DC area for map
// navigation … it is really hard to move the camera and to navigate. The best thing to do would be
// to adopt the full navigation experience from trailworks, including point-based zooms and pivots,
// the whole thing. That is very natural to navigate, would work well here."*
//
// The source is ext/trailworks/viewer/src/render — GlobeControls.tsx (the live controls), and the
// flat engine it was "ported verbatim from": PivotOrbit and the OrbitControls setup in Scene.tsx,
// OrbitKeyPan.tsx, TouchExtras.tsx, CameraRig.tsx (FlyTo, PoseKeeper, CameraProbe), TerrainPicker.tsx
// and globe2/terrainPick.ts, cameraMotion.ts, useKeys.ts. React and the globe are left behind; the
// behaviour and the maths are not. What trailworks does, item by item, and where each lives here:
//
// POINTER (mouse grammar: "left grabs the world, middle orbits around the clicked point, right drag
// zooms; wheel zooms toward what's under the cursor")
//  1. LEFT-drag grabs the world: the ground point under the press stays under the cursor (`pan`,
//     navmath `panToKeep`). Where the cursor ray no longer meets the grab plane — dragged above the
//     horizon — it falls back to trailworks' gain, ground metres per pixel at the look distance
//     along the screen axes projected onto the ground (`panByPixels`).
//  2. Release of a left-drag COASTS: the flick is folded into a velocity (0.4·v + 0.6·step/dt) and
//     decays at e^-(11 − 9.3·camSmooth)·t (`panVel`, `tick`).
//  3. MIDDLE-drag ORBITS rigidly about the terrain point under the press: azimuth about the
//     vertical through it, elevation about camera-right projected horizontal, the pivot holding its
//     pixel (`orbitAbout`). az = −dx/w·1.6π, elv = −dy/h·0.9π, as trailworks.
//  4. SHIFT+LEFT-drag is the "helicopter" — trailworks' `heliBy` is the same rigid rotation as
//     `orbitBy`, kept as its own name so a trackpad has an orbit (no middle button there).
//  5. RIGHT-drag ZOOMS about the press point: logF = dy·0.004, drag up closes in (`zoomAbout`).
//  6. WHEEL zooms toward the point under the cursor: step = clamp(deltaY·0.0016, ±0.5), a velocity
//     impulse integrated by the frame loop so notches ease in and out; the pivot is locked while
//     the cursor sits still and re-targeted when it moves more than 3 px ("so you can steer the
//     zoom by moving the mouse"); a pure zoom never changes orientation.
//  7. Every gesture coasts after release with its own glide (glideOrbit 0.5, glideZoom 0.4; decay
//     τ = 0.15 + glide·1.1 s), stopping under 0.002 rad/s and 0.005 /s; velocities fold
//     0.7·v + 0.3·step/dt with dt floored at 8 ms, capped at 4 rad/s and 3 /s.
//  8. ANY new press, wheel or movement key stops in-flight glide dead ("fresh input mixed with
//     leftover coast reads as the camera fighting you"), and a wheel zeroes the orbit glide.
//  9. Elevation steps that would pass overhead (< 0.05 rad) or the 82° pitch ceiling are REJECTED,
//     not clamped, and zero the elevation glide (the "fishtail" clamp).
// 10. The context menu is suppressed on the canvas so right-drag can zoom.
//
// PICKING
// 11. Pivots come from the cursor ray marched against the height field and bisected (trailworks
//     `marchRay`/`pickTerrain`: "the ONE shared primitive behind pin drops, pin drag, pivot orbit,
//     and zoom-to-cursor") — never a mesh raycast, which on a 40 km terrain mesh is a frame each.
// 12. A hit farther from the look-at point than 3·distance + 500 m is not trusted; the plane
//     through the look-at point stands in (TouchExtras `pivotAt`, the horizon clamp in
//     GlobeControls). No ground at all under a press: the gesture is ignored.
//
// KEYS (OrbitKeyPan + GlobeControls' keyboard; the letters are the ones Rich gave the editor)
// 13. W/A/S/D and the arrows slide the rig along the view heading, speed ∝ the look distance
//     (0.55·d per second, shift ×2.6). Trailworks floors d at 150 m because its camera never comes
//     closer than 300 m; this one comes to 2 m above a road, so the floor is 8 m (≈4 m/s, the old
//     fly camera's floor).
// 14. While the keys slide it, the look-at point's height eases toward the ground under it
//     (k = 1 − e^−2.5t) and the eye rides with it — OrbitKeyPan, so the next orbit pivots on land.
// 15. Q/E turn the view about the EYE (OrbitKeyPan's flight-scheme look: 1.2 rad/s, shift 2.1),
//     R/F raise and lower the eye (its lift: 0.6·max(d, 8) per second, shift ×1.4 more).
// 16. +/− zoom about the screen centre exactly like a wheel notch — trailworks' rail buttons
//     (`globeZoomBy`), also on the on-screen rail below.
// 17. Home (and the compass) eases heading → north and pitch → straight down
//     (`__globeResetNorth`, k = 1 − e^−6t). N belongs to "draw" in this editor.
// 18. Held keys, not key repeat; key state clears when the window loses focus (useKeys).
//
// TOUCH (TouchExtras, maps scheme, and GlobeControls' touch)
// 19. One finger grabs the world, as the left button does, and coasts.
// 20. Two fingers: pinch zooms, twist rotates, both about the FIXED POINT of the two-finger
//     similarity transform ("a stationary finger with a rotating friend pivots on the finger");
//     a parallel vertical drag tilts. Each component unlocks on its own cumulative intent (twist
//     0.045 rad, pinch 0.04 log, tilt 14 px) and then they blend. A drift correction re-projects the
//     pivot back under the fixed point against its own plane, twice ("never re-raycast terrain
//     mid-gesture — that's what wandered to the horizon") — which is also what makes a two-finger
//     slide a pan. Twist coasts after release.
// 21. Double-tap zooms in ×0.55 toward the tap; a two-finger double-tap zooms out ×1.8.
// 22. Long-press (550 ms, 18 px slop) is the touch twin of a double-click: trailworks drops a pin,
//     and this editor's pin is the double-click that places (the host's `onLongPress`).
//
// THE CAMERA
// 23. Distance limits 2 m … 150 km (trailworks' ORBIT_MAX_M); a zoom that would leave them is
//     refused, not clamped half-way.
// 24. The eye is kept 1.5 m above the ground: it recedes along its own line by the shortfall over
//     cos(pitch), so the view does not turn (the "ground-collision clamp").
// 25. The tilt envelope eases pitch under `maxPitchFor(distance)` — 82° at every range this
//     editor reaches; kept so the ceiling is trailworks' number.
// 26. The camera's up vector is continuous in pitch (up = Y·sin p + heading·cos p), so the overhead
//     view is north-up and no branch ever snaps the roll; near/far track the distance.
// 27. A gesture's end re-anchors the look-at point on the ground straight ahead, so the next orbit
//     turns about what you are looking at (`endGesture`). Trailworks then eases a re-fit of its
//     quaternion rig over 150 ms; on a flat frame the rig IS (eye, target) and the re-fit is exact,
//     so there is nothing to ease.
// 28. The pivot ring: a cyan annulus and dot flat on the ground at the control point, ~32 px
//     across at any zoom, drawn over everything, shown during a gesture and for 900 ms after.
// 29. Fly-to eases eye and look-at together (k = 1 − e^−4t) and is cancelled by any input
//     (CameraRig `FlyTo`) — the editor's `C`, `T` and the panels' "fly to" use it.
// 30. `moving` is true while the pose changes, with a 150 ms tail (cameraMoving.ts) — the label
//     layer re-lays out only then.
// 31. The pose persists per world and comes back on reload (PoseKeeper), saved once a second when
//     it changed.
// 32. A pose-discontinuity guard and flight recorder: a NaN eye or look-at point restores the last
//     good pose (flagged), and the last 2048 frames are kept for `dumpRec()` (the "⬆ ctl log").
//     Trailworks' input-gated quaternion-step filter guards a globe re-fit this frame does not have.
//
// Not ported: FollowMe (GPS — the editor has no position to follow), the globe hand-off past the
// distance ceiling (there is no globe), XR table controls, TapTolerance (Line2 pick slop for
// trailworks' trail overlays).
//
// YIELDING TO THE EDITOR. Every tool in this editor decides in its own `pointerdown` whether a press
// is a grab — a vertex handle, a gizmo, a stunt piece — and says so by setting `enabled` false,
// exactly as it did to OrbitControls. A press here therefore does not start a gesture at once: it
// waits for the first move, by which time every other listener has had its say, and reads
// `enabled` then (and again on every move). `enableRotate`/`enablePan`/`enableZoom` keep their
// OrbitControls meaning — the draw lock holds rotate and pan and leaves zoom — and a wheel that a
// tool already took (`defaultPrevented`: shift+wheel rotating a placement) is left alone.
import * as THREE from 'three'
import {
  clamp, clampAboveGround, easeK, fold, glide, headingDegOf, marchRay, maxPitchFor, metresPerPixel,
  orbitAbout, panByPixels, panToKeep, pitchDegOf, pivotFrom, rayPlane, setHeadingPitch,
  twoFingerFixedPoint, UP, yawAboutEye, zoomAbout, type TwoFinger,
} from './navmath'

const DEG = Math.PI / 180
const LONG_PRESS_MS = 550
const TAP_SLOP_PX = 18
const TAP_MAX_MS = 350
const DOUBLE_TAP_MS = 350
const RING_LINGER_MS = 900
const REC_N = 2048
const REC_F = 9

export interface MapNavHost {
  camera: THREE.PerspectiveCamera
  canvas: HTMLCanvasElement
  /** ground height at WORLD (x, z) — null off the ground. Read per call: the site changes. */
  heightAt: (x: number, z: number) => number | null
  /** false while the editor is hidden, the preview owns the screen, or a text field has the keys */
  active: () => boolean
  /** the touch long-press, at client coordinates */
  onLongPress?: (clientX: number, clientY: number) => void
}

type GestureMode = 'pan' | 'orbit' | 'heli' | 'zoom' | 'touch'

export class MapNav {
  /** the look-at point; the same object for the whole life of the editor, so a probe may hold it */
  readonly target = new THREE.Vector3()
  /** OrbitControls' grab lock: a tool that takes a press sets this false until the release */
  enabled = true
  /** OrbitControls' draw lock: while dropping pins the world holds still, zoom stays */
  enableRotate = true
  enablePan = true
  enableZoom = true
  /** trailworks' knobs: 0 = stop dead … 1 = long coast */
  glideOrbit = 0.5
  glideZoom = 0.4
  camSmooth = 1
  showPivot = true
  minDistance = 2
  maxDistance = 150_000
  /** metres the eye keeps above the ground */
  clearance = 1.5
  /** the ring marking the control point; the host adds it to the scene */
  readonly ring = new THREE.Group()

  private host: MapNavHost
  private cam: THREE.PerspectiveCamera
  private el: HTMLCanvasElement
  /** the compass heading kept for the straight-down view, where the offset has no direction */
  private heading = 0
  private gest = {
    mode: null as GestureMode | null,
    coasting: false,
    pivot: new THREE.Vector3(),
    vAz: 0,
    vEl: 0,
    vZoom: 0,
    ringHold: 0,
    px: 0,
    py: 0,
  }
  /** the left-drag / one-finger grab: the ground point held under the cursor */
  private grab: THREE.Vector3 | null = null
  private panVel = new THREE.Vector2()
  private press: { button: number; shift: boolean; x: number; y: number; id: number } | null = null
  private last = { x: 0, y: 0, t: 0 }
  private keys = new Set<string>()
  private fly: { target: THREE.Vector3; eye: THREE.Vector3 } | null = null
  private north = false
  private touch = {
    mode: null as 'one' | 'two' | null,
    gg: null as TwoFinger | null,
    acc: { rot: 0, logS: 0, tilt: 0, uRot: false, uZoom: false, uTilt: false },
    start: new Map<number, [number, number]>(),
    sessionStart: 0,
    maxTouches: 0,
    moved: false,
    lastTapAt: 0,
    lastTapTouches: 0,
    timer: null as ReturnType<typeof setTimeout> | null,
    lx: 0,
    ly: 0,
    lt: 0,
  }
  private prev = { ok: false, eye: new THREE.Vector3(), target: new THREE.Vector3() }
  private rec = { i: 0, n: 0, anomalies: 0, buf: new Float64Array(REC_N * REC_F) }
  private motion = { key: '', until: 0 }
  private poseSlug: string | null = null
  private poseSavedAt = 0
  private poseKey = ''
  private ray = new THREE.Raycaster()
  private ndc = new THREE.Vector2()
  private off: (() => void)[] = []
  /** counters, so "the camera moved because of X" is a number a probe can read */
  readonly stats = { gestures: 0, wheel: 0, coastFrames: 0, keyFrames: 0, flights: 0, clamps: 0, restored: 0 }

  constructor(host: MapNavHost) {
    this.host = host
    this.cam = host.camera
    this.el = host.canvas
    this.buildRing()
    this.listen()
  }

  // -------------------------------------------------------------------------------------------
  // what the host and the probes call

  /** true while the pose is changing, and for 150 ms after (trailworks cameraMoving) */
  get moving(): boolean {
    return performance.now() < this.motion.until
  }

  /** what is driving the camera right now, for probes and the recorder */
  get state(): string {
    return this.gest.mode ?? (this.gest.coasting ? 'coast' : this.fly ? 'fly' : this.panVel.lengthSq() > 0 ? 'glide' : this.keys.size ? 'keys' : 'idle')
  }

  /** look distance, metres */
  get distance(): number {
    return this.cam.position.distanceTo(this.target)
  }

  /** ground metres per CSS pixel at the look-at point */
  get metresPerPixel(): number {
    return metresPerPixel(this.distance, this.cam.fov, this.el.clientHeight || 800)
  }

  /** OrbitControls' `update()`: re-derive the camera from the eye and the look-at point, now. */
  update(): void {
    this.apply()
  }

  /** Put the camera there at once (a load, a probe). Cancels everything in flight. */
  jumpTo(target: THREE.Vector3, eye: THREE.Vector3): void {
    this.stopAll()
    this.target.copy(target)
    this.cam.position.copy(eye)
    this.apply()
  }

  /** Ease there (CameraRig `FlyTo`); any input cancels the flight. */
  flyTo(target: THREE.Vector3, eye: THREE.Vector3): void {
    this.stopAll()
    this.fly = { target: target.clone(), eye: eye.clone() }
    this.stats.flights++
  }

  /** Zoom about the screen centre exactly like a wheel notch (trailworks' rail buttons). */
  zoomBy(logF: number): void {
    const r = this.el.getBoundingClientRect()
    this.wheelZoom(r.left + r.width / 2, r.top + r.height / 2, logF)
  }

  /** Ease to north-up, straight down (trailworks' N / Home and the compass). */
  northUp(): void {
    this.stopAll()
    this.north = true
  }

  /** compass heading of the view, degrees clockwise from north */
  get headingDeg(): number {
    return headingDegOf(this.cam.position, this.target, this.heading)
  }

  get pitchDeg(): number {
    return pitchDegOf(this.cam.position, this.target)
  }

  /** The ground under a screen point, or null — the same pick every gesture uses. */
  pickAt(clientX: number, clientY: number): THREE.Vector3 | null {
    const r = this.rayAt(clientX, clientY)
    if (!r) return null
    const hit = marchRay(r.origin, r.direction, this.host.heightAt)
    return pivotFrom(hit, r.origin, r.direction, this.cam.position, this.target)
  }

  /** Take a keydown. True when it was a navigation key and nothing else should see it. */
  keyDown(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return false
    const k = e.code
    if (k === 'Home') {
      this.northUp()
      return true
    }
    if (k === 'Equal' || k === 'NumpadAdd' || k === 'Minus' || k === 'NumpadSubtract') {
      // a notch per press: a held key repeats at the system rate, which is what a held button does
      this.zoomBy(k === 'Equal' || k === 'NumpadAdd' ? -0.35 : 0.35)
      return true
    }
    if (!NAV_KEYS.has(k) && k !== 'ShiftLeft' && k !== 'ShiftRight') return false
    if (!NAV_KEYS.has(k)) {
      this.keys.add(k)
      return false // shift is everybody's modifier: note it, do not swallow it
    }
    this.keys.add(k)
    // movement keys kill the glide and the flight, as a press does
    this.gest.vAz = this.gest.vEl = 0
    if (this.gest.coasting) this.endGesture()
    this.fly = null
    this.north = false
    return true
  }

  keyUp(e: KeyboardEvent): void {
    this.keys.delete(e.code)
  }

  /** Let go of every key — the window lost focus or a dialog opened over the editor. */
  release(): void {
    this.keys.clear()
  }

  /** Restore this world's last pose; false when there is none (the host frames the site instead). */
  restorePose(slug: string): boolean {
    this.poseSlug = slug
    try {
      const raw = localStorage.getItem(POSE_KEY + slug)
      if (!raw) return false
      const p = JSON.parse(raw) as { t: number[]; e: number[] }
      if (!Array.isArray(p.t) || !Array.isArray(p.e) || ![...p.t, ...p.e].every(Number.isFinite)) return false
      this.jumpTo(new THREE.Vector3().fromArray(p.t), new THREE.Vector3().fromArray(p.e))
      return true
    } catch {
      return false
    }
  }

  /** the last frames, decoded — trailworks' `__ctlRecDump` */
  dumpRec(): { fields: string; anomalies: number; frames: number[][] } {
    const out: number[][] = []
    const r = this.rec
    for (let k = 0; k < r.n; k++) {
      const idx = ((r.i + REC_N - r.n + k) % REC_N) * REC_F
      out.push([...r.buf.slice(idx, idx + REC_F)].map((v, f) => (f === 0 ? Math.round(v) : +v.toFixed(2))))
    }
    return { fields: 'tMs,eyeX,eyeY,eyeZ,tgtX,tgtY,tgtZ,mode,flags', anomalies: r.anomalies, frames: out }
  }

  dispose(): void {
    for (const f of this.off) f()
    this.off = []
  }

  // -------------------------------------------------------------------------------------------
  // the frame

  /** Integrate glides, keys and flights, clamp, and set the camera. Once a frame. */
  tick(dt: number): void {
    dt = Math.min(dt, 0.1)
    const now = performance.now()
    const eye = this.cam.position
    const t = this.target
    let flags = 0

    // ---- the guard: a NaN pose restores the last good one
    if (![eye.x, eye.y, eye.z, t.x, t.y, t.z].every(Number.isFinite)) {
      if (this.prev.ok) {
        eye.copy(this.prev.eye)
        t.copy(this.prev.target)
      }
      this.stopAll()
      flags |= 8
      this.stats.restored++
    }

    if (this.gest.mode) {
      // a held gesture moved the camera in its own event handler; a grab has no pivot to mark
      if (this.gest.mode !== 'pan') this.gest.ringHold = now + RING_LINGER_MS
    } else if (this.gest.coasting) {
      this.stats.coastFrames++
      const g = this.gest
      g.vAz = glide(g.vAz, this.glideOrbit, dt)
      g.vEl = glide(g.vEl, this.glideOrbit, dt)
      g.vZoom = glide(g.vZoom, this.glideZoom, dt)
      if (Math.abs(g.vAz) < 0.002 && Math.abs(g.vEl) < 0.002 && Math.abs(g.vZoom) < 0.005) this.endGesture()
      else {
        if (g.vAz || g.vEl) {
          if (!orbitAbout(eye, t, g.pivot, g.vAz * dt, g.vEl * dt, this.right(), this.polar())) g.vEl = 0
          this.apply()
        }
        if (g.vZoom && !zoomAbout(eye, t, g.pivot, g.vZoom * dt, this.limits())) g.vZoom = 0
        g.ringHold = now + RING_LINGER_MS
      }
    } else if (this.fly) {
      const k = easeK(4, dt)
      t.lerp(this.fly.target, k)
      eye.lerp(this.fly.eye, k)
      const close = Math.max(0.3, this.fly.eye.distanceTo(this.fly.target) * 0.002)
      if (t.distanceTo(this.fly.target) < close && eye.distanceTo(this.fly.eye) < close) {
        t.copy(this.fly.target)
        eye.copy(this.fly.eye)
        this.fly = null
      }
    } else {
      // ---- release inertia of a grab
      if (!this.grab && this.panVel.lengthSq() > 0) {
        eye.x += this.panVel.x * dt
        eye.z += this.panVel.y * dt
        t.x += this.panVel.x * dt
        t.z += this.panVel.y * dt
        this.panVel.multiplyScalar(Math.exp(-(11 - 9.3 * clamp(this.camSmooth, 0, 1)) * dt))
        if (this.panVel.length() < Math.max(0.05, this.distance * 0.002)) this.panVel.set(0, 0)
        this.easeTargetToGround(dt)
      }
      // ---- keys
      if (this.keys.size && this.host.active()) this.keyFrame(dt)
      // ---- north-up
      if (this.north) {
        const h = this.headingDeg
        const p = this.pitchDeg
        const k = easeK(6, dt)
        const dh = wrapDeg(-h)
        if (Math.abs(dh) < 0.1 && p < 0.2) {
          setHeadingPitch(eye, t, 0, 0)
          this.heading = 0
          this.north = false
        } else {
          setHeadingPitch(eye, t, h + dh * k, p * (1 - k))
          this.heading = h + dh * k
        }
      }
    }

    // ---- the tilt envelope
    const cap = maxPitchFor(this.distance)
    const p = this.pitchDeg
    if (p > cap && !this.gest.mode) setHeadingPitch(eye, t, this.headingDeg, p + (cap - p) * easeK(5, dt))

    // ---- the ground
    if (clampAboveGround(eye, t, this.host.heightAt(eye.x, eye.z), this.clearance, this.maxDistance)) {
      this.stats.clamps++
      flags |= 4
    }
    this.apply()
    this.updateRing(now < this.gest.ringHold)

    // ---- motion, the recorder, the pose
    const key = `${eye.x.toFixed(2)},${eye.y.toFixed(2)},${eye.z.toFixed(2)},${t.x.toFixed(2)},${t.z.toFixed(2)}`
    if (key !== this.motion.key) {
      this.motion.key = key
      this.motion.until = now + 150
    }
    this.prev.ok = true
    this.prev.eye.copy(eye)
    this.prev.target.copy(t)
    const r = this.rec
    const o = r.i * REC_F
    const mode = this.gest.mode ? MODE_CODE[this.gest.mode] : this.gest.coasting ? 6 : this.fly ? 7 : this.grab ? 1 : 0
    r.buf.set([now, eye.x, eye.y, eye.z, t.x, t.y, t.z, mode, flags], o)
    if (flags & 8) r.anomalies++
    r.i = (r.i + 1) % REC_N
    if (r.n < REC_N) r.n++
    if (this.poseSlug && now - this.poseSavedAt > 1000) {
      this.poseSavedAt = now
      const pk = key
      if (pk !== this.poseKey) {
        this.poseKey = pk
        try {
          localStorage.setItem(POSE_KEY + this.poseSlug, JSON.stringify({ t: t.toArray().map(round2), e: eye.toArray().map(round2) }))
        } catch {
          /* a private window: the pose simply is not remembered */
        }
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // the camera transform

  private limits() {
    return { min: this.minDistance, max: this.maxDistance }
  }

  private polar() {
    return { min: 0.05, max: Math.min(82, maxPitchFor(this.distance)) * DEG }
  }

  private _right = new THREE.Vector3()
  private _up = new THREE.Vector3()
  private _fwd = new THREE.Vector3()

  private right(): THREE.Vector3 {
    return this._right.setFromMatrixColumn(this.cam.matrixWorld, 0)
  }

  /** lookAt with the continuous up vector, and near/far that follow the distance */
  private apply(): void {
    const eye = this.cam.position
    const t = this.target
    const d = Math.max(1e-6, eye.distanceTo(t))
    const fx = t.x - eye.x, fz = t.z - eye.z
    const horiz = Math.hypot(fx, fz)
    if (horiz > 1e-6 * d) this.heading = Math.atan2(fx, -fz) / DEG
    const h = this.heading * DEG
    const p = Math.acos(clamp((eye.y - t.y) / d, -1, 1))
    this._up.set(Math.sin(h) * Math.cos(p), Math.sin(p), -Math.cos(h) * Math.cos(p))
    this.cam.up.copy(this._up)
    this.cam.lookAt(t)
    const ground = this.host.heightAt(eye.x, eye.z)
    const agl = ground === null ? d : Math.max(0.1, eye.y - ground)
    this.cam.near = clamp(Math.min(d * 0.02, agl * 0.5), 0.05, 50)
    this.cam.far = Math.max(120_000, d * 4 + 60_000)
    this.cam.updateProjectionMatrix()
    this.cam.updateMatrixWorld()
  }

  private rayAt(clientX: number, clientY: number): THREE.Ray | null {
    const r = this.el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return null
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
    this.cam.updateMatrixWorld()
    this.ray.setFromCamera(this.ndc, this.cam)
    return this.ray.ray
  }

  // -------------------------------------------------------------------------------------------
  // gestures

  private startGesture(mode: GestureMode, pivot: THREE.Vector3) {
    this.gest.mode = mode
    this.gest.coasting = false
    this.gest.vAz = this.gest.vEl = this.gest.vZoom = 0
    this.gest.pivot.copy(pivot)
    this.stats.gestures++
  }

  /**
   * The gesture and its glide are over: re-anchor the look-at point on the ground straight ahead,
   * so the next orbit turns about what is in the middle of the screen, not a point in mid-air the
   * rigid rotation carried the target to.
   */
  private endGesture() {
    if (this.gest.mode || this.gest.coasting) {
      const eye = this.cam.position
      this._fwd.setFromMatrixColumn(this.cam.matrixWorld, 2).negate().normalize()
      const hit = marchRay(eye, this._fwd, this.host.heightAt, Math.max(4000, this.distance * 6))
      const plane = hit ?? rayPlane(eye, this._fwd, this.gest.pivot.y)
      if (plane) {
        const d = plane.distanceTo(eye)
        if (d > this.minDistance && d < this.maxDistance) this.target.copy(plane)
      }
    }
    this.gest.mode = null
    this.gest.coasting = false
    this.gest.vAz = this.gest.vEl = this.gest.vZoom = 0
  }

  /** every glide, flight and gesture stops (a new press, a jump) */
  private stopAll() {
    this.endGesture()
    this.panVel.set(0, 0)
    this.grab = null
    this.fly = null
    this.north = false
  }

  /** a wheel notch (or a rail button) about the ground under (clientX, clientY) */
  private wheelZoom(clientX: number, clientY: number, step: number) {
    this.fly = null
    this.north = false
    this.panVel.set(0, 0)
    this.stats.wheel++
    const g = this.gest
    if (g.mode) return // mid-drag: ignore the wheel
    g.vAz = g.vEl = 0 // a wheel stops the orbit glide (PivotOrbit)
    if (!g.coasting) {
      const pivot = this.pickAt(clientX, clientY)
      if (!pivot) {
        // no ground under the cursor: a plain zoom about the look-at point
        zoomAbout(this.cam.position, this.target, this.target, step, this.limits())
        return
      }
      this.startGesture('zoom', pivot)
      g.mode = null
      g.coasting = true
      g.px = clientX
      g.py = clientY
    } else if (Math.hypot(clientX - g.px, clientY - g.py) > 3) {
      const pivot = this.pickAt(clientX, clientY) // the cursor moved: steer the zoom
      if (pivot) {
        g.pivot.copy(pivot)
        g.px = clientX
        g.py = clientY
      }
    }
    if (this.glideZoom <= 0.01) zoomAbout(this.cam.position, this.target, g.pivot, step, this.limits())
    else g.vZoom = clamp(g.vZoom + step / (0.15 + this.glideZoom * 1.1), -3, 3)
    g.ringHold = performance.now() + RING_LINGER_MS
  }

  /** One pointer move of a held mouse gesture. */
  private drag(clientX: number, clientY: number, dx: number, dy: number, dtSec: number) {
    const g = this.gest
    const eye = this.cam.position
    const t = this.target
    const rect = this.el.getBoundingClientRect()
    if (g.mode === 'pan') this.panTo(clientX, clientY, dx, dy, dtSec)
    else if (g.mode === 'zoom') {
      const logF = dy * 0.004 // drag up = zoom in, toward the pivot
      zoomAbout(eye, t, g.pivot, logF, this.limits())
      g.vZoom = fold(g.vZoom, logF, dtSec, 3)
    } else if (g.mode === 'orbit' || g.mode === 'heli') {
      const az = (-dx / Math.max(1, rect.width)) * Math.PI * 1.6
      const elv = (-dy / Math.max(1, rect.height)) * Math.PI * 0.9
      const ok = orbitAbout(eye, t, g.pivot, az, elv, this.right(), this.polar())
      g.vAz = fold(g.vAz, az, dtSec, 4)
      g.vEl = ok ? fold(g.vEl, elv, dtSec, 4) : 0
    }
    this.apply()
  }

  /** Move the rig so the grabbed ground point is back under the cursor. */
  private panTo(clientX: number, clientY: number, dx: number, dy: number, dtSec: number) {
    const eye = this.cam.position
    const t = this.target
    let mv: { dx: number; dz: number } | null = null
    const r = this.grab ? this.rayAt(clientX, clientY) : null
    if (r && this.grab) mv = panToKeep(r.origin, r.direction, this.grab, this.distance * 4 + 1000)
    if (!mv) {
      const up = this._up.setFromMatrixColumn(this.cam.matrixWorld, 1)
      const fwd = this._fwd.setFromMatrixColumn(this.cam.matrixWorld, 2).negate()
      mv = panByPixels(dx, dy, this.right(), up, fwd, this.metresPerPixel)
    }
    eye.x += mv.dx
    eye.z += mv.dz
    t.x += mv.dx
    t.z += mv.dz
    const cap = Math.max(50, this.distance * 3)
    const dtE = Math.max(0.008, dtSec)
    this.panVel.set(
      clamp(0.4 * this.panVel.x + 0.6 * (mv.dx / dtE), -cap, cap),
      clamp(0.4 * this.panVel.y + 0.6 * (mv.dz / dtE), -cap, cap),
    )
  }

  /** OrbitKeyPan: the look-at point's height follows the ground under it, the eye riding along */
  private easeTargetToGround(dt: number) {
    const h = this.host.heightAt(this.target.x, this.target.z)
    if (h === null || !Number.isFinite(h)) return
    const dy = (h - this.target.y) * easeK(2.5, dt)
    this.target.y += dy
    this.cam.position.y += dy
  }

  private keyFrame(dt: number) {
    const ks = this.keys
    const sprint = ks.has('ShiftLeft') || ks.has('ShiftRight')
    const fwd = Number(ks.has('KeyW') || ks.has('ArrowUp')) - Number(ks.has('KeyS') || ks.has('ArrowDown'))
    const strafe = Number(ks.has('KeyD') || ks.has('ArrowRight')) - Number(ks.has('KeyA') || ks.has('ArrowLeft'))
    const yaw = Number(ks.has('KeyQ')) - Number(ks.has('KeyE'))
    const lift = Number(ks.has('KeyR')) - Number(ks.has('KeyF'))
    if (!fwd && !strafe && !yaw && !lift) return
    this.stats.keyFrames++
    const eye = this.cam.position
    const t = this.target
    const d = this.distance
    if (yaw) yawAboutEye(eye, t, yaw * (sprint ? 2.1 : 1.2) * dt)
    if (lift) eye.y += lift * Math.max(d, 8) * (sprint ? 1.4 : 0.6) * dt
    if (fwd || strafe) {
      const step = Math.max(d, 8) * 0.55 * dt * (sprint ? 2.6 : 1)
      const h = this.headingDeg * DEG
      const nx = Math.sin(h), nz = -Math.cos(h) // the view's heading on the ground
      const mx = (nx * fwd + -nz * strafe) * step
      const mz = (nz * fwd + nx * strafe) * step
      eye.x += mx
      eye.z += mz
      t.x += mx
      t.z += mz
      this.easeTargetToGround(dt)
    }
  }

  // -------------------------------------------------------------------------------------------
  // the ring

  private buildRing() {
    const mk = (geo: THREE.BufferGeometry, color: number, opacity: number, order: number) => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide, fog: false }))
      m.renderOrder = order
      return m
    }
    this.ring.add(
      mk(new THREE.RingGeometry(0.9, 1.28, 56), 0x001016, 0.6, 9998),
      mk(new THREE.RingGeometry(0.72, 1.0, 56), 0x2ff0ff, 1, 9999),
      mk(new THREE.CircleGeometry(0.16, 28), 0x2ff0ff, 1, 10000),
    )
    this.ring.rotation.x = -Math.PI / 2
    this.ring.visible = false
    this.ring.name = 'nav:pivot'
  }

  private updateRing(on: boolean) {
    this.ring.visible = this.showPivot && on
    if (!this.ring.visible) return
    this.ring.position.copy(this.gest.pivot)
    // ~16 px radius at any zoom (trailworks TARGET_PX)
    const dist = this.cam.position.distanceTo(this.gest.pivot)
    const ppm = 1 / metresPerPixel(dist, this.cam.fov, this.el.clientHeight || 800)
    const sc = Math.max(16 / Math.max(ppm, 1e-9), 0.05)
    this.ring.scale.set(sc, sc, sc)
  }

  // -------------------------------------------------------------------------------------------
  // events

  private listen() {
    const el = this.el
    const on = <K extends keyof HTMLElementEventMap>(t: HTMLElement | Window, type: K, f: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(type, f as EventListener, opts)
      this.off.push(() => t.removeEventListener(type, f as EventListener, opts))
    }
    el.style.touchAction = 'none'

    on(el, 'pointerdown', (e) => {
      if (e.pointerType === 'touch') return
      this.stopAll()
      this.press = { button: e.button, shift: e.shiftKey, x: e.clientX, y: e.clientY, id: e.pointerId }
      this.last = { x: e.clientX, y: e.clientY, t: performance.now() }
      if (e.button === 1) e.preventDefault() // no autoscroll
    })
    on(el, 'pointermove', (e) => {
      if (e.pointerType === 'touch') return
      const now = performance.now()
      const dtSec = (now - this.last.t) / 1000
      const dx = e.clientX - this.last.x
      const dy = e.clientY - this.last.y
      this.last = { x: e.clientX, y: e.clientY, t: now }
      if (this.press && !this.gest.mode) {
        // THE DECISION IS MADE ON THE FIRST MOVE, after every pointerdown listener has run
        const p = this.press
        this.press = null
        if (!this.enabled || !(e.buttons & BUTTON_BIT[p.button])) return
        const mode: GestureMode | null = p.button === 0 ? (p.shift ? (this.enableRotate ? 'heli' : null) : this.enablePan ? 'pan' : null)
          : p.button === 1 ? (this.enableRotate ? 'orbit' : null)
            : p.button === 2 ? (this.enableZoom ? 'zoom' : null) : null
        if (!mode) return
        const pivot = this.pickAt(p.x, p.y)
        if (mode === 'pan') {
          this.grab = pivot
          this.startGesture('pan', pivot ?? this.target)
        } else {
          if (!pivot) return // no ground under the press: ignore, as trailworks does
          this.startGesture(mode, pivot)
        }
        try { el.setPointerCapture(e.pointerId) } catch { /* a synthetic event has no live pointer */ }
        // this first move is measured from the press itself
        this.drag(e.clientX, e.clientY, e.clientX - p.x, e.clientY - p.y, dtSec)
        return
      }
      if (!this.gest.mode || this.gest.mode === 'touch') return
      // a tool took the pointer back (a gizmo handle found mid-drag): stand down, no glide
      if (!this.enabled) {
        this.gest.mode = null
        this.grab = null
        this.panVel.set(0, 0)
        return
      }
      this.drag(e.clientX, e.clientY, dx, dy, dtSec)
    })
    on(window, 'pointerup', (e) => {
      if (e.pointerType === 'touch') return
      this.press = null
      const m = this.gest.mode
      if (!m || m === 'touch') return
      if (m === 'pan') {
        this.gest.mode = null
        this.grab = null
        // a release after the hand stopped is not a flick
        if (performance.now() - this.last.t > 80) this.panVel.set(0, 0)
        return
      }
      this.gest.mode = null
      this.gest.coasting = true
    })
    on(el, 'wheel', (e) => {
      if (e.defaultPrevented || !this.enabled || !this.enableZoom || !this.host.active()) return
      e.preventDefault()
      const k = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1
      this.wheelZoom(e.clientX, e.clientY, clamp(e.deltaY * k * 0.0016, -0.5, 0.5))
    }, { passive: false })
    on(el, 'contextmenu', (e) => e.preventDefault())

    // ---- touch
    const T = this.touch
    const clearPress = () => {
      if (T.timer) clearTimeout(T.timer)
      T.timer = null
    }
    const two = (ts: TouchList): TwoFinger => ({ ax: ts[0].clientX, ay: ts[0].clientY, bx: ts[1].clientX, by: ts[1].clientY })
    const beginOne = (x: number, y: number) => {
      T.mode = 'one'
      T.lx = x
      T.ly = y
      T.lt = performance.now()
      this.grab = this.enabled && this.enablePan ? this.pickAt(x, y) : null
      this.gest.pivot.copy(this.grab ?? this.target)
    }
    on(el, 'touchstart', (e) => {
      this.fly = null
      this.north = false
      this.panVel.set(0, 0)
      for (const t of Array.from(e.changedTouches)) T.start.set(t.identifier, [t.clientX, t.clientY])
      if (e.touches.length === 1) {
        this.endGesture()
        T.sessionStart = performance.now()
        T.maxTouches = 1
        T.moved = false
        const t0 = e.touches[0]
        beginOne(t0.clientX, t0.clientY)
        clearPress()
        T.timer = setTimeout(() => {
          if (!T.moved && T.maxTouches === 1) this.host.onLongPress?.(t0.clientX, t0.clientY)
        }, LONG_PRESS_MS)
      } else if (e.touches.length >= 2) {
        T.maxTouches = Math.max(T.maxTouches, e.touches.length)
        clearPress()
        this.grab = null
        if (!this.enabled) return
        T.mode = 'two'
        T.gg = two(e.touches)
        T.acc = { rot: 0, logS: 0, tilt: 0, uRot: false, uZoom: false, uTilt: false }
        T.lt = performance.now()
        const cx = (T.gg.ax + T.gg.bx) / 2, cy = (T.gg.ay + T.gg.by) / 2
        this.startGesture('touch', this.pickAt(cx, cy) ?? this.target)
      }
    }, { passive: true })
    on(el, 'touchmove', (e) => {
      e.preventDefault()
      for (const t of Array.from(e.touches)) {
        const s = T.start.get(t.identifier)
        if (s && Math.hypot(t.clientX - s[0], t.clientY - s[1]) > TAP_SLOP_PX) {
          T.moved = true
          clearPress()
        }
      }
      if (!this.enabled) return
      const now = performance.now()
      const dtSec = (now - T.lt) / 1000
      T.lt = now
      if (T.mode === 'one' && e.touches.length === 1 && this.enablePan) {
        const t0 = e.touches[0]
        this.panTo(t0.clientX, t0.clientY, t0.clientX - T.lx, t0.clientY - T.ly, dtSec)
        T.lx = t0.clientX
        T.ly = t0.clientY
        this.apply()
      } else if (T.mode === 'two' && e.touches.length >= 2 && T.gg && this.gest.mode === 'touch') {
        this.twoFinger(T.gg, two(e.touches), dtSec)
        T.gg = two(e.touches)
      }
    }, { passive: false })
    const end = (e: TouchEvent) => {
      const lift = e.changedTouches[0]
      for (const t of Array.from(e.changedTouches)) T.start.delete(t.identifier)
      if (e.touches.length >= 2) {
        T.gg = two(e.touches)
        return
      }
      if (e.touches.length === 1) {
        // back to one finger: the two-finger gesture ends here, the pan picks up
        if (this.gest.mode === 'touch' || this.gest.coasting) this.endGesture()
        beginOne(e.touches[0].clientX, e.touches[0].clientY)
        return
      }
      clearPress()
      if (this.gest.mode === 'touch') {
        this.gest.mode = null
        this.gest.coasting = true
      }
      if (T.mode === 'one' && performance.now() - T.lt > 80) this.panVel.set(0, 0)
      this.grab = null
      T.mode = null
      const isTap = performance.now() - T.sessionStart < TAP_MAX_MS && !T.moved
      if (isTap && this.enabled && this.enableZoom) {
        const now = performance.now()
        if (now - T.lastTapAt < DOUBLE_TAP_MS && T.lastTapTouches === T.maxTouches) {
          const r = el.getBoundingClientRect()
          const lx = lift?.clientX ?? r.left + r.width / 2
          const ly = lift?.clientY ?? r.top + r.height / 2
          this.tapZoom(lx, ly, T.maxTouches === 1 ? 0.55 : 1.8)
          T.lastTapAt = 0
        } else {
          T.lastTapAt = now
          T.lastTapTouches = T.maxTouches
        }
      } else T.lastTapAt = 0
      T.maxTouches = 0
    }
    on(el, 'touchend', end, { passive: true })
    on(el, 'touchcancel', end, { passive: true })
  }

  /** a double-tap: fly toward the tapped ground by `factor` (TouchExtras `globeZoom`) */
  private tapZoom(clientX: number, clientY: number, factor: number) {
    const p = this.pickAt(clientX, clientY) ?? this.target.clone()
    const eye = this.cam.position.clone()
    const t = this.target.clone()
    if (zoomAbout(eye, t, p, Math.log(factor), this.limits())) this.flyTo(t, eye)
  }

  /** TouchExtras' maps scheme, with GlobeControls' coast */
  private twoFinger(g0: TwoFinger, g1: TwoFinger, dtSec: number) {
    const T = this.touch
    const eye = this.cam.position
    const t = this.target
    // client coordinates throughout, as trailworks (its off-screen test is against the window)
    const fp = twoFingerFixedPoint(g0, g1, innerWidth, innerHeight)
    const fx = fp.x, fy = fp.y
    const dy0 = g1.ay - g0.ay, dy1 = g1.by - g0.by
    const dTilt = dy0 * dy1 > 0 ? (dy0 + dy1) / 2 : 0
    T.acc.rot += fp.dAng
    T.acc.logS += Math.log(Math.max(fp.s, 1e-6))
    T.acc.tilt += dTilt
    if (!T.acc.uRot && Math.abs(T.acc.rot) > 0.045) T.acc.uRot = true
    if (!T.acc.uZoom && Math.abs(T.acc.logS) > 0.04) T.acc.uZoom = true
    if (!T.acc.uTilt && Math.abs(T.acc.tilt) > 14) T.acc.uTilt = true
    const twisting = T.acc.uRot && fp.dAng !== 0 && this.enableRotate
    const pinching = T.acc.uZoom && fp.s !== 1 && this.enableZoom
    if (twisting || pinching) {
      const pivot = this.pickAt(fx, fy) ?? t.clone()
      this.gest.pivot.copy(pivot)
      if (twisting) {
        orbitAbout(eye, t, pivot, fp.dAng, 0, this.right(), this.polar())
        this.gest.vAz = fold(this.gest.vAz, fp.dAng, dtSec, 4)
      }
      if (pinching) zoomAbout(eye, t, pivot, Math.log(1 / fp.s), this.limits())
      // the drift correction: the pivot back under the fixed point, against its own plane
      for (let i = 0; i < 2; i++) {
        this.apply()
        const ray = this.rayAt(fx, fy)
        const after = ray ? rayPlane(ray.origin, ray.direction, pivot.y) : null
        if (!after) break
        const ddx = pivot.x - after.x, ddz = pivot.z - after.z
        if (Math.hypot(ddx, ddz) < 0.01) break
        eye.x += ddx
        eye.z += ddz
        t.x += ddx
        t.z += ddz
      }
    } else if (!T.acc.uTilt) {
      // a two-finger slide with no pinch or twist yet: the fixed point is the centroid, and
      // keeping the ground under it is a pan
      const cx0 = (g0.ax + g0.bx) / 2, cy0 = (g0.ay + g0.by) / 2
      this.panTo(fx, fy, fx - cx0, fy - cy0, dtSec)
    }
    if (T.acc.uTilt && dTilt !== 0 && this.enableRotate) {
      // fingers up = tilt toward the horizon, as the middle-drag
      orbitAbout(eye, t, this.gest.pivot, 0, -dTilt * 0.005, this.right(), this.polar())
    }
    this.apply()
  }
}

const POSE_KEY = 'corridor.editor.pose.'
const NAV_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyR', 'KeyF', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])
const MODE_CODE: Record<GestureMode, number> = { pan: 1, orbit: 2, heli: 3, zoom: 4, touch: 5 }
/** PointerEvent.button → the PointerEvent.buttons bit that says it is still held */
const BUTTON_BIT: Record<number, number> = { 0: 1, 1: 4, 2: 2 }
const wrapDeg = (v: number) => ((((v + 180) % 360) + 360) % 360) - 180
const round2 = (v: number) => Math.round(v * 100) / 100
// `UP` is re-exported for the host's own maths
export { UP }
