// Five ways a car can feel, as data.
//
// Rich's list: "1990 stunts/4d racing ported from what we have now, arcade racer like crazy taxi,
// gta4/5ish physics, arcade racer like san fransico rush, then simulator". Those are not five
// physics engines. They are five settings of the SAME engine, and the thing that separates them
// is one number.
//
// THE ARCADE↔SIM AXIS IS `yawAssist`.
//
// In a simulator the car rotates because the tyres made it rotate: you ask the front wheels for an
// angle and the yaw rate is whatever the slip angles happen to produce. In an arcade racer the car
// rotates because you asked it to, and the tyres are decoration. Every game on the list sits
// somewhere between those, and putting that somewhere on ONE axis is what stops this file being
// five hand-written controllers that drift apart.
//
//   yawAssist 0.0   the tyres decide.                                    simulator
//   yawAssist 0.45  the tyres decide, with a shove in the right direction. GTA-ish
//   yawAssist 0.75  you decide, within what grip allows.                  Rush
//   yawAssist 0.85  you decide, and grip is generous about it.            Crazy Taxi
//   yawAssist 1.0   you decide; the tyres only say how much.              Stunts
//
// `yawGripLimited` is the second half of that and it is what makes the Stunts port faithful rather
// than merely twitchy. In `apps/corridor/src/car.ts` the wheel asks for a yaw rate, the tyres
// deliver `clamp(demand, -grip, +grip)` and ABOVE THE LIMIT THE CAR SIMPLY TURNS LESS — a slide is
// never *added* by cornering. That one rule is why a 1990 car understeers off the outside of a bend
// instead of spinning, and it survives here as a cap on the imposed yaw rather than as a model of
// what the rubber is doing.
//
// WHAT A PROFILE IS NOT. It is not a car. Mass, wheelbase, track and wheel radius belong to the
// vehicle spec, so the same profile drives a hatchback and a box truck and they feel like the same
// GAME with different weights. A profile that hard-codes 1400 kg is a profile that can only ever
// describe one car.
//
// THE NUMBERS ARE A STARTING POINT, and this is said plainly because the alternative is somebody
// reading them as measurements. The `stunts` row is arithmetic off the existing model's knobs
// (CAR_ACCEL 11 m/s² × mass = engine force, CAR_GRIP_LATERAL 22 m/s² = μ 2.2, and so on down), so
// it starts where the hand-written car is. The other four are reasoned from what each game is
// known for and have not been driven by a person — this box has no GPU. They are meant to go
// through the F6 panel, be driven, and come back as JSON.

/** How a car behaves, independent of what car it is. */
export interface DriveProfile {
  id: string
  name: string
  /** one line for the editor's picker */
  note: string

  /* ---- suspension ------------------------------------------------------------------------ */
  /** rest length of the spring, m: how far the wheel hangs below its mount */
  suspensionRest: number
  /** how far it may move either side of rest, m */
  suspensionTravel: number
  /** spring rate. Rapier's units; roughly N/m per unit of the chassis' own mass */
  suspensionStiffness: number
  /** damping while compressing, and while extending. Relaxation under-damped = a car that pogos */
  compression: number
  relaxation: number
  /** ceiling on what one corner may push with, N — the thing that stops a kerb launching the car */
  maxSuspensionForce: number

  /* ---- tyres ----------------------------------------------------------------------------- */
  /** front and rear friction coefficients. front < rear understeers; rear < front is a drift car */
  gripFront: number
  gripRear: number
  /** lateral stiffness multiplier: how sharply the tyre answers a slip angle */
  sideStiffness: number
  /** what grip is multiplied by off the pavement */
  offroadGrip: number

  /* ---- engine and brakes ------------------------------------------------------------------ */
  /** total tractive force at a standstill, N per kg of vehicle — so it scales with the car */
  powerPerKg: number
  /** m/s. Drive force tapers to nothing here; it is not a clamp on the speedometer */
  topSpeed: number
  /** total braking force, N per kg */
  brakePerKg: number
  /** handbrake force on the rear axle, N per kg */
  handbrakePerKg: number
  /** reverse is this fraction of forward power */
  reverse: number
  drive: 'rwd' | 'fwd' | 'awd'

