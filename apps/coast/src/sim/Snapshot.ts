import { TRAFFIC_TOTAL } from './Tuning'

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
  /** The current crash is a full wreck (head-on / side impact): long roll. */
  wreck = false
  /** Height of the car above the road while airborne over a crest (metres); 0 on the ground. */
  airY = 0
  /** Manual switches. */
  wipersOn = false
  lightsOn = false
  /** Which stage (index into the route) we are on and its id. */
  stageIndex = 0
  stageId = 'A'
  /** Camera x offset accumulated from curves (renderer parallax). */
  curveAccum = 0
  /** How dark and how wet it is right here, 0..1 (a vibe can slide from dusk into night mid-stage). */
  night = 0
  rain = 0
  readonly hud = {
    time: 0,
    score: 0,
    gear: 1 as 0 | 1,
    /** Engine revs 0..1 for the tacho and the engine note. */
    rpm: 0,
    turbo: 6,
    turboMax: 6,
    turboActive: false,
    stage: 1,
    stagesTotal: 3,
    speedKmh: 0,
    checkpointFlash: 0,
    route: '' as string,
    wipers: false,
    lights: false,
  }
  trafficCount = 0
  readonly trafficZ = new Float32Array(TRAFFIC_TOTAL)
  readonly trafficX = new Float32Array(TRAFFIC_TOTAL)
  readonly trafficKind = new Uint8Array(TRAFFIC_TOTAL)
  readonly trafficSpeed = new Float32Array(TRAFFIC_TOTAL)
  /** View yaw of each car's sprite: 0 seen from behind, 180 head-on, ±90 crossing. */
  readonly trafficYaw = new Int16Array(TRAFFIC_TOTAL)
  /** Fork choice hint: -1 left, +1 right, 0 none (for the HUD arrow during the split). */
  forkSide = 0
  forkT = -1
}
