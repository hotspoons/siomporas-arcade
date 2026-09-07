// The craft. Two regimes: on-track (state is track-space (s, theta), speed and
// theta velocity) and airborne (world position + velocity under G_AIR, with
// the track re-acquired by projection every tick). Nothing here allocates.

import {
  ACCEL,
  AIR_CENTERING_C,
  AIR_CENTERING_K,
  AIR_G_SCALE_MAX,
  AIR_G_SCALE_MIN,
  AIR_LIFT_AUTHORITY,
  AIR_STRAFE_AUTHORITY,
  GAP_DESIGN_SPEED,
  LAUNCH_LATERAL_MAX,
  BANK_RATE,
  BANK_VISUAL_MAX,
  BOOST_ACCEL,
  BOOST_DECAY,
  BRAKE_DECEL,
  COLLISION_SPIN_TIME,
  DRAG_TO_CRUISE,
  EDGE_BOUNCE,
  FALL_DEPTH,
  FALL_GRACE,
  G_AIR,
  LAND_ALIGN_TIME,
  LAND_SPEED_KEEP_MIN,
  LAND_TOLERANCE,
  LAND_UNDERSHOOT,
  REACQUIRE_RANGE,
  SCRAPE_SHIELD_PER_SEC,
  SCRAPE_SPEED_LOSS,
  SPEED_BOOST_MAX,
  SPEED_CRUISE,
  SPEED_MAX,
  SPEED_MIN,
  THETA_ACCEL,
  THETA_DAMP,
  THETA_SPEED_FALLOFF,
  THETA_VEL_MAX,
  TUNNEL_RADIUS_DEFAULT,
  VEHICLE_HOVER,
} from '../Tuning'
import { clamp, expApproach, lerp, moveToward, wrapAngle } from '@apex/engine/math/scalar'
import { Vec3 } from '@apex/engine/math/Vec3'
import type { InputFrame } from '../InputFrame'
import { Track } from '../track/Track'
import { makeFrame, type Frame, type TrackPoint } from '../track/TrackSpline'
import { hasSurface } from '../track/TrackProfile'

export type VehicleEvent = 'none' | 'launched' | 'landed' | 'crashed' | 'fell'

export class Vehicle {
  // --- track-space state ---
  s = 0
  theta = 0
  speed = SPEED_CRUISE
  thetaVel = 0
  branch = 0
  /** True while riding a boost strip this tick (set by SimWorld). */
  onBoost = false
  /** True while pressed against an open profile's edge this tick. */
  scraping = false

  // --- air state ---
  airborne = false
  readonly worldPos = new Vec3()
  readonly worldVel = new Vec3()
  /** Craft up vector while airborne (world). */
  readonly airUp = new Vec3(0, 1, 0)
  airTime = 0
  /** Seconds since leaving an OPEN edge sideways; the fall commits after FALL_GRACE. */
  fallTimer = 0
  falling = false

  // --- presentation-facing but sim-owned ---
  /** Visual roll into turns (rad). */
  bank = 0
  /** Barrel-spin progress after a collision, 0 = none, counts down. */
  spinTimer = 0
  spinDir = 1
  /** Landing alignment blend 1→0 after touchdown. */
  alignTimer = 0

  /** Set each tick; consumed by SimWorld for events/VFX. */
  event: VehicleEvent = 'none'

  // --- derived world pose (valid after tick) ---
  readonly pos = new Vec3()
  readonly forward = new Vec3(0, 0, 1)
  readonly up = new Vec3(0, 1, 0)
  readonly right = new Vec3(1, 0, 0)

  private readonly frame = makeFrame()
  private readonly vA = new Vec3()
  private readonly vB = new Vec3()
  private readonly tp: TrackPoint = { s: 0, theta: 0, radial: 0 }

  reset(): void {
    this.s = 0
    this.theta = 0
    this.speed = SPEED_CRUISE
    this.thetaVel = 0
    this.branch = 0
    this.onBoost = false
    this.scraping = false
    this.airborne = false
    this.airTime = 0
    this.fallTimer = 0
    this.falling = false
    this.bank = 0
    this.spinTimer = 0
    this.alignTimer = 0
    this.event = 'none'
    this.worldVel.set(0, 0, 0)
  }