  /* ---- steering --------------------------------------------------------------------------- */
  /** road-wheel angle at a standstill, rad */
  steerMax: number
  /** how fast the wheel moves, rad/s — the difference between a kart and a bus */
  steerRate: number
  /** fraction of steerMax still available at topSpeed */
  steerAtSpeed: number
  /**
   * m/s at which the steering has its full authority.
   *
   * Below it the wheel does progressively less, which is not a physical claim — it is the rule
   * that stops a stationary car pirouetting when somebody leans on the stick, and it is the same
   * low-speed ramp the hand-written car uses (CAR_STEER_FULL_SPEED).
   */
  steerFullSpeed: number
  /** 0…1: how much of a slide the car corrects for you before you do */
  counterSteer: number

  /* ---- the arcade↔sim axis ----------------------------------------------------------------- */
  /** 0 = the tyres decide the yaw rate, 1 = the wheel does. See the header */
  yawAssist: number
  /** 1 = the imposed yaw is capped by what grip allows (Stunts: you turn LESS, you do not spin) */
  yawGripLimited: number
  /** handbrake: the share of sideways velocity that survives each second */
  driftHold: number
  /** extra yaw rate the handbrake grants, rad/s at full lock */
  driftYaw: number
  /** how fast a slide bleeds off, 1/s */
  slideDecay: number

  /* ---- aero and air ------------------------------------------------------------------------- */
  /** m/s² of rolling resistance, constant with speed. What a coasting car loses to its tyres */
  rollingPerKg: number
  /** N per (m/s)² per kg — drag */
  dragPerKg: number
  /** N per (m/s)² per kg pressing down. 0 for anything made before about 1985 */
  downforcePerKg: number
  /**
   * N per kg of ACTIVE fan downforce at full spool — the Speirling's ground effect.
   *
   * Wings need airspeed, and a wing that presses the car down also presses it DOWN at the CoM and
   * lifts off above a bump. A fan does not: it pulls the floor toward the road whatever the speed,
   * which is why the fan car could out-brake everything. In this model the fan spools with what the
   * driver is asking for (brake, throttle, or simply speed), presses at BOTH axles so neither runs
   * out of grip, and is biased rearward by `fanRearBias` so it also plants the back of the car
   * against the nose-over that a hard stop otherwise causes. See `Vehicle.step`.
   */
  fanPerKg: number
  /** 0 = the fan presses at the CoM; 1 = all of it at the rear axle. The share that is the anti-dive */
  fanRearBias: number
  /** rad/s² the driver has in the air about each axis. 0 = a thrown brick */
  airPitch: number
  airRoll: number
  airYaw: number
  /** 1/s: how fast an uncommanded tumble settles. High = the car noses along its arc */
  airDamping: number

  /* ---- stability -------------------------------------------------------------------------- */
  /** N·m per rad of body roll, per kg: an anti-roll bar across both axles */
  antiRollPerKg: number
  /** 0…1 of the roll-axis spin damped per step. 1 is a car that cannot be put on its roof */
  rollResist: number
  /** landing: vertical speed, m/s, above which a landing does damage */
  landingTolerance: number
  /**
   * The share of a wheel's grip that stays available to the ENGINE however hard it is cornering.
   *
   * The traction model spends the friction circle side-force first and gives the engine what is
   * left: `√(budget² − side²)`. Taken literally that reaches zero, and a wheel at the limit of its
   * lateral grip delivers no drive at all — which is a real effect and, at full strength, a car
   * that stops accelerating the moment it is asked to turn. Measured on the loop's entry: side
   * 42,813 N against a budget of 42,813 N, drive cut to nothing, and thirty metres a second scrubbed
   * off in half a second. Rich, 2026-09-29: *"it really feels like some weird friction, the kind I
   * get when I try to turn while accelerating."*
   *
   * A third of the budget is reserved, so the throttle always does something. A sim profile can set
   * it to 0 and have the textbook circle back.
   */
  driveShare?: number

  /**
   * The least share of a wheel's STATIC load that still counts toward its traction budget, 0…1.
   *
   * THE FAULT THIS FIXES. Drive is limited by `frictionSlip × suspensionForce`, and the suspension
   * force is an instantaneous reading off a ray-cast wheel — it goes to nearly nothing whenever a
   * wheel goes light, which on a ramp's concave entry is exactly what the DRIVEN wheels do as the
   * nose rises. Budget zero means the engine delivers zero, so a car with 11 m/s² of power coasts
   * up a fifteen-degree ramp and slows down. Rich, 2026-09-29: *"driving up the ramp feels like it
   * is stuck and it can't accelerate with gobs of power, there is some weird friction happening."*
   * There was: ours.
   *
   * A quarter of the static load is the floor, which is enough to keep a car driving over a crest
   * and far too little to make a wheel in mid-air useful.
   */
  tractionFloor?: number

