// Preview: drop into the level you have been editing, without leaving the editor.
//
// THE PREVIEW IS THE EDITOR'S OWN SITE, not a second one built beside it. That is the whole
// design. A second `buildSite` would double the memory (a corridor is a 22 MP drape, a fine
// terrain strip and up to 120k trees), and worse, it would be a second thing that can disagree
// with the first — the bug you would never catch is the preview showing you something the game
// does not. So: save, reload the one site, and look at it from the driver's seat.
//
// Because `buildSite` reads `adjustments.json` and `placements.json` off the server and bakes the
// canopy corrections into the height model at load, previewing edits REQUIRES a save and a
// reload. There is no cheaper honest version: `retune()` re-picks trees and re-seeds grass but
// cannot un-bake a canopy scale. So the button saves, reloads, and says so.
//
// Rendering: one renderer, scissored to the dialog's viewport rect, so the preview draws inside
// the dialog rather than behind it. Nothing is duplicated on the GPU.
import * as THREE from 'three'
import { Car, type CarInput, type DrivableCar } from '../car'
import { RapierCar } from '../rapiercar'
import { buildPhysics, type CorridorPhysics } from '../physics'
import { addStuntColliders } from '../stuntworld'
import { profile as driveProfile } from '@apex/engine/physics/profiles'
import type { Build } from '../assetsvc'
import type { VehicleDoc } from '../vehicles'
import type { StuntFixture } from '../stunts'
import * as T from '../tuning'
import { LOOK, SEASONS, type Season } from '../season'
import type { Site } from '../scene'
import { el } from './ui'

const UP = new THREE.Vector3(0, 1, 0)
// scratch: updateNear runs every frame and the tree LOD is already the expensive part
const FWD = new THREE.Vector3()

/**
 * Groups an editing mode adds to the scene mark themselves with `userData.editorOverlay = true`,
 * and the preview hides every one of them for the duration.
 *
 * The flag rather than a list, because a list is a thing a new mode forgets to join: the first
 * version of this hid the SITE's spine and markers and nothing else, so the preview showed area
 * fills and structure ribbons painted over the road — reported from the structures session, which
 * is exactly the kind of mode that would have had to be added to a list.
 */
export const markOverlay = (o: THREE.Object3D) => {
  o.userData.editorOverlay = true
  return o
}

interface Saved {
  layers: boolean[]
  overlays: { o: THREE.Object3D; was: boolean }[]
  camPos: THREE.Vector3
  camQuat: THREE.Quaternion
  target: THREE.Vector3
  fog: number
  background: THREE.Color
}

