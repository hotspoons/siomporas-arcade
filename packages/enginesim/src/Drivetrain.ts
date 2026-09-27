// Road speed in, engine speed out.
//
// WHY THIS IS NOT engine-sim's OWN GEARBOX. engine-sim ships a Transmission and a Vehicle and will
// happily drive itself: throttle goes in, the crank spins up, the clutch feeds a gearbox, the car
// accelerates. Using that in a game means two simulations both deciding how fast the car is going,
// and they will not agree — corridor's `Car` has a tyre model, a slide, aero drag and a suspension
// that engine-sim has never heard of, and engine-sim has a torque curve corridor has never heard
// of. Whichever one you believe, the other one is wrong, and what you hear is an engine note that
// lags the car and hunts around it.
//
// So the car stays authoritative and this converts what it is doing into a crankshaft speed, which
// `EngineSim.drive()` then holds the simulation at. The combustion, the resonance and the exhaust
// are still fully simulated — only the drivetrain is ours.
//
// The one thing this has to do properly is the SHIFT. A gearchange is the most recognisable sound a
// car makes and it is not a jump in pitch: the clutch goes in, the engine drops off load and falls,
// the next gear catches it. Interpolating RPM between gears without that gap sounds like a synth
// glissando, which is the giveaway of a fake engine.

export interface DrivetrainSpec {
  /** Gear ratios, first to top. */
  gearRatios: number[]
  finalDrive: number
  /** Rolling radius in metres. */
  tyreRadius: number
  idleRpm: number
  redlineRpm: number
  /** Upshift here under power. */
  shiftUpRpm: number
  /** Downshift when the engine falls below this in the lower gear's terms. */
  shiftDownRpm: number
  /** How long the clutch is out, in seconds. */
  shiftSeconds: number
}

/** A fast road car: six speeds, redline near 7000, roughly what corridor's 82 m/s top speed wants. */
export const DEFAULT_DRIVETRAIN: DrivetrainSpec = {
  gearRatios: [3.9, 2.35, 1.62, 1.24, 1.0, 0.82],
  finalDrive: 3.45,
  tyreRadius: 0.34, // matches the wheel radius car.ts spins its wheel meshes at
  idleRpm: 850,
  redlineRpm: 7000,
  shiftUpRpm: 6500,
  shiftDownRpm: 2200,
  shiftSeconds: 0.18,
}

const RPM_PER_RAD_PER_SEC = 60 / (2 * Math.PI)

export class Drivetrain {
  readonly spec: DrivetrainSpec
  /** 0-based index into `gearRatios`. */
  gear = 0
  /** What to hold the engine at. */
  rpm: number
  /** 0..1, for `EngineSim.setClutch` in free mode; also what suppresses the pedal mid-shift. */
  clutch = 1
  /** The pedal the engine should see, which is not the pedal the driver is pressing mid-shift. */
  pedal = 0

  private shiftRemaining = 0
  private shiftFromRpm = 0

  constructor(spec: DrivetrainSpec = DEFAULT_DRIVETRAIN) {
    this.spec = spec
    this.rpm = spec.idleRpm
  }

  /** Engine RPM that `gear` implies at this road speed, ignoring the clutch and the idle floor. */
  private geared(speedMs: number, gear: number): number {
    const ratio = this.spec.gearRatios[gear] * this.spec.finalDrive
    return (Math.abs(speedMs) / this.spec.tyreRadius) * ratio * RPM_PER_RAD_PER_SEC
  }

  /**
   * @param speedMs   road speed in metres per second (corridor: `car.speed`)
   * @param throttle  the driver's pedal, 0..1
   * @param dt        seconds
   */
  update(speedMs: number, throttle: number, dt: number): void {
    const spec = this.spec
    const top = spec.gearRatios.length - 1

    if (this.shiftRemaining > 0) {
      this.shiftRemaining = Math.max(0, this.shiftRemaining - dt)
      const progress = 1 - this.shiftRemaining / spec.shiftSeconds
      const target = Math.max(spec.idleRpm, this.geared(speedMs, this.gear))
      // The engine is off load, so it falls towards idle before the new gear picks it up. Dipping
      // below the target and coming back is what makes this read as a clutch rather than a crossfade.
      const dip = Math.min(this.shiftFromRpm, target) * 0.72
      this.rpm = progress < 0.55
        ? this.shiftFromRpm + (dip - this.shiftFromRpm) * (progress / 0.55)
        : dip + (target - dip) * ((progress - 0.55) / 0.45)
      this.clutch = progress < 0.8 ? 0 : (progress - 0.8) / 0.2
      this.pedal = throttle * 0.12 // not quite closed: the engine is still burning something
      return
    }

    this.clutch = 1
    const geared = this.geared(speedMs, this.gear)

    // Shift decisions use the speed, not the current RPM, so a car being held at the limiter does
    // not chatter between two gears.
    if (this.gear < top && geared > spec.shiftUpRpm) {
      this.beginShift(this.gear + 1, geared)
      return
    }
    if (this.gear > 0 && geared < spec.shiftDownRpm) {
      this.beginShift(this.gear - 1, geared)
      return
    }

    // Below the idle floor the clutch would be slipping in a real car; here the engine simply idles,
    // which is also what stops a stationary car from being asked to hold 0 rpm and go silent.
    this.rpm = Math.min(spec.redlineRpm, Math.max(spec.idleRpm, geared))
    this.pedal = throttle
  }

  private beginShift(toGear: number, fromRpm: number): void {
    this.shiftFromRpm = Math.max(this.spec.idleRpm, fromRpm)
    this.gear = toGear
    this.shiftRemaining = this.spec.shiftSeconds
    this.clutch = 0
    this.pedal = 0
  }

  /** True while the clutch is out, for anything that wants to react to a gearchange. */
  get shifting(): boolean {
    return this.shiftRemaining > 0
  }

  reset(): void {
    this.gear = 0
    this.rpm = this.spec.idleRpm
    this.clutch = 1
    this.pedal = 0
    this.shiftRemaining = 0
  }
}
