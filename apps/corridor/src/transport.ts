// A library of ways to get about: on foot, in a helicopter, in a plane, in a jet, in a UFO.
//
// Rich, 2026-09-27: "Definitely need a first person and third person character mode... Also basic
// helic/omnic/ornith-opter and jet and plane and UFO flying dynamics too so we have a library of
// interaction types."
//
// A LIBRARY, not a mode switch. The program layer names a transport (`api.transport('helicopter')`)
// and that has to mean a different set of physics, not a different speed constant — the whole
// point of the list is that a helicopter hovers, a plane stalls, a UFO has no inertia and an
// ornithopter falls between wingbeats. Six kinds that all move the camera at 30 m/s would be one
// kind with six names.
//
// PURE NUMBERS. No THREE, no camera, no input events: a craft takes a state and a set of controls
// and returns the next state. `transportcam.ts` is the thin thing that reads the keyboard and puts
// the result on the camera. That split is what makes "does a plane actually stall" a question with
// an answer — flight models are the exact kind of code that feels wrong for a week before anybody
// works out which term is missing, and feeling is not a test.
//
// FRAME: three.js world coordinates, because that is where the camera lives — x east, y UP,
// z south (the site's north is -z). Yaw is measured about +y, 0 facing -z (north), increasing to
// the east, which is what `Math.atan2(x, -z)` gives.

export interface Vec3 { x: number; y: number; z: number }

/** What a person is asking the craft to do, each in -1..1 unless said otherwise. */
export interface Controls {
  /** forward on the stick: nose down positive, as a stick is */
  pitch: number
  /** roll right positive */
  roll: number
  /** rudder or pedals, right positive */
  yaw: number
  /** 0..1 — engine, collective, or how hard you are walking */
  throttle: number
  /** direct up/down for the craft that have it (UFO, omnicopter) */
  lift: number
  /** afterburner, sprint, jump */
  boost: boolean
  /** brake, air brake, or crouch */
  brake: boolean
}

export const NEUTRAL: Controls = { pitch: 0, roll: 0, yaw: 0, throttle: 0, lift: 0, boost: false, brake: false }

export interface CraftState {
  at: Vec3
  vel: Vec3
  /** radians. yaw about +y (0 = north), pitch nose-up positive, roll right-wing-down positive */
  yaw: number
  pitch: number
  roll: number
  /** whatever the craft wants to remember between steps: rotor speed, wing phase, stall flag */
  phase: number
  stalled: boolean
  grounded: boolean
}

export interface World {
  /** ground height at a world x, z, or null where there is no data */
  groundAt: (x: number, z: number) => number | null
  /** m/s², positive down */
  gravity?: number
}

export const G = 9.81

/** Every craft's tuning, in the units the numbers mean. */
export interface CraftSpec {
  name: string
  /** one line, for the picker */
  note: string
  /** kilograms — only ever used as a ratio, but a ratio of real numbers */
  massKg: number
  /** maximum thrust, newtons */
  thrustN: number
  /** how fast the controls move the attitude, radians per second at full deflection */
  rate: { pitch: number; roll: number; yaw: number }
  /** drag coefficient × area, as one number: force = drag × v² */
  drag: number
  /** lift per unit of (v² × angle of attack), for the wings that have them */
  lift: number
  /** below this airspeed a wing stops working, m/s. 0 for the craft that do not care. */
  stallMs: number
  /** how fast the attitude returns to level when the stick is centred, per second */
  damping: number
  /** height above the ground it refuses to go below, metres */
  clearance: number
  /** true for anything that can hold a hover */
  hovers: boolean
}

/**
 * The library.
 *
 * The numbers are the real ones where a real one exists — a Robinson R22 is 620 kg and about
 * 7.5 kN of rotor thrust, an F-16 is 12 000 kg and 76 kN dry — because a helicopter that weighs
 * 1 and thrusts 2 flies like nothing, and there is no way to tell whether it is right.
 */