export class Preview {
  open = false
  mode: 'drive' | 'fly' = 'drive'
  private scene: THREE.Scene
  private camera = new THREE.PerspectiveCamera(65, 1, 0.3, 120_000)
  private site: Site | null = null
  private car: DrivableCar | null = null
  /**
   * The preview's own physics world, built only for a site that has stunt fixtures on it.
   *
   * Rich, 2026-09-29: *"It doesn't look like that works in the preview from the editor."* It did
   * not: the preview drives `Car`, which samples the terrain height under itself, and it had no
   * physics world at all — so a loop you had just placed was something to look at and drive
   * through. The viewer decides this from the document; so does this, from the tool's own fixtures,
   * which is better still: they do not have to be saved first.
   *
   * NOT BUILT FOR A WORLD WITHOUT THEM. It is a 4.3 MB import and a grid of heightfield colliders,
   * and the hand-written car is what every other preview has always used.
   */
  private physics: CorridorPhysics | null = null
  private surfaces = 0
  /**
   * Which handling model the preview's car is driving.
   *
   * A STUNT WORLD DEFAULTS TO `stunts`, which is the whole point of that profile: 11 m/s² per kilo
   * and 82 m/s against `street`'s 7.5 and 58. Rich, 2026-09-29: *"that car needs a lot more power
   * in the preview… can't get it fast enough to do a loop de loop"*. Quite: a loop needs the speed
   * to hold you on the inside of it, and the preview was spawning the road car.
   *
   * AN EXPLICIT CHOICE STILL WINS. If the F6 knob has been moved off its default, that is somebody
   * saying which model they want and the inference gets out of the way — the same rule as `?phys`.
   */
  private profileId = 'street'
  /** what the knob said last time we looked, so moving it changes the car you are already driving */
  private lastKnob = ''
  private carSel!: HTMLSelectElement
  /**
   * The vehicle builds this installation has, for the picker.
   *
   * Rich, 2026-09-29: *"changing the car's performance stats from the tuner does not seem to alter
   * the performance"*. Two different things were true at once: the PROFILE was read once at spawn,
   * and the vehicle BUILD — the screen with the power, the gearing and the top speed on it — was
   * never consulted at all, because the preview span a default car. Both are the picker now: the
   * five handling models change live, and a build respawns the car with its own engine and chassis.
   */
  private vehicles: Build<VehicleDoc>[] = []
  private vehicleId: string | null = null
  private input: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false }
  private look = { yaw: 0, pitch: 0 }
  private fly = { pos: new THREE.Vector3(), yaw: 0, pitch: -0.1, speed: 30 }
  private keys = new Set<string>()
  private dragging = false
  private lastX = 0
  private lastY = 0
  private saved: Saved | null = null
  /** read back on close, so a reload of the site keeps the season you previewed in */
  season: Season = 'summer'
  private dlg: HTMLElement
  private viewport: HTMLElement
  private canvas: HTMLCanvasElement
  private clipped = ''
  /** the canvas box the window was last framed to, so it is only restyled when it moves */
  private framed = ''
  private hud: HTMLElement
  private onClose: () => void
  private seasonSel!: HTMLSelectElement

  constructor(scene: THREE.Scene, canvas: HTMLCanvasElement, root: HTMLElement, onClose: () => void) {
    this.scene = scene
    this.canvas = canvas
    this.onClose = onClose
    this.dlg = el('div', 'preview')
    this.viewport = el('div', 'pv-view')
    this.hud = el('div', 'pv-hud mono')
    const bar = el('div', 'pv-bar')
    const title = el('span', 'pv-title', 'preview')
    const modeBtn = el('button')
    modeBtn.textContent = 'fly (Tab)'
    modeBtn.onclick = () => this.setMode(this.mode === 'drive' ? 'fly' : 'drive')
    const reset = el('button')
    reset.textContent = 'reset (R)'
    reset.onclick = () => this.reset()
    const season = document.createElement('select')
    for (const s of SEASONS) {
      const o = document.createElement('option')
      o.value = s
      o.textContent = s
      season.append(o)
    }
    season.onchange = () => {
      this.season = season.value as Season
      this.applySeason()
    }
    this.seasonSel = season
    /*
     * THE CAR PICKER. Live, because the useful thing to do with five handling models is drive the
     * same corner in each — and because the profile used to be read once, at spawn, which made the
     * F6 knob look broken.
     */
    const carSel = document.createElement('select')
    const models = document.createElement('optgroup')
    models.label = 'handling model'
    for (const id of T.PHYS_PROFILE_NAMES) {
      const o = document.createElement('option')
      o.value = id
      o.textContent = id
      models.append(o)
    }
    carSel.append(models)
    carSel.title = 'how the car handles — stunts is the fast arcade one a loop needs'
    carSel.onchange = () => this.pick(carSel.value)
    this.carSel = carSel

    const close = el('button', 'danger')
    close.textContent = 'close (Esc)'
    close.onclick = () => this.hide()
    bar.append(title, modeBtn, reset, season, carSel, close)
    const help = el('div', 'pv-help', 'drive: W/S throttle & brake · A/D steer · Space handbrake · drag to look   ·   fly: W/A/S/D, Q/E down/up, drag to look, shift sprints   ·   R resets to the photo frame')
    this.dlg.append(bar, this.viewport, this.hud, help)
    this.dlg.style.display = 'none'
    root.append(this.dlg)
    this.bind(modeBtn)
  }

  private bind(modeBtn: HTMLElement) {
    addEventListener('keydown', (e) => {
      if (!this.open) return
      if ((e.target as HTMLElement).tagName === 'SELECT') return
      if (e.code === 'Escape') return this.hide()
      if (e.code === 'Tab') {
        e.preventDefault()
        this.setMode(this.mode === 'drive' ? 'fly' : 'drive')
        modeBtn.textContent = this.mode === 'drive' ? 'fly (Tab)' : 'drive (Tab)'
        return
      }
      if (e.code === 'KeyR') this.reset()
      this.keys.add(e.code)
      // the editor's own shortcuts must not fire while a preview has the screen
      e.stopPropagation()
    }, true)
    addEventListener('keyup', (e) => this.keys.delete(e.code))
    addEventListener('blur', () => this.keys.clear())
    this.viewport.addEventListener('pointerdown', (e) => {
      this.dragging = true
      this.lastX = e.clientX
      this.lastY = e.clientY
      this.viewport.setPointerCapture(e.pointerId)
    })
    this.viewport.addEventListener('pointerup', (e) => {
      this.dragging = false
      this.viewport.releasePointerCapture(e.pointerId)
    })
    this.viewport.addEventListener('pointermove', (e) => {
      if (!this.dragging) return
      const dx = e.clientX - this.lastX
      const dy = e.clientY - this.lastY
      this.lastX = e.clientX
      this.lastY = e.clientY
      if (this.mode === 'drive') {
        this.look.yaw -= dx * 0.004
        this.look.pitch = Math.max(-0.7, Math.min(0.7, this.look.pitch - dy * 0.003))
      } else {
        this.fly.yaw -= dx * 0.004
        this.fly.pitch = Math.max(-1.4, Math.min(1.4, this.fly.pitch - dy * 0.003))
      }
    })
  }

  /** Show the preview over a site that is already loaded and already saved. */
  show(site: Site, season: Season) {
    this.site = site
    this.season = season
    this.saved = {
      layers: [],
      overlays: [],
      camPos: new THREE.Vector3(),
      camQuat: new THREE.Quaternion(),
      target: new THREE.Vector3(),
      fog: (this.scene.fog as THREE.FogExp2 | null)?.density ?? 0,
      background: (this.scene.background as THREE.Color).clone(),
    }
    // the authoring overlays step aside; everything the game draws comes back on
    this.saved.layers = [
      site.layers.trees?.visible ?? false,
      site.layers.spine.visible,
      site.layers.markers.visible,
      site.layers.horizon?.visible ?? false,
      site.layers.placements.visible,
    ]
    for (const o of this.scene.children) {
      if (o.userData.editorOverlay) {
        this.saved.overlays.push({ o, was: o.visible })
        o.visible = false
      }
    }
    if (site.layers.trees) site.layers.trees.visible = true
    site.layers.spine.visible = false
    site.layers.markers.visible = false
    if (site.layers.horizon) site.layers.horizon.visible = true
    site.layers.placements.visible = true
    site.setImagery(true)
    this.seasonSel.value = this.season
    this.applySeason()
    this.open = true
    this.dlg.style.display = ''
    /*
     * The canvas lives BEHIND the page, so an 82%-opaque backdrop over the dialog dims the preview
     * along with everything else — the first version came out looking like night. Lift the canvas
     * above the backdrop and clip it to the dialog's hole instead, so the surround stays dark and
     * the preview is drawn at full strength. `pointer-events: none` hands the drag back to
     * `.pv-view` underneath it.
     *
     * THE LIFT IS READ FROM THE TOKEN, NOT TYPED. It was `21`, and `--z-modal` is `50`: the canvas
     * sat UNDER the very backdrop it was supposed to clear, so the preview was drawn through
     * `background: var(--scrim)` and `backdrop-filter: blur(6px)` — dark and soft, exactly as if
     * nothing had been lifted at all (Rich, 2026-09-29, with a screenshot). A hard-coded number
     * beside a token is a number that goes stale the first time the token moves, and nothing says
     * so: the preview still renders, it just renders behind the glass.
     */
    this.canvas.style.zIndex = String(modalZ() + 1)
    this.canvas.style.pointerEvents = 'none'
    this.clip()
    this.reset()
  }

  /**
   * Give the preview what it needs to drive this world's stunts, before it opens.
   *
   * Awaited by the caller rather than started inside `show`, because a car that begins as the
   * kinematic one and is swapped for the physics one two seconds later is a preview that drives
   * differently depending on how fast your disk is.
   */
  async usePhysics(site: Site, fixtures: readonly StuntFixture[]): Promise<string | null> {
    this.dropPhysics()
    if (!fixtures.length) return null
    const phys = await buildPhysics(site, { enabled: true }).catch(() => null)
    if (!phys) return 'physics did not start — the preview will drive the ordinary car'
    this.physics = phys
    this.surfaces = addStuntColliders(site, phys, fixtures)
    const knob = T.physProfileId()
    // the knob at its default means nobody has chosen, so a world with stunts in it gets the
    // stunt car; a knob that has been moved is a choice and is left alone
    this.profileId = knob === 'street' ? 'stunts' : knob
    this.lastKnob = knob
    this.carSel.value = this.profileId
    /*
     * THE BUILDS, IF THERE IS A SERVICE. Imported here rather than at the top of the file because
     * `assetsvc` reads `location` as it loads, and this module is imported by a node test — a
     * module-scope import turned "the preview frames its canvas correctly" into a suite that could
     * not even be loaded.
     *
     * No service is not an error: the picker then offers the five handling models and nothing else.
     */
    await import('../assetsvc')
      .then((m) => m.assetsvc.builds<Build<VehicleDoc>>('vehicles'))
      .then((vs) => { this.vehicles = vs; this.listVehicles() })
      .catch(() => { this.vehicles = [] })
    return `${this.surfaces} stunt surface${this.surfaces === 1 ? '' : 's'} solid · driving the ${this.profileId} car`
  }

  /** Put the vehicle builds into the picker, under the handling models. */
  private listVehicles() {
    for (const o of [...this.carSel.querySelectorAll('optgroup')]) if (o.label !== 'handling model') o.remove()
    if (!this.vehicles.length) return
    const g = document.createElement('optgroup')
    g.label = 'your vehicles'
    for (const v of this.vehicles) {
      const o = document.createElement('option')
      o.value = `v:${v.id}`
      o.textContent = v.name || v.id
      g.append(o)
    }
    this.carSel.append(g)
  }

  /** The picker: a handling model, or one of your own cars. */
  private pick(value: string) {
    if (!value.startsWith('v:')) {
      this.vehicleId = null
      this.setProfile(value)
      return
    }
    this.vehicleId = value.slice(2)
    /*
     * A BUILD IS A RESPAWN, not a live change. `applyProfile` pushes suspension and grip into the
     * wheels a car already has; a different car has a different mass, wheelbase and wheel radius,
     * and those are the collider. So the car is rebuilt where the old one stood, facing the same
     * way, which is what you want when you are comparing two cars on the same corner.
     */
    this.respawn()
  }

  private respawn() {
    const phys = this.physics
    const old = this.car
    if (!phys || !old) return
    const at = { x: old.pos.x, z: old.pos.z, yaw: old.yaw }
    this.scene.remove(old.mesh)
    ;(old as { free?: () => void }).free?.()
    const doc = this.vehicles.find((v) => v.id === this.vehicleId)?.doc
    const surface = { heightAt: this.site!.groundAt, edgeDistance: this.site!.edgeDistance, treesNear: this.site!.treesNear }
    this.car = new RapierCar(phys.spawnCar(at, this.profileId, doc), surface)
    this.scene.add(this.car.mesh)
    this.car.place(at.x, at.z, at.yaw)
  }

  /** Change how the car handles, now — from the picker, or because the knob moved. */
  setProfile(id: string): void {
    this.profileId = id
    if (this.carSel) this.carSel.value = id
    const car = this.car
    if (car && 'setProfile' in car) (car as RapierCar).setProfile(driveProfile(id))
  }

  private dropPhysics() {
    this.physics?.free()
    this.physics = null
    this.surfaces = 0
  }

  hide() {
    if (!this.open || !this.site || !this.saved) return
    const s = this.site
    const [trees, spine, markers, horizon, placements] = this.saved.layers
    if (s.layers.trees) s.layers.trees.visible = trees
    s.layers.spine.visible = spine
    s.layers.markers.visible = markers
    if (s.layers.horizon) s.layers.horizon.visible = horizon
    s.layers.placements.visible = placements
    for (const { o, was } of this.saved.overlays) o.visible = was
    ;(this.scene.background as THREE.Color).copy(this.saved.background)
    if (this.scene.fog) (this.scene.fog as THREE.FogExp2).density = this.saved.fog
    if (this.car) {
      this.scene.remove(this.car.mesh)
      ;(this.car as { free?: () => void }).free?.()
      this.car = null
    }
    // THE PHYSICS WORLD BELONGS TO THE PREVIEW. Keeping it alive behind the editor would leave a
    // grid of heightfield colliders stepping under a screen that is not simulating anything.
    this.dropPhysics()
    this.open = false
    this.keys.clear()
    this.dlg.style.display = 'none'
    this.canvas.style.zIndex = ''
    // the window goes back to covering the page, so the next `show` re-frames from scratch
    this.framed = ''
    for (const k of ['left', 'top', 'right', 'bottom', 'width', 'height'] as const) this.dlg.style[k] = ''
    this.canvas.style.pointerEvents = ''
    this.canvas.style.clipPath = ''
    this.clipped = ''
    this.onClose()
  }

  private applySeason() {
    if (!this.site) return
    const look = LOOK[this.season]
    this.site.setSeason(this.season)
    ;(this.scene.background as THREE.Color).copy(look.sky)
    if (!this.scene.fog) this.scene.fog = new THREE.FogExp2(look.sky.getHex(), look.fog)
    else {
      ;(this.scene.fog as THREE.FogExp2).color.copy(look.sky)
      ;(this.scene.fog as THREE.FogExp2).density = look.fog
    }
  }

  private setMode(m: 'drive' | 'fly') {
    this.mode = m
    if (m === 'fly') {
      this.fly.pos.copy(this.camera.position)
    } else this.reset()
  }

  /** Back to the frame Rich actually photographed — the one place every site has in common. */
  reset() {
    if (!this.site) return
    const p = this.site.spineAt(this.site.manifest.spine.photo_s)
    if (this.mode === 'drive') {
      const side = p.dir.clone().cross(UP).multiplyScalar(1.83)
      if (!this.car) {
        const surface = { heightAt: this.site.groundAt, edgeDistance: this.site.edgeDistance, treesNear: this.site.treesNear }
        /*
         * THE CAR THAT CAN HIT A TRIMESH, when there is a physics world to hit one in. The
         * kinematic car follows a height model — one height per column — so it drives through a
         * loop however solid the loop is, which is what "the stunts do not work in the preview"
         * looked like.
         */
        this.car = this.physics
          ? new RapierCar(this.physics.spawnCar(
            { x: p.pos.x + side.x, z: p.pos.z + side.z, yaw: Math.atan2(p.dir.z, p.dir.x) },
            this.profileId,
            this.vehicles.find((v) => v.id === this.vehicleId)?.doc,
          ), surface)
          : new Car(surface)
        this.scene.add(this.car.mesh)
      }
      this.car.place(p.pos.x + side.x, p.pos.z + side.z, Math.atan2(p.dir.z, p.dir.x))
      this.look.yaw = 0
      this.look.pitch = 0
    } else {
      this.fly.pos.copy(p.pos).add(new THREE.Vector3(0, 25, 0))
      this.fly.yaw = Math.atan2(p.dir.x, -p.dir.z)
      this.fly.pitch = -0.15
    }
  }

  tick(dt: number, time: number) {
    if (!this.open || !this.site) return
    const k = this.keys
    if (this.mode === 'drive' && this.car) {
      this.input.throttle = k.has('KeyW') || k.has('ArrowUp') ? 1 : 0
      this.input.brake = k.has('KeyS') || k.has('ArrowDown') ? 1 : 0
      this.input.steer = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0)
      this.input.handbrake = k.has('Space')
      /*
       * THE KNOB IS LIVE NOW. `physProfileId()` is read every frame and pushed into the car the
       * moment it changes, so the F6 slider alters the car you are driving rather than the car you
       * would get if you closed the preview and opened it again.
       */
      const knob = T.physProfileId()
      if (knob !== this.lastKnob) {
        this.lastKnob = knob
        this.setProfile(knob)
      }
      if (this.physics) {
        /*
         * RAPIER STEPS ITSELF. `RapierCar.tick` only hands the controls over and reads the result
         * back — `physics.update` is what advances the world, at its own fixed rate, and it also
         * builds the heightfield tiles around wherever the car has got to.
         */
        this.car.tick(dt, this.input)
        this.physics.update(this.car.pos, dt)
      } else {
        // fixed sub-steps: the hand-written car model is stuntin's and it is tuned at 120 Hz
        for (let acc = dt; acc > 0; acc -= 1 / 120) this.car.tick(Math.min(acc, 1 / 120), this.input)
      }
      const car = this.car
      const back = car.forward.clone().applyAxisAngle(UP, this.look.yaw).multiplyScalar(-T.CHASE_BACK)
      const want = car.pos.clone().add(back).add(new THREE.Vector3(0, T.CHASE_UP + Math.tan(this.look.pitch) * 4, 0))
      const ground = this.site.groundAt(want.x, want.z)
      if (ground != null) want.y = Math.max(want.y, ground + 1.2)
      this.camera.position.lerp(want, Math.min(1, T.CHASE_LAG * dt))
      this.camera.lookAt(car.pos.clone().add(car.forward.clone().multiplyScalar(T.CHASE_LOOK_AHEAD)).add(new THREE.Vector3(0, 1, 0)))
      // the HUD says WHICH car, because the two handle differently and the difference is the point
      this.hud.textContent = `${(Math.abs(car.speed) * 2.237).toFixed(0)} mph   ${car.onGrass ? 'grass' : 'pavement'}${Math.abs(car.slide) > 1 ? '   sliding' : ''}${this.physics ? `   ${this.vehicleId ?? this.profileId} car · ${this.surfaces} stunt${this.surfaces === 1 ? '' : 's'}` : ''}`
    } else {
      const sprint = k.has('ShiftLeft') || k.has('ShiftRight') ? 4 : 1
      const step = this.fly.speed * sprint * dt
      const fwd = new THREE.Vector3(Math.sin(this.fly.yaw), 0, -Math.cos(this.fly.yaw))
      const right = fwd.clone().cross(UP).multiplyScalar(-1)
      if (k.has('KeyW') || k.has('ArrowUp')) this.fly.pos.addScaledVector(fwd, step)
      if (k.has('KeyS') || k.has('ArrowDown')) this.fly.pos.addScaledVector(fwd, -step)
      if (k.has('KeyA') || k.has('ArrowLeft')) this.fly.pos.addScaledVector(right, -step)
      if (k.has('KeyD') || k.has('ArrowRight')) this.fly.pos.addScaledVector(right, step)
      if (k.has('KeyE')) this.fly.pos.y += step
      if (k.has('KeyQ')) this.fly.pos.y -= step
      const ground = this.site.groundAt(this.fly.pos.x, this.fly.pos.z)
      if (ground != null) this.fly.pos.y = Math.max(this.fly.pos.y, ground + 1.7)
      this.camera.position.copy(this.fly.pos)
      const dir = new THREE.Vector3(Math.sin(this.fly.yaw) * Math.cos(this.fly.pitch), Math.sin(this.fly.pitch), -Math.cos(this.fly.yaw) * Math.cos(this.fly.pitch))
      this.camera.lookAt(this.fly.pos.clone().add(dir))
      this.hud.textContent = `fly   ${this.fly.pos.y.toFixed(0)} m`
    }
    this.site.updateNear(this.camera.position, time, this.camera.getWorldDirection(FWD), this.mode === 'drive' ? this.look.pitch : this.fly.pitch)
  }

  /**
   * Draw into the dialog's hole. `setViewport`/`setScissor` take CSS pixels — three multiplies by
   * the pixel ratio itself — and the origin is the BOTTOM left, hence `innerHeight - bottom`.
   */
  /** Clip the canvas to the dialog's hole. Cheap, and idempotent — only touched when it moves. */
  /*
   * EVERYTHING HERE IS RELATIVE TO THE CANVAS, NOT TO THE WINDOW.
   *
   * `clip-path: inset()` is measured from the element's own border box, and `setViewport` is
   * measured from the drawing buffer's bottom-left — both of which are the canvas. The first
   * version used `innerWidth`/`innerHeight` for both, which is the same thing ONLY when the canvas
   * fills the window.
   *
   * Embedded in the world editor it does not: the canvas is a pane with a bar above it and an
   * inspector beside it. So the clip was inset by the window's margins and the GL viewport was
   * offset by the pane's own position — the preview came out shifted, clipped down one side, and
   * with the dialog's dark backdrop showing over the parts the clip had wrongly excluded. Rich,
   * 2026-09-29: *"half the screen is covered"*, *"the dark mask and blur is over top of the
   * preview"*. `resize()` in `main.ts` already carries the same warning about the same trap.
   */
  /**
   * Put the preview window over the CANVAS, not over the page.
   *
   * `.preview` is `position: fixed; inset: 0`, which is the whole window — and the canvas is not.
   * Embedded in the world editor it stops at the inspector (`width: calc(100vw - inspector-w)`),
   * so the right-hand strip of the preview had no canvas underneath it to reveal: the clip could
   * only show canvas pixels, and beyond its edge you saw the inspector through the scrim. Rich,
   * 2026-09-29: *"the right panel is still covering the right part of the preview under the
   * scrim"*.
   *
   * Clamping the viewport instead would leave the toolbar and the help line stretched across a
   * width the picture cannot fill. Moving the WHOLE window onto the canvas keeps them together.
   * On the standalone page the canvas is the window, so this changes nothing there.
   */
  private frameToCanvas() {
    const c = this.canvas.getBoundingClientRect()
    const box = `${c.left}px ${c.top}px ${c.width}px ${c.height}px`
    if (box === this.framed) return
    this.framed = box
    const d = this.dlg.style
    d.left = `${c.left}px`
    d.top = `${c.top}px`
    d.right = 'auto'
    d.bottom = 'auto'
    d.width = `${c.width}px`
    d.height = `${c.height}px`
  }

  private clip() {
    this.frameToCanvas()
    const css = insetOf(this.canvas.getBoundingClientRect(), this.viewport.getBoundingClientRect())
    if (css !== this.clipped) {
      this.canvas.style.clipPath = css
      this.clipped = css
    }
  }

  render(renderer: THREE.WebGLRenderer) {
    if (!this.open) return
    const r = this.viewport.getBoundingClientRect()
    if (r.width < 8 || r.height < 8) return
    this.clip()
    const c = this.canvas.getBoundingClientRect()
    const vp = viewportOf(c, r)
    this.camera.aspect = r.width / r.height
    this.camera.updateProjectionMatrix()
    renderer.setViewport(vp.x, vp.y, vp.w, vp.h)
    renderer.setScissor(vp.x, vp.y, vp.w, vp.h)
    renderer.setScissorTest(true)
    renderer.render(this.scene, this.camera)
    renderer.setScissorTest(false)
    renderer.setViewport(0, 0, Math.max(1, c.width), Math.max(1, c.height))
  }
}


