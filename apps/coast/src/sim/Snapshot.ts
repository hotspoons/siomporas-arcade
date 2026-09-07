import { TRAFFIC_COUNT } from './Tuning'

export type RunPhase = 'driving' | 'crashed' | 'finished' | 'timeout'

export class Snapshot {
  time = 0
  tick = 0
  phase: RunPhase = 'driving'
  /** Player position along the current stage, metres. */
  z = 0
  /** Lateral position, road widths (±1 = edge). */
  x = 0
  speed = 0
  maxSpeed = 1
  /** Visual steer -1..1 (for the car sprite frame / wheel). */
  steer = 0
  /** Tumble progress 0..1 while crashed. */
  crashT = 0
  /** Which stage (index into the route) we are on and its id. */
  stageIndex = 0
  stageId = 'A'
  /** Camera x offset accumulated from curves (renderer parallax). */
  curveAccum = 0
  readonly hud = {
    time: 0,
    score: 0,
    gear: 1 as 0 | 1,
    turbo: 1,
    turboActive: false,
    stage: 1,
    stagesTotal: 3,
    speedKmh: 0,
    checkpointFlash: 0,
    route: '' as string,
  }
  trafficCount = 0
  readonly trafficZ = new Float32Array(TRAFFIC_COUNT)
  readonly trafficX = new Float32Array(TRAFFIC_COUNT)
  readonly trafficKind = new Uint8Array(TRAFFIC_COUNT)
  readonly trafficSpeed = new Float32Array(TRAFFIC_COUNT)
  /** Fork choice hint: -1 left, +1 right, 0 none (for the HUD arrow during the split). */
  forkSide = 0
  forkT = -1
}
