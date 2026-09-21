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
import { Car, type CarInput } from '../car'
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
  private car: Car | null = null
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
    const close = el('button', 'danger')
    close.textContent = 'close (Esc)'
    close.onclick = () => this.hide()
    bar.append(title, modeBtn, reset, season, close)
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
    // The canvas lives BEHIND the page, so an 82%-opaque backdrop over the dialog dims the
    // preview along with everything else — the first version came out looking like night. Lift
    // the canvas above the backdrop and clip it to the dialog's hole instead, so the surround
    // stays dark and the preview is drawn at full strength. `pointer-events: none` hands the
    // drag back to `.pv-view` underneath it.
    this.canvas.style.zIndex = '21'
    this.canvas.style.pointerEvents = 'none'
    this.clip()
    this.reset()
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
      this.car = null
    }
    this.open = false
    this.keys.clear()
    this.dlg.style.display = 'none'
    this.canvas.style.zIndex = ''
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
      if (!this.car) {
        this.car = new Car({ heightAt: this.site.groundAt, edgeDistance: this.site.edgeDistance, treesNear: this.site.treesNear })
        this.scene.add(this.car.mesh)
      }
      const side = p.dir.clone().cross(UP).multiplyScalar(1.83)
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
      // fixed sub-steps: the car model is stuntin's and it is tuned at 120 Hz
      for (let acc = dt; acc > 0; acc -= 1 / 120) this.car.tick(Math.min(acc, 1 / 120), this.input)
      const car = this.car
      const back = car.forward.clone().applyAxisAngle(UP, this.look.yaw).multiplyScalar(-T.CHASE_BACK)
      const want = car.pos.clone().add(back).add(new THREE.Vector3(0, T.CHASE_UP + Math.tan(this.look.pitch) * 4, 0))
      const ground = this.site.groundAt(want.x, want.z)
      if (ground != null) want.y = Math.max(want.y, ground + 1.2)
      this.camera.position.lerp(want, Math.min(1, T.CHASE_LAG * dt))
      this.camera.lookAt(car.pos.clone().add(car.forward.clone().multiplyScalar(T.CHASE_LOOK_AHEAD)).add(new THREE.Vector3(0, 1, 0)))
      this.hud.textContent = `${(Math.abs(car.speed) * 2.237).toFixed(0)} mph   ${car.onGrass ? 'grass' : 'pavement'}${Math.abs(car.slide) > 1 ? '   sliding' : ''}`
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
  private clip() {
    const r = this.viewport.getBoundingClientRect()
    const css = `inset(${r.top}px ${innerWidth - r.right}px ${innerHeight - r.bottom}px ${r.left}px)`
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
    const y = innerHeight - r.bottom
    this.camera.aspect = r.width / r.height
    this.camera.updateProjectionMatrix()
    renderer.setViewport(r.left, y, r.width, r.height)
    renderer.setScissor(r.left, y, r.width, r.height)
    renderer.setScissorTest(true)
    renderer.render(this.scene, this.camera)
    renderer.setScissorTest(false)
    renderer.setViewport(0, 0, innerWidth, innerHeight)
  }
}