  /** Drop back onto the track surface at the current arc length, slow and upright. Never ends the run. */
  recoverOnTrack(track: Track): void {
    this.airborne = false
    this.falling = false
    this.fallTimer = 0
    this.theta = 0
    this.thetaVel = 0
    this.speed = SPEED_MIN
    this.spinTimer = 0
    this.alignTimer = 0
    // If the surface here is missing (mid-gap), walk forward to the next surface.
    for (let tries = 0; tries < 200; tries++) {
      const f = track.frameAt(this.s, this.branch, this.frame)
      if (hasSurface(f.arc)) break
      this.s += 5
    }
    this.branch = track.splitAt(this.s) ? this.branch : 0
    this.updatePose(track)
  }

  /** Called by the collision system. Slows, spins, never stops. */
  applyCollision(speedKeep: number, spinDir: number): void {
    this.speed = Math.max(SPEED_MIN * 0.85, this.speed * speedKeep)
    this.spinTimer = COLLISION_SPIN_TIME
    this.spinDir = spinDir
    this.thetaVel += spinDir * 1.4
  }

  tick(dt: number, input: InputFrame, track: Track, speedScale: number, shieldDrain: (amount: number) => void): void {
    this.event = 'none'
    if (this.airborne) this.tickAir(dt, input, track)
    else this.tickGround(dt, input, track, speedScale, shieldDrain)
    if (this.spinTimer > 0) this.spinTimer = Math.max(0, this.spinTimer - dt)
    if (this.alignTimer > 0) this.alignTimer = Math.max(0, this.alignTimer - dt / LAND_ALIGN_TIME)
    this.updatePose(track)
  }

  // ---------------------------------------------------------------------------

  private tickGround(dt: number, input: InputFrame, track: Track, speedScale: number, shieldDrain: (amount: number) => void): void {
    const f = track.frameAt(this.s, this.branch, this.frame)
    const speedMax = SPEED_MAX * speedScale
    const boostMax = SPEED_BOOST_MAX * speedScale

    // --- speed ---
    if (this.onBoost) {
      this.speed = moveToward(this.speed, boostMax, BOOST_ACCEL * dt)
    } else if (this.speed > speedMax) {
      this.speed = moveToward(this.speed, speedMax, BOOST_DECAY * dt)
    } else if (input.throttle > input.brake) {
      this.speed = moveToward(this.speed, speedMax, ACCEL * input.throttle * dt)
    } else if (input.brake > 0) {
      this.speed = moveToward(this.speed, SPEED_MIN, BRAKE_DECEL * input.brake * dt)
    } else {
      this.speed = moveToward(this.speed, SPEED_CRUISE, DRAG_TO_CRUISE * dt)
    }

    // --- steering ---
    // Authority falls with speed but never to zero, and is normalised to the
    // default radius so a fat cavern and a tight pipe move the craft the same
    // number of metres per second of stick.
    const speedT = clamp((this.speed - SPEED_CRUISE) / (SPEED_MAX - SPEED_CRUISE), 0, 1)
    const falloff = lerp(1, THETA_SPEED_FALLOFF, speedT)
    const radiusScale = TUNNEL_RADIUS_DEFAULT / f.radius
    const spinning = this.spinTimer > 0
    const steer = spinning ? input.steer * 0.35 : input.steer
    this.thetaVel += steer * THETA_ACCEL * falloff * radiusScale * dt
    this.thetaVel = expApproach(this.thetaVel, 0, THETA_DAMP, dt)
    const velMax = THETA_VEL_MAX * radiusScale
    this.thetaVel = clamp(this.thetaVel, -velMax, velMax)
    this.theta += this.thetaVel * dt

    // --- profile clamp / edge ---
    this.scraping = false
    const clampAngle = track.clampAt(this.s, this.branch)
    if (Number.isFinite(clampAngle)) {
      if (this.theta > clampAngle || this.theta < -clampAngle) {
        const sign = this.theta > 0 ? 1 : -1
        const outward = this.thetaVel * sign > 0
        const pushing = input.steer * sign > 0.5
        if (f.arc < 1.2 && pushing) {
          // OPEN roadway: keep pushing into the lip and you go over it.
          this.fallTimer += dt
          if (this.fallTimer > FALL_GRACE) {
            this.thetaVel = sign * 1.2
            this.launch(track, true)
            return
          }
        } else {
          this.fallTimer = Math.max(0, this.fallTimer - dt * 2)
        }
        this.theta = sign * clampAngle
        if (outward) this.thetaVel *= EDGE_BOUNCE
        this.scraping = true
        this.speed = Math.max(SPEED_MIN, this.speed - SCRAPE_SPEED_LOSS * dt)
        shieldDrain(SCRAPE_SHIELD_PER_SEC * dt)
      } else {
        this.fallTimer = 0
      }
    } else {
      this.theta = wrapAngle(this.theta)
      this.fallTimer = 0
    }

    // --- advance ---
    const sPrev = this.s
    this.s += this.speed * dt

    // --- splits: commit on entry, rejoin on exit ---
    const splitNow = track.splitAt(this.s)
    const splitBefore = track.splitAt(sPrev)
    if (splitNow && !splitBefore) {
      this.branch = Track.branchFor(this.theta)
      // Both branches are level tubes sharing a floor; keep theta.
    } else if (!splitNow && splitBefore) {
      this.branch = 0
    }

    // --- leaving the surface ---
    const fNow = track.frameAt(this.s, this.branch, this.frame)
    if (!hasSurface(fNow.arc)) {
      this.launch(track, false)
      return
    }

    // --- visual bank ---
    const targetBank = clamp(-this.thetaVel * 0.22, -BANK_VISUAL_MAX, BANK_VISUAL_MAX)
    this.bank = expApproach(this.bank, targetBank, BANK_RATE, dt)
  }

