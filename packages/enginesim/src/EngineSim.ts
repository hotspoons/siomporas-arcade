// The host side of the engine: creates the worklet, feeds it bytes, and exposes the controls.
//
// Everything expensive lives in the audio thread (see src/processor.js). This class owns only the
// node, the handshake and the last telemetry it was told about. It deliberately does not own an
// AudioContext — the caller passes one, because a game has exactly one and wants the engine
// alongside its other sound, panned into the world.

import { AUDIO_PARAMS, type AudioParamSpec, type EnginePreset } from './params'

export interface EngineTelemetry {
  /** Crankshaft speed the simulation actually reached. In follow mode this tracks what you asked. */
  rpm: number
  gear: number
  /** Newton-metres at the dynamometer, filtered. Meaningful in free mode. */
  torque: number
  /** Watts. */
  power: number
  /** Manifold pressure in pascals — the number that makes a boost gauge move. */
  manifold: number
  /** Metres per second of engine-sim's own vehicle. Only moves in free mode. */
  vehicleSpeed: number
}

export interface EngineProfile {
  name: string
  cylinders: number
  /** Radians per second, as the script declared it. Divide by `RPM_PER_RAD` for RPM. */
  redline: number
  /** Cubic metres. */
  displacement: number
  simFrequency: number
  params: number[]
}

export interface EngineSimOptions {
  /** Where `wasm/` is served from. Defaults to the files next to this module. */
  wasmUrl?: URL | string
  workletUrl?: URL | string
  /** Convolution tail cap. The default keeps the whole thing; see native/apex_enginesim.cpp. */
  irLimit?: number
  /**
   * Output gain applied after every load, 0..1. Not 1.
   *
   * Upstream's default is 1.0 and its automatic leveler drives towards 30000 of a 16-bit range, so
   * a stock engine lands hard against the clamp inside the synthesizer — measurably, peak 1.000 on
   * a V8 at part throttle. That is clipping, not loudness, and no amount of gain staging downstream
   * undoes it because it has already happened in integer land. Turn it down here, where it is still
   * a float.
   */
  volume?: number
  onTelemetry?: (telemetry: EngineTelemetry) => void
  onError?: (message: string) => void
}

/** engine-sim reports redline and dyno speeds in radians per second. */
export const RPM_PER_RAD = 60 / (2 * Math.PI)

const PROCESSOR = 'apex-enginesim'

/** See EngineSimOptions.volume for why this is not 1. */
const DEFAULT_VOLUME = 0.25

/**
 * One running engine.
 *
 * ```ts
 * const engine = await EngineSim.create(audioContext)
 * await engine.load('engines/atg-video-2/07_gm_ls.mr')
 * engine.connect(pannerNode)
 * engine.drive(rpm, throttle)   // every frame
 * ```
 */
export class EngineSim {
  readonly node: AudioWorkletNode
  readonly context: BaseAudioContext

  private readonly rpmParam: AudioParam
  private readonly pedalParam: AudioParam
  private readonly clutchParam: AudioParam
  private readonly options: EngineSimOptions
  private pendingLoad: { resolve: (p: EngineProfile) => void; reject: (e: Error) => void } | null =
    null

  /** Last telemetry the worklet sent, ~23 times a second. Read it; do not expect it per frame. */
  telemetry: EngineTelemetry = {
    rpm: 0, gear: -1, torque: 0, power: 0, manifold: 0, vehicleSpeed: 0,
  }
  profile: EngineProfile | null = null

  private constructor(context: BaseAudioContext, node: AudioWorkletNode,
    options: EngineSimOptions)
  {
    this.context = context
    this.node = node
    this.options = options
    this.rpmParam = node.parameters.get('rpm') as AudioParam
    this.pedalParam = node.parameters.get('pedal') as AudioParam
    this.clutchParam = node.parameters.get('clutch') as AudioParam

    node.port.onmessage = (event: MessageEvent) => {
      const message = event.data
      switch (message.type) {
        case 'telemetry':
          this.telemetry = message as EngineTelemetry
          options.onTelemetry?.(this.telemetry)
          break
        case 'loaded':
          this.profile = message.profile as EngineProfile
          this.pendingLoad?.resolve(this.profile)
          this.pendingLoad = null
          break
        case 'error':
          this.pendingLoad?.reject(new Error(message.error))
          this.pendingLoad = null
          options.onError?.(message.error)
          break
        default:
          break
      }
    }
  }

