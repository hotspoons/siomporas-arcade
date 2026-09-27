// The engine you can hear: Ange Yaghi's combustion simulator, voicing whatever has an `Engine`.
//
// This is corridor's side of `@apex/enginesim`. The package knows how to run a piston engine in an
// audio thread; this file knows which entity it is speaking for, when the browser will let it make
// a noise at all, and where to put it in the world.
//
// THE TWO NUMBERS. An `Engine` component is `{ rpm, pedal, gear, voice }`, and the first two are
// the entire audio interface — a combustion engine's sound at any instant is decided by how fast
// it is turning and how far the throttle is open. Whoever owns a car writes those; this reads them.
// That is why the player's car and a traffic car are the same case here: `attachPlayer` only
// differs in that it derives rpm from `car.speed` through a gearbox corridor does not otherwise
// have (see Drivetrain in the package for why the gearbox is ours and not engine-sim's).
//
// ONE VOICE. A simulated engine costs a real slice of a core — 45% of one on the machine this was
// measured on, in the audio thread. That buys something no sample set can: the note is the actual
// resonance of the actual cylinder count firing at the actual RPM, so it never loops and never
// crossfades. It does not buy a car park full of them. Traffic will get samples driven off the
// same `Engine` fields.
//
// AUTOPLAY. Browsers do not allow an AudioContext to start without a gesture, and a game that
// silently makes no sound is indistinguishable from a broken one. `start()` must be called from a
// real click or keypress; `state` says which of the several ways this can be not-running applies,
// so the UI can say so rather than shrug.

import { EngineSim, Drivetrain, DEFAULT_DRIVETRAIN, ENGINES, SpatialVoice,
  type DrivetrainSpec, type EngineProfile, type Listener, type Placement, type VoiceOptions }
  from '@apex/enginesim'
import { addComponent, addEntity, query, type World } from 'bitecs'
import { Engine, Transform, SETS } from './actors'
import type { Car } from './car'
import * as T from './tuning'

export type EngineSoundState =
  | 'off'          // never started; waiting for a gesture
  | 'starting'     // worklet registering, wasm instantiating
  | 'running'
  | 'unsupported'  // no AudioWorklet in this browser
  | 'failed'

/**
 * The engine script the player's car gets until something chooses otherwise.
 *
 * By PATH, deliberately. The F6 panel picks an engine by index because it is a panel of numbers,
 * but an index is a promise the catalog does not make — it is generated from the asset tree and
 * sorted by path, so one new engine renumbers everything after it. The default that ships is
 * pinned to the thing itself.
 */
const DEFAULT_ENGINE = 'engines/atg-video-2/07_gm_ls.mr'

export interface EngineSoundOptions {
  engine?: string
  drivetrain?: DrivetrainSpec
  /** Master gain for the whole engine, separate from the simulator's own volume knob. */
  volume?: number
}

/** The F6 panel's spatial knobs, in the shape SpatialVoice wants. Read fresh every frame: these
 * are `export let`s and a captured copy would be a dead one. */
function voiceOptions(): VoiceOptions {
  return {
    refDistance: T.ENGINE_REF_M,
    maxDistance: T.ENGINE_MAX_M,
    rolloffFactor: T.ENGINE_ROLLOFF,
    interiorM: T.ENGINE_INTERIOR_M,
    exteriorM: T.ENGINE_EXTERIOR_M,
    muffleHz: T.ENGINE_MUFFLE_HZ,
    hrtf: T.ENGINE_HRTF >= 0.5,
  }
}

export class EngineSound {
  state: EngineSoundState = 'off'
  error: string | null = null
  profile: EngineProfile | null = null

  /** The player's gearbox. Exposed because the HUD wants the gear and the tuning panel wants both. */
  readonly drivetrain: Drivetrain

  private context: AudioContext | null = null
  private sim: EngineSim | null = null
  private gain: GainNode | null = null
  private voice: SpatialVoice | null = null
  /** what the spatialiser last decided — for the HUD, the tuning panel and probes */
  placement: Placement | null = null
  private readonly options: EngineSoundOptions
  private playerEntity = 0
  private enginePath = ''
  private lastVoicing: Record<string, number> = {}
  private lastSimHz = 0

  constructor(options: EngineSoundOptions = {}) {
    this.options = options
    this.drivetrain = new Drivetrain(options.drivetrain ?? DEFAULT_DRIVETRAIN)
  }

