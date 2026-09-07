// What the renderer/HUD read. Copied every tick; double-buffered by the loop.

import { Vec3 } from '@apex/engine/math/Vec3'

export type CarMode = 'track' | 'air' | 'ground'
export type RunPhase = 'driving' | 'replay' | 'finished'

export class Snapshot {
  time = 0
  tick = 0
  phase: RunPhase = 'driving'
  readonly car = {
    pos: new Vec3(),
    forward: new Vec3(1, 0, 0),
    up: new Vec3(0, 1, 0),
    speed: 0,
    /** Front wheel steer angle, radians. */
    steer: 0,
    /** Accumulated wheel rotation, radians. */
    wheelSpin: 0,
    mode: 'track' as CarMode,
    laneId: -1,
    s: 0,
    lateral: 0,
    /** Tyre slip 0..1, for screech and skid marks. */
    slip: 0,
    braking: false,
    onGrass: false,
    throttle: 0,
  }
  readonly hud = {
    speed: 0,
    lapTime: 0,
    lastLap: 0,
    bestLap: 0,
    laps: 0,
    crashes: 0,
    gear: 1,
    rpm: 0,
  }
  /** Fixed trackside camera for the crash replay. */
  readonly replayCam = new Vec3()
  readonly replayLook = new Vec3()
  replayT = 0
}