  /**
   * Register the worklet, instantiate the wasm inside it, and hand back a node ready to load an
   * engine. The wasm is fetched here and transferred in: an AudioWorkletGlobalScope has no fetch,
   * so the bytes have to arrive over the port.
   */
  static async create(context: BaseAudioContext, options: EngineSimOptions = {})
    : Promise<EngineSim>
  {
    const workletUrl = options.workletUrl ?? new URL('../wasm/worklet.js', import.meta.url)
    const wasmUrl = options.wasmUrl ?? new URL('../wasm/enginesim.wasm', import.meta.url)

    await context.audioWorklet.addModule(workletUrl.toString())
    const response = await fetch(wasmUrl.toString())
    if (!response.ok) {
      throw new Error(`enginesim.wasm: ${response.status} ${response.statusText}`)
    }
    const wasmBinary = await response.arrayBuffer()

    const node = new AudioWorkletNode(context, PROCESSOR, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    const engine = new EngineSim(context, node, options)

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('The engine worklet did not report ready within 20s')), 20_000)
      const previous = node.port.onmessage
      node.port.onmessage = (event: MessageEvent) => {
        if (event.data?.type === 'ready') {
          clearTimeout(timer)
          node.port.onmessage = previous
          resolve()
        } else if (event.data?.type === 'error') {
          clearTimeout(timer)
          reject(new Error(event.data.error))
        }
      }
      // Transferring detaches the buffer here, which is what we want: one copy, in the audio thread.
      node.port.postMessage({ type: 'init', wasmBinary, irLimit: options.irLimit }, [wasmBinary])
    })

    return engine
  }

  /** Compile one of the embedded engines. Resolves with what the script turned out to describe. */
  load(path: string): Promise<EngineProfile> {
    return this.compile({ type: 'load', path })
  }

  /** Compile engine script source. The editor's hot-reload path. */
  loadSource(source: string): Promise<EngineProfile> {
    return this.compile({ type: 'load', source })
  }

  /** Apply a saved voicing: the engine, then whichever knobs were moved off the script's defaults. */
  async apply(preset: EnginePreset): Promise<EngineProfile> {
    if (preset.irLimit) this.node.port.postMessage({ type: 'irLimit', value: preset.irLimit })
    const profile = await this.load(preset.engine)
    if (preset.simFrequency) this.setSimFrequency(preset.simFrequency)
    for (const [key, value] of Object.entries(preset.params ?? {})) {
      if (value !== undefined) this.setParam(key, value)
    }
    return profile
  }

  private compile(message: Record<string, unknown>): Promise<EngineProfile> {
    // Compiling stops the world in the audio thread for as long as Piranha takes, so mute across it
    // rather than letting the tail of the previous engine stutter into the new one.
    this.pendingLoad?.reject(new Error('Superseded by another load'))
    this.node.port.postMessage({ type: 'mute', value: true })
    const done = new Promise<EngineProfile>((resolve, reject) => {
      this.pendingLoad = { resolve, reject }
    })
    this.node.port.postMessage(message)
    return done
      .then((profile) => {
        // Every load resets the synthesizer to what the script asked for, so the gain has to be
        // re-applied here rather than once at construction.
        this.setParam('volume', this.options.volume ?? DEFAULT_VOLUME)
        return profile
      })
      .finally(() => this.node.port.postMessage({ type: 'mute', value: false }))
  }

  /**
   * The game's per-frame call. `rpm` is whatever your own drivetrain decided, `pedal` is 0..1.
   *
   * Both are ramped rather than set, and that is not decoration: at 60 fps a stepped RPM is a
   * 16 ms staircase and you can hear every tread. `smoothing` is the time constant in seconds.
   */
  drive(rpm: number, pedal: number, smoothing = 0.02): void {
    const at = this.context.currentTime
    this.rpmParam.setTargetAtTime(Math.max(0, rpm), at, smoothing)
    this.pedalParam.setTargetAtTime(Math.min(1, Math.max(0, pedal)), at, smoothing)
  }

  /** 1 engaged, 0 disengaged. Only meaningful in free mode. */
  setClutch(pressure: number, smoothing = 0.05): void {
    this.clutchParam.setTargetAtTime(
      Math.min(1, Math.max(0, pressure)), this.context.currentTime, smoothing)
  }

  setGear(gear: number): void {
    this.node.port.postMessage({ type: 'gear', value: gear })
  }

  setIgnition(on: boolean): void {
    this.node.port.postMessage({ type: 'ignition', value: on })
  }

  setStarter(on: boolean): void {
    this.node.port.postMessage({ type: 'starter', value: on })
  }

  /**
   * Hand the drivetrain back to engine-sim: it drives its own vehicle through its own gearbox, and
   * `drive()`'s rpm argument stops meaning anything. This is the editor's dyno, not the game's path.
   */
  setFree(options: { dyno?: boolean; hold?: boolean; rpm?: number } = {}): void {
    this.node.port.postMessage({
      type: 'free',
      dyno: options.dyno ?? false,
      hold: options.hold ?? false,
      rpm: options.rpm ?? 0,
    })
  }

  setParam(key: string, value: number): void {
    const spec: AudioParamSpec | undefined = AUDIO_PARAMS.find((p) => p.key === key)
    if (!spec) throw new Error(`Unknown engine audio parameter: ${key}`)
    this.node.port.postMessage({ type: 'param', id: spec.id, value })
    if (this.profile) this.profile.params[spec.id] = value
  }

  /**
   * Physics steps per second. The first thing to turn down on a machine that cannot keep up — it
   * costs more than the convolution tail does. Upstream's range is 400 to 400000; engine scripts
   * usually ask for 10000.
   */
  setSimFrequency(hz: number): void {
    this.node.port.postMessage({ type: 'simFrequency', value: Math.round(hz) })
  }

  connect(destination: AudioNode): AudioNode {
    return this.node.connect(destination)
  }

  /**
   * The worklet itself, for graphs that need to fan it out rather than chain it.
   *
   * `connect` covers the common case; a spatialiser sends the same source down two buses (see
   * SpatialVoice), and doing that through two `connect` calls works but reads as if there were two
   * engines. This says plainly that there is one.
   */
  get output(): AudioNode {
    return this.node
  }

  disconnect(): void {
    this.node.disconnect()
  }

  /** Silence without tearing the node down; the simulation stops advancing too. */
  setMuted(muted: boolean): void {
    this.node.port.postMessage({ type: 'mute', value: muted })
  }
}
