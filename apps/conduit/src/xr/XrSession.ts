// WebXR lifecycle and everything that must change when a headset is on:
// post stack off, retro cadence and CRT off (enforced here, in code), FOV left
// to the runtime, camera up world-stable, cockpit + in-world HUD on, comfort
// vignette driven by acceleration, controllers read as an input source, and
// haptics for impacts.

import { Group } from 'three'
import type { Game } from '../app/Game'
import type { InputFrame } from '../sim/InputFrame'
import type { SimSnapshot } from '../sim/SimSnapshot'
import type { ExtraSource, UiEdges } from '../input/InputMap'
import { shapeAxis } from '../input/bindings'
import { buildCockpit, COMFORT_PRESETS, Vignette } from './Comfort'
import { XrHud } from './XrHud'

const MPH_PER_MS = 2.23694

class XrControllers implements ExtraSource {
  session: XRSession | null = null
  private prevButtons = new Map<number, Uint8Array>()

  apply(frame: InputFrame, ui: UiEdges): void {
    const session = this.session
    if (!session) return
    let i = 0
    for (const src of session.inputSources) {
      const gp = src.gamepad
      if (!gp) continue
      const prev = this.prevButtons.get(i) ?? new Uint8Array(8)
      const cur = new Uint8Array(8)
      for (let b = 0; b < Math.min(8, gp.buttons.length); b++) cur[b] = gp.buttons[b].pressed ? 1 : 0
      const pressed = (b: number) => cur[b] === 1 && prev[b] === 0
      // xr-standard: axes[2..3] thumbstick, buttons: 0 trigger, 1 squeeze, 3 stick, 4 A/X, 5 B/Y
      const stickX = shapeAxis(gp.axes[2] ?? 0)
      const stickY = shapeAxis(gp.axes[3] ?? 0)
      const trigger = gp.buttons[0]?.value ?? 0
      if (src.handedness === 'left') {
        frame.steer = Math.max(-1, Math.min(1, frame.steer + stickX))
        frame.pitch = Math.max(-1, Math.min(1, frame.pitch - stickY))
        frame.brake = Math.max(frame.brake, trigger)
        if (pressed(4) || pressed(5)) ui.pause = true
      } else {
        frame.throttle = Math.max(frame.throttle, trigger)
        frame.fire = frame.fire || (gp.buttons[4]?.pressed ?? false) || (gp.buttons[1]?.pressed ?? false)
        if (pressed(5)) frame.shockwave = true
        if (pressed(4)) ui.confirm = true
        if (pressed(5)) ui.back = true
        if (stickY < -0.6 && !prev[6]) ui.menuUp = true
        if (stickY > 0.6 && !prev[7]) ui.menuDown = true
        cur[6] = stickY < -0.6 ? 1 : 0
        cur[7] = stickY > 0.6 ? 1 : 0
      }
      this.prevButtons.set(i, cur)
      i++
    }
  }

  pulse(intensity: number, ms: number): void {
    if (!this.session) return
    for (const src of this.session.inputSources) {
      const act = (src.gamepad as (Gamepad & { hapticActuators?: { pulse?: (i: number, ms: number) => Promise<boolean> }[] }) | null | undefined)?.hapticActuators?.[0]
      try {
        void act?.pulse?.(intensity, ms)
      } catch {
        /* unsupported */
      }
    }
  }
}

export class XrSession {
  active = false
  supported = false
  private session: XRSession | null = null
  private readonly game: Game
  private readonly cockpit: Group
  private readonly vignette = new Vignette()
  private readonly hud = new XrHud()
  private readonly controllers = new XrControllers()
  private lastSpeed = 0
  private lastThetaVel = 0
  private stress = 0

  constructor(game: Game) {
    this.game = game
    this.cockpit = buildCockpit()
    this.cockpit.add(this.hud.mesh)
    game.view.cameraRoot.add(this.cockpit)
    game.view.rig.camera.add(this.vignette.mesh)
    void this.probe()
  }

  private async probe(): Promise<void> {
    try {
      this.supported = Boolean(navigator.xr && (await navigator.xr.isSessionSupported('immersive-vr')))
    } catch {
      this.supported = false
    }
  }

  async enter(): Promise<boolean> {
    if (this.active || !navigator.xr) return false
    try {
      const session = await navigator.xr.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'bounded-floor', 'layers'],
      })
      const renderer = this.game.view.renderer
      renderer.xr.enabled = true
      renderer.xr.setReferenceSpaceType('local-floor')
      renderer.xr.setFoveation(1)
      await renderer.xr.setSession(session)
      this.session = session
      this.active = true
      this.controllers.session = session
      this.game.input.extras.push(this.controllers)
      session.addEventListener('end', () => this.onEnd())
      this.applyState()
      return true
    } catch (err) {
      console.warn('XR session failed', err)
      return false
    }
  }

  exit(): void {
    void this.session?.end()
  }

  private onEnd(): void {
    this.session = null
    this.active = false
    this.controllers.session = null
    const i = this.game.input.extras.indexOf(this.controllers)
    if (i >= 0) this.game.input.extras.splice(i, 1)
    this.game.view.renderer.xr.enabled = false
    this.applyState()
  }

  /** Enforce every XR-vs-flat rule in one place. */
  private applyState(): void {
    const g = this.game
    const rig = g.view.rig
    g.view.setXr(this.active)
    rig.xrRig = this.active ? g.view.cameraRoot : null
    rig.xrRollBlend = g.settings.data.vr.rollBlend
    if (!this.active) {
      g.view.cameraRoot.position.set(0, 0, 0)
      g.view.cameraRoot.quaternion.identity()
    }
    this.cockpit.visible = this.active
    this.hud.mesh.visible = this.active
    g.hud.setVisible(!this.active && g.state !== 'title')
    g.world.params.speedScale = this.active ? this.preset().speedScale : 1
    g.world.params.aimConeScale = this.active ? this.preset().aimConeScale : 1
    // Cadence + post: applyStyle consults `active`.
    g.applyStyle()
    g.applyAccessibility()
  }

  preset() {
    return COMFORT_PRESETS[this.game.settings.data.vr.comfort]
  }

  visualGain(): number {
    return this.preset().visualGain * this.game.settings.data.visualSpeedGain
  }

  /** Called every rendered frame. */
  update(snap: SimSnapshot, dt: number): void {
    if (!this.active) return
    const v = snap.vehicle
    // Stress from angular and longitudinal acceleration.
    const dv = Math.abs(v.speed - this.lastSpeed) / Math.max(dt, 1e-3)
    const dw = Math.abs(v.thetaVel - this.lastThetaVel) / Math.max(dt, 1e-3)
    this.lastSpeed = v.speed
    this.lastThetaVel = v.thetaVel
    const target = Math.min(1, dv / 120 + dw / 14 + Math.abs(v.thetaVel) / 3.2 + (v.spin > 0 ? 0.6 : 0))
    this.stress += (target - this.stress) * Math.min(1, dt * 8)
    this.vignette.update(this.stress, this.preset().vignette, dt)
    this.hud.update(snap, dt, this.game.view.interpolated.speed * MPH_PER_MS)
  }

  haptic(intensity: number, ms: number): void {
    if (this.active) this.controllers.pulse(intensity, ms)
  }
}