export const CRAFT = {
  walk: {
    name: 'on foot',
    note: 'first person, at a walk',
    massKg: 80, thrustN: 800, rate: { pitch: 0, roll: 0, yaw: 2.4 }, drag: 6, lift: 0,
    stallMs: 0, damping: 12, clearance: 1.7, hovers: false,
  },
  'walk-third': {
    name: 'third person',
    note: 'the same character, seen from behind',
    massKg: 80, thrustN: 800, rate: { pitch: 0, roll: 0, yaw: 2.4 }, drag: 6, lift: 0,
    stallMs: 0, damping: 12, clearance: 1.7, hovers: false,
  },
  helicopter: {
    name: 'helicopter',
    note: 'collective lifts, cyclic tilts the rotor, pedals yaw — it goes where it is pointed',
    massKg: 620, thrustN: 9000, rate: { pitch: 1.1, roll: 1.6, yaw: 1.5 }, drag: 12, lift: 0,
    stallMs: 0, damping: 1.8, clearance: 0.6, hovers: true,
  },
  omnicopter: {
    name: 'omnicopter',
    note: 'thrusts in any direction without tilting — a drone that cheats',
    massKg: 4, thrustN: 120, rate: { pitch: 2.4, roll: 3.0, yaw: 2.6 }, drag: 0.6, lift: 0,
    stallMs: 0, damping: 6, clearance: 0.3, hovers: true,
  },
  ornithopter: {
    name: 'ornithopter',
    note: 'flaps: lift arrives in beats and it sinks between them',
    massKg: 100, thrustN: 2600, rate: { pitch: 1.2, roll: 1.4, yaw: 0.9 }, drag: 5, lift: 34,
    stallMs: 7, damping: 2.2, clearance: 0.5, hovers: false,
  },
  plane: {
    name: 'light aircraft',
    note: 'wings: it needs speed to fly and stalls without it',
    massKg: 1100, thrustN: 2600, rate: { pitch: 1.1, roll: 2.0, yaw: 0.7 }, drag: 2.2, lift: 46,
    stallMs: 26, damping: 1.1, clearance: 1.2, hovers: false,
  },
  jet: {
    name: 'jet',
    note: 'the same wings, an enormous engine, and an afterburner',
    massKg: 12000, thrustN: 76000, rate: { pitch: 1.5, roll: 3.4, yaw: 0.8 }, drag: 9, lift: 300,
    stallMs: 62, damping: 1.0, clearance: 1.5, hovers: false,
  },
  ufo: {
    name: 'UFO',
    note: 'no inertia, no gravity, no roll — it simply is where you put it',
    massKg: 1, thrustN: 1, rate: { pitch: 0, roll: 0, yaw: 2.0 }, drag: 0, lift: 0,
    stallMs: 0, damping: 20, clearance: 0.5, hovers: true,
  },
} as const satisfies Record<string, CraftSpec>

export type CraftKind = keyof typeof CRAFT

export const CRAFT_KINDS = Object.keys(CRAFT) as CraftKind[]

/* ---- the maths ----------------------------------------------------------------------------- */

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const len = (v: Vec3) => Math.hypot(v.x, v.y, v.z)

/** The craft's own axes, from its attitude. Three world coords: x east, y up, z south. */
export function axes(yaw: number, pitch: number, roll: number): { fwd: Vec3; right: Vec3; up: Vec3 } {
  const cy = Math.cos(yaw), sy = Math.sin(yaw)
  const cp = Math.cos(pitch), sp = Math.sin(pitch)
  const cr = Math.cos(roll), sr = Math.sin(roll)
  // yaw 0 points at -z (north); pitch raises the nose
  const fwd = { x: sy * cp, y: sp, z: -cy * cp }
  // the level right, and the up that completes the set. `r0 × fwd`, NOT `fwd × r0` — the other
  // order points `up` at the ground, which is a sign error that does not look like one: the
  // helicopter still flies, downwards, and the angle of attack comes out negated, so a wing makes
  // lift when it should stall. Every craft here reads `up`.
  const r0 = { x: cy, y: 0, z: sy }
  const u0 = {
    x: r0.y * fwd.z - r0.z * fwd.y,
    y: r0.z * fwd.x - r0.x * fwd.z,
    z: r0.x * fwd.y - r0.y * fwd.x,
  }
  // rotate the pair about the nose by the roll. Banking right drops the right wing, so `right`
  // gains a negative y and `up` leans towards the right wing.
  const right = { x: r0.x * cr - u0.x * sr, y: r0.y * cr - u0.y * sr, z: r0.z * cr - u0.z * sr }
  const up = { x: u0.x * cr + r0.x * sr, y: u0.y * cr + r0.y * sr, z: u0.z * cr + r0.z * sr }
  return { fwd, right, up }
}