/* ================================================================================================
 * The two rectangles, extracted so they can be checked without a browser.
 *
 * This is the whole of the bug Rich hit — a clip and a viewport computed in the wrong frame — and
 * it is four subtractions. Four subtractions that need a WebGL context, a loaded site and a
 * screenshot to verify is four subtractions nobody verifies, which is how they were wrong.
 * ============================================================================================= */

export interface Rect { left: number; top: number; right: number; bottom: number; width: number; height: number }

/**
 * The `clip-path: inset(…)` that shows only `view`, in the CANVAS's own frame.
 *
 * `inset()` measures from the element's border box. Measuring from the window instead is correct
 * only when the canvas fills it.
 */
export function insetOf(canvas: Rect, view: Rect): string {
  return `inset(${view.top - canvas.top}px ${canvas.right - view.right}px ${canvas.bottom - view.bottom}px ${view.left - canvas.left}px)`
}

/**
 * The GL viewport that draws into `view`, in the drawing buffer's frame.
 *
 * GL counts from the BOTTOM left of the buffer, which is the canvas — hence `canvas.bottom` rather
 * than the window's height.
 */
export function viewportOf(canvas: Rect, view: Rect): { x: number; y: number; w: number; h: number } {
  return { x: view.left - canvas.left, y: canvas.bottom - view.bottom, w: view.width, h: view.height }
}


/**
 * The stacking level of a modal, from the design tokens.
 *
 * Read rather than assumed, so this cannot drift from `tokens.css` again. The fallback is the
 * value that token has today, which keeps the preview working if the stylesheet has not loaded.
 */
function modalZ(): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--z-modal')
  const n = Number(v.trim())
  return Number.isFinite(n) && n > 0 ? n : 50
}