  /**
   * How much the body itself grips whatever it scrapes — the SKID PLATE.
   *
   * Rich, 2026-09-29, of a car stopping dead at the foot of a loop: *"it feels like an inelastic
   * collision stopping the car in its tracks. We may need to tweak the bounding physics to give
   * like a virtual skid plate for the geometry so the car can have its nose touch the ramp and then
   * deflect without a full crash."* Exactly so. The chassis is a cuboid with friction 0.4, which is
   * tarmac-on-rubber for a shape with no wheels: touch a ramp with the nose at 46 m/s and 0.4
   * against several tonnes of normal force takes the whole of the forward momentum in a few
   * milliseconds. The car does not crash into anything — it is held by its own bumper.
   *
   * Low here means the nose slides along what it touches and the wheels keep the car going, which
   * is what a scrape is: sparks and a scar in the paint, not a wall. It does not make the car
   * indestructible — impacts are read from the contact force and are unaffected.
   *
   * Absent means 0.4, which is what every profile had before this existed.
   */
  chassisFriction?: number
}

/* ================================================================================================
 * The five.
 * ============================================================================================= */

/**
 * **Stunts / 4D Sports Driving, 1990** — ported from `apps/corridor/src/car.ts`.
 *
 * The defining feel: the car goes exactly where the wheel points until grip runs out, and then it
 * goes LESS where the wheel points. No weight transfer, no suspension worth the name, no air
 * control at all, and a crest at speed throws you. `yawAssist` 1 with `yawGripLimited` 1 is that
 * model exactly, which is the point of porting it this way rather than by feel.
 *
 * The numbers come from the corridor car's knobs: CAR_ACCEL 11 m/s², CAR_BRAKE 24, CAR_GRIP_LATERAL
 * 22 (μ 2.24 — arcade grip, and deliberately so), CAR_TOP_SPEED 82 m/s, CAR_STEER_RATE 2.4 rad/s,
 * CAR_HANDBRAKE_* for the drift, CAR_SLIDE_DECAY 2. Suspension is stiff and short because in the
 * original there is none: the body sits on the ground plane and is posed from four height samples.
 */
export const STUNTS: DriveProfile = {
  id: 'stunts',
  name: 'Stunts (1990)',
  note: 'Points where you point it until grip runs out, then understeers. No air control. Crests throw you.',
  suspensionRest: 0.28,
  suspensionTravel: 0.06,
  suspensionStiffness: 90,
  compression: 2.2,
  relaxation: 2.6,
  maxSuspensionForce: 40_000,
  gripFront: 2.24,
  gripRear: 2.24,
  sideStiffness: 1.2,
  offroadGrip: 0.7, // CAR_GRASS_GRIP_SCALE
  powerPerKg: 11, // CAR_ACCEL
  topSpeed: 82, // CAR_TOP_SPEED
  brakePerKg: 24, // CAR_BRAKE
  handbrakePerKg: 14.4, // CAR_BRAKE × CAR_HANDBRAKE_BRAKE
  reverse: 0.6, // CAR_REVERSE_ACCEL
  drive: 'rwd',
  steerMax: 0.62,
  steerRate: 2.4, // CAR_STEER_RATE
  steerAtSpeed: 0.35, // CAR_STEER_HIGH_SPEED_FACTOR
  steerFullSpeed: 12, // CAR_STEER_FULL_SPEED
  counterSteer: 0,
  yawAssist: 1,
  yawGripLimited: 1,
  driftHold: 0.35, // CAR_HANDBRAKE_SLIDE
  driftYaw: 0.7, // CAR_HANDBRAKE_ROTATE
  slideDecay: 2, // CAR_SLIDE_DECAY
  rollingPerKg: 0.5, // CAR_DRAG_ROLLING
  dragPerKg: 0.0006, // CAR_DRAG_AERO
  downforcePerKg: 0,
  fanPerKg: 0,
  fanRearBias: 0.6,
  airPitch: 0,
  airRoll: 0,
  airYaw: 0,
  airDamping: 2.5, // CAR_AIR_NOSE_RATE: it noses along its arc and nothing else
  antiRollPerKg: 0,
  rollResist: 0.9, // a 1990 car does not roll over; it lands flat and carries on
  landingTolerance: 30, // CAR_CRASH_IMPACT_SPEED
}