/**
 * A craft at rest, here, facing this way.
 *
 * `airborne` gives a wing the airspeed it needs to be flying rather than falling. A plane handed
 * to somebody at 100 m with no speed is correct physics and an unusable mode: it is stalled on the
 * first frame and the only thing it can do is hit the ground. 1.3× the stall speed is what an
 * approach is flown at, and it means "you took off from somewhere" rather than "you appeared".
 */
export function startState(at: Vec3, yaw = 0, { airborne = false, kind }: { airborne?: boolean; kind?: CraftKind } = {}): CraftState {
  const vel = { x: 0, y: 0, z: 0 }
  if (airborne && kind && CRAFT[kind].stallMs > 0) {
    const v = CRAFT[kind].stallMs * 1.3
    vel.x = Math.sin(yaw) * v
    vel.z = -Math.cos(yaw) * v
  }
  return { at: { ...at }, vel, yaw, pitch: 0, roll: 0, phase: 0, stalled: false, grounded: false }
}

/**
 * Advance one craft by `dt` seconds.
 *
 * ONE FUNCTION, branching on the KIND of flight rather than on the name — a walker, a rotor, a
 * wing and a cheat. The alternative is six classes that share a page of integration code each,
 * and the way that goes wrong is the ground clamp being right in five of them.
 */