  /**
   * Bring the audio up. MUST be called from a user gesture — a click or a keypress — or the browser
   * will create the context already suspended and nothing will ever come out of it.
   */
  async start(): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') return
    if (typeof AudioContext === 'undefined' || !('audioWorklet' in AudioContext.prototype)) {
      this.state = 'unsupported'
      this.error = 'This browser has no AudioWorklet'
      return
    }
    this.state = 'starting'
    try {
      const context = new AudioContext({ latencyHint: 'interactive' })
      await context.resume()

      const master = context.createGain()
      master.gain.value = this.options.volume ?? 0.9
      master.connect(context.destination)

      // The spatialiser. Two buses — a panned one and an unpanned, lowpassed cabin one — crossfaded
      // by how much you are sitting in the thing; see SpatialVoice in @apex/enginesim.
      const voice = new SpatialVoice(context, voiceOptions())
      voice.out.connect(master)

      const sim = await EngineSim.create(context, {
        onError: (message) => { this.error = message },
      })
      voice.connectFrom(sim.output)
      this.context = context
      this.sim = sim
      this.gain = master
      this.voice = voice
      this.state = 'running'
      this.error = null
      // Honour a saved ENGINE_INDEX if this browser has one, but fall back to the path rather than
      // to index 0 — which is a 518 cc single-cylinder quad engine, not a car.
      const chosen = ENGINES[Math.round(T.ENGINE_INDEX)]?.path
      await this.setEngine(this.options.engine ?? chosen ?? DEFAULT_ENGINE)
      this.applyTuning()
    } catch (error) {
      this.state = 'failed'
      this.error = error instanceof Error ? error.message : String(error)
    }
  }

  async stop(): Promise<void> {
    this.sim?.disconnect()
    await this.context?.close()
    this.context = null
    this.sim = null
    this.gain = null
    this.voice?.disconnect()
    this.voice = null
    this.placement = null
    this.state = 'off'
  }

  /** Which entity the one simulated voice speaks for. */
  setVoiced(entity: number): void {
    if (this.playerEntity && this.playerEntity !== entity) Engine.voice[this.playerEntity] = 0
    this.playerEntity = entity
    Engine.voice[entity] = 1
    this.drivetrain.reset()
  }

  /**
   * Derive the player's engine state from the car and write it into the component.
   *
   * Separate from `update` on purpose: this is the bit that knows corridor's `Car` has a speed and
   * no crankshaft, and it writes only the ECS. Anything else that wants to drive an engine — a
   * replay, the traffic model, a test — writes the same two fields and gets the same sound.
   */
  syncFromCar(entity: number, car: Car, throttle: number, dt: number): void {
    this.drivetrain.update(car.speed, throttle, dt)
    Engine.rpm[entity] = this.drivetrain.rpm
    Engine.pedal[entity] = this.drivetrain.pedal
    Engine.gear[entity] = this.drivetrain.gear + 1
  }

  /**
   * The system. Reads every `Engine` in the world and voices the one that has a voice.
   *
   * `listener` is the camera: where it is and which way it faces, in SITE metres — x east, y north,
   * z up, the same frame as `Transform` and NOT three's world axes. Converting at this edge is the
   * rule the ECS already follows (see actors.ts); a second convention inside the simulation is how
   * something ends up mirrored across a road.
   *
   * The geometry itself lives in @apex/enginesim (spatial.ts decides, voice.ts carries it out),
   * because none of it is about engines and traffic will want the same thing fifty times over.
   */
  update(world: World, listener: Listener): void {
    if (this.state !== 'running' || !this.sim || !this.context) return
    for (const entity of query(world, SETS.engines)) {
      if (Engine.voice[entity] !== 1) continue
      this.sim.drive(Engine.rpm[entity], Engine.pedal[entity])
      if (this.voice && this.gain) {
        this.placement = this.voice.place(
          { x: Transform.x[entity], y: Transform.y[entity], z: Transform.z[entity] },
          listener,
          voiceOptions(),
        )
        this.gain.gain.setTargetAtTime(T.ENGINE_MASTER, this.context.currentTime, 0.05)
      }
      return // one voice
    }
  }

  /**
   * Push the F6 panel's knobs at the running engine.
   *
   * Called on every tuning change of any kind, so it diffs: the gearbox is rebuilt from the panel
   * every time (it is a handful of numbers on this side of the wire), but the synthesizer knobs and
   * the engine script only cross into the audio thread when they actually moved. Recompiling a
   * Piranha script costs an audible break, and doing it because someone dragged the fog slider
   * would be a poor trade.
   */
  applyTuning(): void {
    const spec = this.drivetrain.spec
    // A ratio of 0 takes a gear out of the box rather than dividing by it.
    spec.gearRatios = [T.ENGINE_GEAR_1, T.ENGINE_GEAR_2, T.ENGINE_GEAR_3,
      T.ENGINE_GEAR_4, T.ENGINE_GEAR_5, T.ENGINE_GEAR_6].filter((r) => r > 0.01)
    spec.finalDrive = T.ENGINE_FINAL_DRIVE
    spec.tyreRadius = T.ENGINE_TYRE_RADIUS
    spec.idleRpm = T.ENGINE_IDLE_RPM
    spec.redlineRpm = T.ENGINE_REDLINE_RPM
    spec.shiftUpRpm = T.ENGINE_SHIFT_UP_RPM
    spec.shiftDownRpm = Math.min(T.ENGINE_SHIFT_DOWN_RPM, T.ENGINE_SHIFT_UP_RPM * 0.9)
    spec.shiftSeconds = T.ENGINE_SHIFT_SECONDS
    if (this.drivetrain.gear >= spec.gearRatios.length) this.drivetrain.reset()

    if (this.state !== 'running' || !this.sim) return

    const wanted = ENGINES[Math.round(T.ENGINE_INDEX)]?.path
    if (wanted && wanted !== this.enginePath) {
      this.enginePath = wanted
      void this.setEngine(wanted)
      return // the load re-applies the voicing on the way out
    }

    if (T.ENGINE_SIM_HZ > 0 && T.ENGINE_SIM_HZ !== this.lastSimHz) {
      this.lastSimHz = T.ENGINE_SIM_HZ
      this.sim.setSimFrequency(T.ENGINE_SIM_HZ)
    }
    this.applyVoicing()
  }

  /**
   * The synthesizer knobs, but only when asked for.
   *
   * Every engine script ships its own voicing, and a V12 wants different jitter and noise from a
   * single-cylinder quad engine. Forcing the panel's numbers onto whatever is loaded would mean
   * switching engines quietly re-voiced it to the last thing you tuned, so the override is a knob
   * and its defaults are the GM LS's own values — turning it on changes nothing until you move
   * something.
   */
  private applyVoicing(): void {
    if (!this.sim) return
    if (T.ENGINE_VOICE_OVERRIDE < 0.5) return
    const wanted: Record<string, number> = {
      volume: T.ENGINE_VOLUME,
      convolution: T.ENGINE_CONVOLUTION,
      highFrequencyGain: T.ENGINE_HF_GAIN,
      highFrequencyNoise: T.ENGINE_HF_NOISE,
      highFrequencyNoiseCutoff: T.ENGINE_HF_CUTOFF,
      lowFrequencyNoise: T.ENGINE_LF_NOISE,
      lowFrequencyNoiseCutoff: T.ENGINE_LF_CUTOFF,
      levelerTarget: T.ENGINE_LEVELER_TARGET,
      levelerMaxGain: T.ENGINE_LEVELER_MAX_GAIN,
      levelerMinGain: T.ENGINE_LEVELER_MIN_GAIN,
    }
    for (const [key, value] of Object.entries(wanted)) {
      if (this.lastVoicing[key] === value) continue
      this.lastVoicing[key] = value
      this.sim.setParam(key, value)
    }
  }

  /** The engine script in use; swapping it recompiles inside the audio thread. */
  async setEngine(path: string): Promise<void> {
    if (!this.sim) return
    this.profile = await this.sim.load(path)
    this.enginePath = path
    // A load resets the synthesizer to the new script's own voicing, so anything the panel is
    // overriding has to be put back afterwards — and the cache has to forget what it thought.
    this.lastVoicing = {}
    this.lastSimHz = 0
    this.applyVoicing()
  }

  /** For the tuning panel: the simulator's own knobs. */
  setParam(key: string, value: number): void {
    this.sim?.setParam(key, value)
  }

  get telemetry() {
    return this.sim?.telemetry ?? null
  }
}

/**
 * An entity for the car you are driving: a place in the world and an engine, nothing else.
 *
 * Deliberately not `spawnVehicle` from actorworld.ts — that builds a traffic car, with `Autonomous`
 * and a `Visual` index into the catalog. The player's car is drawn by `car.ts` and driven by a
 * person, so the only things it owes the simulation are where it is and what its engine is doing.
 */
export function spawnPlayerEngine(world: World): number {
  const entity = addEntity(world)
  addComponent(world, entity, Transform)
  addComponent(world, entity, Engine)
  return entity
}