/**
 * **Crazy Taxi** — the arcade racer that never punishes you.
 *
 * Enormous grip, instant steering, a handbrake that rotates the car almost free of its velocity
 * (the "crazy drift"), and a body that will not roll over however hard you hit a kerb. Power is
 * absurd because the whole game is stop–go–stop. Landings never hurt: `landingTolerance` is high
 * enough that nothing you can do to it counts as a crash.
 */
export const TAXI: DriveProfile = {
  id: 'taxi',
  name: 'Crazy Taxi',
  note: 'Huge grip, instant response, handbrake spins you on the spot. Nothing you do is punished.',
  suspensionRest: 0.34,
  suspensionTravel: 0.14,
  suspensionStiffness: 55,
  compression: 1.8,
  relaxation: 2.2,
  maxSuspensionForce: 40_000,
  gripFront: 2.8,
  gripRear: 2.8,
  sideStiffness: 1.5,
  offroadGrip: 0.9,
  powerPerKg: 14,
  topSpeed: 62,
  brakePerKg: 30,
  handbrakePerKg: 20,
  reverse: 0.75,
  drive: 'rwd',
  steerMax: 0.7,
  steerRate: 5.5,
  steerAtSpeed: 0.55,
  steerFullSpeed: 8,
  counterSteer: 0.6,
  yawAssist: 0.85,
  yawGripLimited: 0,
  driftHold: 0.75,
  driftYaw: 2.2,
  slideDecay: 3.5,
  rollingPerKg: 0.6,
  dragPerKg: 0.0008,
  downforcePerKg: 0,
  fanPerKg: 0,
  fanRearBias: 0.6,
  airPitch: 0.6,
  airRoll: 0.6,
  airYaw: 0.4,
  airDamping: 1.5,
  antiRollPerKg: 6,
  rollResist: 0.95,
  landingTolerance: 60,
}

/**
 * **GTA IV/V-ish** — a heavy car on soft springs that you can feel moving about underneath you.
 *
 * The thing both those games do and nothing else on this list does is WEIGHT: long travel, real
 * pitch under braking, real roll in a bend, and grip low enough that the back steps out when you
 * ask too much of it. IV wallowed and V tightened it up; this sits between, nearer V, because V is
 * what people mean when they say "GTA physics" and IV is what they say afterwards.
 *
 * `yawAssist` 0.45 is the honest description of those games: mostly the tyres, with a hand on the
 * car's shoulder so a pad with no force feedback is still drivable.
 */
export const STREET: DriveProfile = {
  id: 'street',
  name: 'Street (GTA IV/V-ish)',
  note: 'Heavy, soft, and you can feel the weight move. Grip runs out where it should.',
  suspensionRest: 0.42,
  suspensionTravel: 0.22,
  suspensionStiffness: 32,
  compression: 1.4,
  relaxation: 2.0,
  maxSuspensionForce: 30_000,
  gripFront: 1.35,
  gripRear: 1.25, // rear lower: power-on oversteer, which is the whole character
  sideStiffness: 0.9,
  offroadGrip: 0.6,
  powerPerKg: 7.5,
  topSpeed: 58,
  brakePerKg: 16,
  handbrakePerKg: 11,
  reverse: 0.5,
  drive: 'rwd',
  steerMax: 0.58,
  steerRate: 2.6,
  steerAtSpeed: 0.3,
  steerFullSpeed: 14,
  counterSteer: 0.35,
  yawAssist: 0.45,
  yawGripLimited: 0,
  driftHold: 0.55,
  driftYaw: 1.2,
  slideDecay: 1.6,
  rollingPerKg: 0.45,
  dragPerKg: 0.0009,
  downforcePerKg: 0.0004,
  // THE HERO CAR IS A FAN CAR. Broadly, `street` is the driven car: traffic is kinematic and never
  // runs this step, so the fan lands on the player and little else. A plain street car has no
  // downforce, and a hard stop at a brake force a fast one wants lifts the back axle and pitches it
  // over the front (measured end over end on this file's own test bench). Six m/s² of fan downforce,
  // biased rearward, plants the tyres and the tail.
  fanPerKg: 6,
  fanRearBias: 0.62,
  airPitch: 0.35,
  airRoll: 0.35,
  airYaw: 0.15,
  airDamping: 0.8,
  antiRollPerKg: 3.5,
  rollResist: 0.25, // it CAN roll, and it should: a barrel roll off a kerb is half the fun
  landingTolerance: 18,
}