export function step(kind: CraftKind, s: CraftState, c: Controls, dt: number, world: World): CraftState {
  const spec: CraftSpec = CRAFT[kind]
  const d = Math.min(0.1, Math.max(0, dt))
  const g = world.gravity ?? G
  const next: CraftState = { at: { ...s.at }, vel: { ...s.vel }, yaw: s.yaw, pitch: s.pitch, roll: s.roll, phase: s.phase, stalled: false, grounded: false }

  /* ---- attitude ---- */
  if (kind === 'ufo') {
    // no roll and no pitch, ever: a saucer that banks is a plane with a funny hull
    next.yaw += c.yaw * spec.rate.yaw * d
    next.pitch = 0
    next.roll = 0
  } else if (kind === 'walk' || kind === 'walk-third') {
    next.yaw += c.yaw * spec.rate.yaw * d
  } else {
    next.pitch = clamp(next.pitch - c.pitch * spec.rate.pitch * d, -1.45, 1.45)
    next.roll += c.roll * spec.rate.roll * d
    next.roll = Math.atan2(Math.sin(next.roll), Math.cos(next.roll))
    if (kind === 'plane' || kind === 'jet' || kind === 'ornithopter') {
      // A BANKED WING TURNS. This is the whole difference between flying and driving a camera:
      // the rudder is trim, and what actually turns an aeroplane is the horizontal component of
      // the lift vector when it is banked. Rate = g·tan(bank)/v, which is why a fast aircraft
      // turns lazily and a slow one can pivot.
      const v = Math.max(1, len(next.vel))
      next.yaw += ((g * Math.tan(clamp(next.roll, -1.3, 1.3))) / v) * d
      // the rudder is TRIM. At 0.3 of the yaw rate it out-turned the bank over eight seconds,
      // which makes an aeroplane a car that can climb.
      next.yaw += c.yaw * spec.rate.yaw * d * 0.1
    } else {
      next.yaw += c.yaw * spec.rate.yaw * d
    }
    // hands off, it levels out — every one of these is stable in roll and none is in a video game
    // sense "realistic" about it
    if (!c.roll) next.roll *= Math.exp(-spec.damping * 0.35 * d)
    if (!c.pitch && spec.hovers) next.pitch *= Math.exp(-spec.damping * 0.35 * d)
  }

  const { fwd, up } = axes(next.yaw, next.pitch, next.roll)
  const acc = { x: 0, y: 0, z: 0 }
  const push = (v: Vec3, n: number) => { acc.x += v.x * n; acc.y += v.y * n; acc.z += v.z * n }

  /* ---- what pushes it ---- */
  if (kind === 'walk' || kind === 'walk-third') {
    // A WALKER IS NOT A VEHICLE. It has a speed, not a momentum: velocity is set from the input
    // rather than integrated towards it, because a person who stops walking stops.
    const speed = (c.boost ? 5.4 : 1.45) * (c.brake ? 0.4 : 1)
    const level = { x: Math.sin(next.yaw), y: 0, z: -Math.cos(next.yaw) }
    const side = { x: Math.cos(next.yaw), y: 0, z: Math.sin(next.yaw) }
    next.vel.x = (level.x * c.throttle + side.x * c.roll) * speed
    next.vel.z = (level.z * c.throttle + side.z * c.roll) * speed
    next.vel.y -= g * d
    next.at.x += next.vel.x * d
    next.at.y += next.vel.y * d
    next.at.z += next.vel.z * d
    const gy = world.groundAt(next.at.x, next.at.z)
    if (gy !== null) {
      const floor = gy + spec.clearance
      if (next.at.y <= floor) {
        // the ground came up — a kerb, a step, a landing. Snap: a person's feet are on it or they
        // are not, and easing UP leaves the eye permanently a centimetre or two underground,
        // asymptotically approaching a floor it never reaches.
        next.at.y = floor
        next.vel.y = 0
        next.grounded = true
      } else if (next.at.y < floor + 0.35) {
        // the ground fell away by less than a step: walk down it rather than dropping off it
        next.at.y += (floor - next.at.y) * (1 - Math.exp(-12 * d))
        next.vel.y = 0
        next.grounded = true
      }
    }
    return next
  }

  if (kind === 'ufo') {
    // NO INERTIA AT ALL. The velocity IS the input: it starts instantly, it stops instantly, and
    // nothing it does is affected by what it was doing before. Everything else here integrates
    // forces; this deliberately does not, which is the whole character of the thing.
    const speed = (c.boost ? 180 : 45) * (c.brake ? 0.15 : 1)
    const level = { x: Math.sin(next.yaw), y: 0, z: -Math.cos(next.yaw) }
    const side = { x: Math.cos(next.yaw), y: 0, z: Math.sin(next.yaw) }
    next.vel.x = (level.x * c.throttle + side.x * c.roll) * speed
    next.vel.z = (level.z * c.throttle + side.z * c.roll) * speed
    next.vel.y = c.lift * speed * 0.6
    next.at.x += next.vel.x * d
    next.at.y += next.vel.y * d
    next.at.z += next.vel.z * d
    return clampGround(next, spec, world)
  }

  const v = len(next.vel)
  const throttle = clamp(c.throttle, 0, 1) * (c.boost ? 1.6 : 1)

  if (spec.hovers) {
    // A ROTOR THRUSTS ALONG THE MAST. A helicopter goes where it is pointed and nowhere else: the
    // collective sets how hard, the cyclic sets which way by tilting the whole aircraft. There is
    // no separate "forward" force, and putting one in is how a helicopter ends up handling like a
    // hovercraft with a wobble.
    push(up, (throttle * spec.thrustN) / spec.massKg)
    if (kind === 'omnicopter') {
      // except this one, which is the point of it: it thrusts sideways and up without tilting
      push(fwd, (c.throttle * spec.thrustN * 0.6) / spec.massKg)
      acc.y += (c.lift * spec.thrustN * 0.8) / spec.massKg
    }
  } else if (kind === 'ornithopter') {
    // FLAPPING. Thrust and lift arrive in beats, and between them it falls — which is the whole
    // reason this is in the library and not a slow plane. `phase` is the wing cycle.
    const beats = 2.6 + throttle * 2.2
    next.phase = (s.phase + beats * d) % 1
    // a half-sine pulse on the downstroke, nothing on the recovery
    const pulse = next.phase < 0.5 ? Math.sin(next.phase * 2 * Math.PI) : 0
    push(fwd, (pulse * throttle * spec.thrustN * 2) / spec.massKg)
    acc.y += (pulse * throttle * spec.thrustN * 1.4) / spec.massKg
    // it has wings as well, so it glides between beats once it is moving
    const alpha = angleOfAttack(next.vel, fwd, up)
    if (v > spec.stallMs) push(up, (spec.lift * v * v * alpha) / spec.massKg)
    else next.stalled = v > 1
  } else {
    // A WING. Lift is proportional to v² and to the angle of attack, and it stops — completely —
    // below the stall speed. That is the one thing that makes a plane a plane: you cannot climb by
    // pointing up, you climb by having enough speed to.
    push(fwd, (throttle * spec.thrustN) / spec.massKg)
    const alpha = angleOfAttack(next.vel, fwd, up)
    // STALLED IS NOT ONLY SLOW. A wing has stopped working when it is past its critical angle, or
    // when the air is arriving from behind it, however fast that air is going — which is what a
    // spin is, and what falling out of a badly flown loop is. The first version tested airspeed
    // alone, so an aircraft hanging on its tail and dropping at 36 m/s reported itself as flying
    // normally with no lift, which is the same state described two contradictory ways.
    const critical = Math.abs(alpha) >= 0.415 || (v > 1 && next.vel.x * fwd.x + next.vel.y * fwd.y + next.vel.z * fwd.z <= 0)
    if (v >= spec.stallMs && !critical) {
      push(up, (spec.lift * v * v * alpha) / spec.massKg)
    } else {
      next.stalled = true
      // a stalled wing still makes a little, which is what lets you fly out of one by dropping
      // the nose and gaining speed rather than falling like a brick for ever
      push(up, (spec.lift * v * v * alpha * 0.15) / spec.massKg)
    }
  }

  acc.y -= g
  // drag opposes motion and grows with the square of it; the air brake is more area
  if (v > 0.01) {
    const dragA = ((spec.drag * (c.brake ? 4 : 1)) * v * v) / spec.massKg
    acc.x -= (next.vel.x / v) * dragA
    acc.y -= (next.vel.y / v) * dragA
    acc.z -= (next.vel.z / v) * dragA
  }

  next.vel.x += acc.x * d
  next.vel.y += acc.y * d
  next.vel.z += acc.z * d
  next.at.x += next.vel.x * d
  next.at.y += next.vel.y * d
  next.at.z += next.vel.z * d
  return clampGround(next, spec, world)
}