  /** Convert track state to a free-flying body. */
  private launch(track: Track, falling: boolean): void {
    const f = track.frameAt(this.s, this.branch, this.frame)
    Track.surfaceFromFrame(f, this.theta, VEHICLE_HOVER, this.worldPos, this.vA)
    // Velocity: forward along the tangent plus the lateral component of the
    // theta motion (so a sideways fall actually goes sideways).
    Track.radial(f, this.theta, this.vA)
    this.vB.cross(f.tan, this.vA) // tangential direction around the tube at theta
    const lateral = clamp(-this.thetaVel * f.radius, -LAUNCH_LATERAL_MAX, LAUNCH_LATERAL_MAX)
    this.worldVel.copy(f.tan).scale(this.speed).addScaled(this.vB, lateral)
    this.airUp.copy(this.vA).scale(-1)
    this.airborne = true
    this.airTime = 0
    this.falling = falling
    this.fallTimer = 0
    this.event = falling ? 'fell' : 'launched'
  }

  private tickAir(dt: number, input: InputFrame, track: Track): void {
    this.airTime += dt
    // Gravity scaled so the arc shape is speed-independent (see Tuning).
    const speed = this.worldVel.length()
    const gScale = clamp((speed / GAP_DESIGN_SPEED) ** 2, AIR_G_SCALE_MIN, AIR_G_SCALE_MAX)
    const g = G_AIR * gScale
    if (speed > 1) {
      this.forward.copy(this.worldVel).scale(1 / speed)
      this.right.cross(this.forward, this.airUp).normalize()
      // Light air control: lift as a fraction of gravity, strafe as an acceleration.
      if (input.pitch !== 0) this.worldVel.addScaled(this.airUp, input.pitch * AIR_LIFT_AUTHORITY * g * dt)
      if (input.steer !== 0) this.worldVel.addScaled(this.right, input.steer * AIR_STRAFE_AUTHORITY * Math.sqrt(gScale) * dt)
    }
    this.worldVel.y -= g * dt
    this.worldPos.addScaled(this.worldVel, dt)
    // Roll the craft's up gently back toward world up during flight.
    this.airUp.x = expApproach(this.airUp.x, 0, 2, dt)
    this.airUp.y = expApproach(this.airUp.y, 1, 2, dt)
    this.airUp.z = expApproach(this.airUp.z, 0, 2, dt)
    this.airUp.normalize()
    this.bank = expApproach(this.bank, clamp(-input.steer * 0.35, -BANK_VISUAL_MAX, BANK_VISUAL_MAX), BANK_RATE, dt)
    this.speed = this.worldVel.length()

    // Re-acquire the track. Search a window around the last known s, biased
    // ahead since we fly forward.
    const guess = this.s + Math.max(0, this.forward.dot(this.frame.tan)) * this.speed * dt
    track.project(this.worldPos, guess + REACQUIRE_RANGE * 0.4, REACQUIRE_RANGE, this.branch, this.frame, this.tp)
    const p = this.tp
    this.s = Math.max(this.s, p.s) // never go backwards along the course
    const f = track.frameAt(p.s, this.branch, this.frame)

    // Centring assist: with no steer input, spring the flight back over the
    // centreline sideways (never vertically — that's the player's arc).
    if (Math.abs(input.steer) < 0.2 && !this.falling) {
      const lateralOffset = p.radial * Math.sin(p.theta) // along bin
      const lateralVel = this.worldVel.dot(f.bin)
      this.worldVel.addScaled(f.bin, (-AIR_CENTERING_K * lateralOffset - AIR_CENTERING_C * lateralVel) * dt)
    }

    const surface = hasSurface(f.arc)
    const withinArc = Math.abs(wrapAngle(p.theta)) <= f.arc
    // Radial velocity: positive = moving toward the wall.
    Track.radial(f, p.theta, this.vA)
    const radialVel = this.worldVel.dot(this.vA)

    if (surface && withinArc && p.radial >= f.radius - VEHICLE_HOVER - LAND_TOLERANCE && radialVel > -5) {
      if (p.radial <= f.radius + LAND_UNDERSHOOT) {
        // Below the surface = clipped the lip: land anyway, pay in speed.
        if (p.radial > f.radius) this.speed *= 0.85
        this.land(f, p)
        return
      }
    }
    if (p.radial > f.radius + FALL_DEPTH || (surface && withinArc && p.radial > f.radius + LAND_UNDERSHOOT && this.airTime > 0.3)) {
      // Way outside the tube, or through the wall from outside: gone.
      this.event = 'crashed'
      return
    }
  }