/**
 * **San Francisco Rush** — the one that is about the air.
 *
 * Rush's signature is that you spend a third of the lap off the ground and you can do something
 * about it: pitch and roll authority in flight, and a landing that forgives almost anything if you
 * get it flat. On the ground it is stuck down hard, with springs soft enough to soak up a landing
 * that would end the Stunts car.
 */
export const RUSH: DriveProfile = {
  id: 'rush',
  name: 'Rush (SF Rush)',
  note: 'Built for jumps: full pitch and roll control in the air, soft landings, glued down in bends.',
  suspensionRest: 0.40,
  suspensionTravel: 0.30,
  suspensionStiffness: 45,
  compression: 2.6,
  relaxation: 3.4,
  maxSuspensionForce: 60_000,
  gripFront: 2.4,
  gripRear: 2.3,
  sideStiffness: 1.4,
  offroadGrip: 0.85,
  powerPerKg: 13,
  topSpeed: 78,
  brakePerKg: 22,
  handbrakePerKg: 16,
  reverse: 0.6,
  drive: 'awd',
  steerMax: 0.6,
  steerRate: 4.0,
  steerAtSpeed: 0.45,
  steerFullSpeed: 10,
  counterSteer: 0.5,
  yawAssist: 0.75,
  yawGripLimited: 0,
  driftHold: 0.6,
  driftYaw: 1.6,
  slideDecay: 3,
  rollingPerKg: 0.4,
  dragPerKg: 0.0007,
  downforcePerKg: 0.0012,
  fanPerKg: 0,
  fanRearBias: 0.6,
  airPitch: 2.6, // the knob that is the whole game
  airRoll: 3.2,
  airYaw: 0.8,
  airDamping: 0.25, // whatever you set it spinning at, it keeps
  antiRollPerKg: 5,
  rollResist: 0.4,
  landingTolerance: 45,
}

/**
 * **Simulator** — no assists at all.
 *
 * `yawAssist` 0: the car rotates only because the tyres made it. Grip is a real coefficient rather
 * than an arcade one, there is aero, the rear is slightly loose under power, and the steering is
 * slow because a real rack is. This is the profile that will feel WRONG on a keyboard, and that is
 * the correct outcome — it is here for a wheel, and for whoever wants to find out what the road
 * actually does.
 *
 * What it is NOT: a tyre model. There is no contact patch, no slip curve, no temperature and no
 * load sensitivity beyond what the suspension force already provides — Rich asked for none of
 * that. It is a raycast vehicle with honest numbers and its assists switched off.
 */
export const SIM: DriveProfile = {
  id: 'sim',
  name: 'Simulator',
  note: 'No assists. The tyres decide everything. Slow rack, real grip, real aero.',
  suspensionRest: 0.36,
  suspensionTravel: 0.13,
  suspensionStiffness: 70,
  compression: 2.8,
  relaxation: 3.6,
  maxSuspensionForce: 45_000,
  gripFront: 1.15,
  gripRear: 1.05,
  sideStiffness: 1.0,
  offroadGrip: 0.45,
  powerPerKg: 6,
  topSpeed: 75,
  brakePerKg: 13,
  handbrakePerKg: 6,
  reverse: 0.35,
  drive: 'rwd',
  steerMax: 0.52,
  steerRate: 1.8,
  steerAtSpeed: 0.22,
  steerFullSpeed: 16,
  counterSteer: 0,
  yawAssist: 0,
  yawGripLimited: 0,
  driftHold: 0.3,
  driftYaw: 0,
  slideDecay: 0,
  rollingPerKg: 0.35,
  dragPerKg: 0.00055,
  downforcePerKg: 0.0018,
  fanPerKg: 0,
  fanRearBias: 0.6,
  airPitch: 0,
  airRoll: 0,
  airYaw: 0,
  airDamping: 0.1,
  antiRollPerKg: 8,
  rollResist: 0,
  landingTolerance: 9,
}