/** How far the airflow is off the nose, in radians, signed so that nose-up is positive. */
export function angleOfAttack(vel: Vec3, fwd: Vec3, up: Vec3): number {
  const v = len(vel)
  if (v < 0.5) return 0
  const along = (vel.x * fwd.x + vel.y * fwd.y + vel.z * fwd.z) / v
  const vertical = (vel.x * up.x + vel.y * up.y + vel.z * up.z) / v
  // flying backwards is not a flight regime this models; treat it as fully stalled
  if (along <= 0) return 0
  return clamp(-Math.atan2(vertical, along), -0.42, 0.42)
}

/** Nothing goes through the ground. A landing kills the downward velocity, not all of it. */
function clampGround(s: CraftState, spec: CraftSpec, world: World): CraftState {
  const gy = world.groundAt(s.at.x, s.at.z)
  if (gy === null) return s
  const floor = gy + spec.clearance
  if (s.at.y > floor) return s
  s.at.y = floor
  if (s.vel.y < 0) s.vel.y = 0
  s.grounded = true
  // friction on the ground, so a landed aircraft stops rather than skating
  s.vel.x *= 0.92
  s.vel.z *= 0.92
  return s
}

/**
 * Where the camera goes for this craft, given its state.
 *
 * `walk` is at the eye. Everything else is a chase camera behind and above, at a distance that
 * suits the size of the thing — a jet framed at a helicopter's six metres is a wall of fuselage.
 */
export function cameraFor(kind: CraftKind, s: CraftState): { eye: Vec3; look: Vec3 } {
  const { fwd } = axes(s.yaw, kind === 'walk' ? s.pitch : Math.max(-0.4, Math.min(0.4, s.pitch)), 0)
  if (kind === 'walk') {
    return { eye: { ...s.at }, look: { x: s.at.x + fwd.x * 10, y: s.at.y + fwd.y * 10, z: s.at.z + fwd.z * 10 } }
  }
  const back = CHASE[kind] ?? 12
  const up = back * 0.35
  return {
    eye: { x: s.at.x - fwd.x * back, y: s.at.y - fwd.y * back + up, z: s.at.z - fwd.z * back },
    look: { x: s.at.x + fwd.x * 4, y: s.at.y + fwd.y * 4, z: s.at.z + fwd.z * 4 },
  }
}

const CHASE: Partial<Record<CraftKind, number>> = {
  'walk-third': 4.5,
  helicopter: 16,
  omnicopter: 6,
  ornithopter: 14,
  plane: 22,
  jet: 45,
  ufo: 20,
}