  private land(f: Frame, p: TrackPoint): void {
    this.airborne = false
    this.falling = false
    this.s = p.s
    this.theta = wrapAngle(p.theta)
    const forwardSpeed = this.worldVel.dot(f.tan)
    // Angle-dependent dock: a flat landing keeps nearly everything.
    const total = this.worldVel.length() || 1
    const flatness = clamp(Math.abs(forwardSpeed) / total, 0, 1)
    const keep = lerp(LAND_SPEED_KEEP_MIN, 1, flatness)
    this.speed = clamp(Math.abs(forwardSpeed) * keep, SPEED_MIN, SPEED_BOOST_MAX)
    // Lateral speed around the tube carries into theta velocity.
    Track.radial(f, this.theta, this.vA)
    this.vB.cross(f.tan, this.vA)
    this.thetaVel = clamp(-this.worldVel.dot(this.vB) / f.radius, -THETA_VEL_MAX, THETA_VEL_MAX)
    this.alignTimer = 1
    this.event = 'landed'
  }

  private updatePose(track: Track): void {
    if (this.airborne) {
      this.pos.copy(this.worldPos)
      const sp = this.worldVel.length()
      if (sp > 1) this.forward.copy(this.worldVel).scale(1 / sp)
      this.up.copy(this.airUp)
      this.right.cross(this.forward, this.up).normalize()
      this.up.cross(this.right, this.forward).normalize()
      return
    }
    const f = track.frameAt(this.s, this.branch, this.frame)
    Track.surfaceFromFrame(f, this.theta, VEHICLE_HOVER, this.pos, this.vA)
    Track.radial(f, this.theta, this.vA)
    this.up.copy(this.vA).scale(-1)
    this.forward.copy(f.tan)
    // Landing alignment: the craft's forward/up eases from the flight pose.
    if (this.alignTimer > 0) {
      const t = this.alignTimer
      this.forward.lerpVectors(this.forward, this.vB.copy(this.worldVel).normalize(), t * 0.6).normalize()
      this.up.lerpVectors(this.up, this.airUp, t * 0.6).normalize()
    }
    this.right.cross(this.forward, this.up).normalize()
    this.up.cross(this.right, this.forward).normalize()
  }
}