/*
 * THE STUNT CAR SCRAPES RATHER THAN CATCHES. A vocabulary built out of loops, corkscrews and jumps
 * is a vocabulary where the body touches the road on purpose, several times a lap; 0.4 turns every
 * one of those into a full stop. 0.04 is a skid plate — it slides.
 */
STUNTS.chassisFriction = 0.04
/*
 * AND IT DRIVES ALL FOUR. A car whose job is loops, corkscrews and banked sixths spends its time on
 * surfaces where the load moves around wildly, and rear-wheel drive there means the drive cuts out
 * every time the back goes light — which on the entry to a loop is precisely when you need it. The
 * 1990 car it is named after was rear-driven and understeered; this one keeps the understeer and
 * loses the moment where the throttle stops doing anything.
 */
STUNTS.drive = 'awd'

export const PROFILES: Record<string, DriveProfile> = {
  stunts: STUNTS,
  taxi: TAXI,
  street: STREET,
  rush: RUSH,
  sim: SIM,
}

export type ProfileId = keyof typeof PROFILES

/**
 * Every NUMERIC key of `DriveProfile`, for a validator that has to tell a real override from a
 * typo at runtime.
 *
 * `Object.keys(PROFILES.street)` cannot answer this: the optional keys (`driveShare`,
 * `tractionFloor`, `chassisFriction`) are `undefined` on every concrete profile, so a car that
 * legitimately overrides one would be rejected. The `Record<Exclude<…>, true>` type is what keeps
 * this list honest — add a numeric field to `DriveProfile` and this stops compiling until it is here.
 */
const NUMERIC_KEY_MAP: Record<Exclude<keyof DriveProfile, 'id' | 'name' | 'note' | 'drive'>, true> = {
  suspensionRest: true,
  suspensionTravel: true,
  suspensionStiffness: true,
  compression: true,
  relaxation: true,
  maxSuspensionForce: true,
  gripFront: true,
  gripRear: true,
  sideStiffness: true,
  offroadGrip: true,
  powerPerKg: true,
  topSpeed: true,
  brakePerKg: true,
  handbrakePerKg: true,
  reverse: true,
  steerMax: true,
  steerRate: true,
  steerAtSpeed: true,
  steerFullSpeed: true,
  counterSteer: true,
  yawAssist: true,
  yawGripLimited: true,
  driftHold: true,
  driftYaw: true,
  slideDecay: true,
  rollingPerKg: true,
  dragPerKg: true,
  downforcePerKg: true,
  fanPerKg: true,
  fanRearBias: true,
  airPitch: true,
  airRoll: true,
  airYaw: true,
  airDamping: true,
  antiRollPerKg: true,
  rollResist: true,
  landingTolerance: true,
  driveShare: true,
  tractionFloor: true,
  chassisFriction: true,
}
export const DRIVE_PROFILE_NUMBER_KEYS: ReadonlySet<string> = new Set(Object.keys(NUMERIC_KEY_MAP))

/**
 * A profile by id, with overrides on top.
 *
 * This is the shape the level document and the F6 panel both want: a level says `"profile":
 * "street"` and then changes three numbers, rather than carrying a copy of forty that stops
 * tracking the base when the base improves.
 */
export function profile(id: string, overrides: Partial<DriveProfile> = {}): DriveProfile {
  const base = PROFILES[id]
  if (!base) throw new Error(`physics: no drive profile "${id}" (have ${Object.keys(PROFILES).join(', ')})`)
  return { ...base, ...overrides }
}

/**
 * Blend two profiles.
 *
 * For a game that wants to move between them — a car that gets looser as it takes damage, a
 * "handling upgrade", a difficulty setting — and for the editor, which should let somebody see what
 * lives between Rush and the simulator rather than making them choose a side.
 *
 * The non-numeric fields take the nearer end, because there is no half of `rwd`.
 */
export function blendProfiles(a: DriveProfile, b: DriveProfile, t: number): DriveProfile {
  const out = { ...(t < 0.5 ? a : b) }
  for (const k of Object.keys(a) as (keyof DriveProfile)[]) {
    const av = a[k]
    const bv = b[k]
    if (typeof av === 'number' && typeof bv === 'number') (out[k] as number) = av + (bv - av) * t
  }
  out.id = `${a.id}~${b.id}@${t.toFixed(2)}`
  out.name = `${a.name} → ${b.name}`
  return out
}
