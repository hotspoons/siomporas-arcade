// The AudioWorkletProcessor that runs the engine.
//
// This file is not loaded directly. `scripts/bundle-worklet.mjs` concatenates the Emscripten glue
// from `wasm/enginesim.js` in front of it and writes `wasm/worklet.js`, which is what
// `audioWorklet.addModule()` gets. The concatenation is the point: an AudioWorkletGlobalScope is a
// module scope, so two separate addModule() calls cannot see each other's `var createEngineSim`.
//
// Plain JavaScript on purpose. It has to survive being pasted after generated code and loaded into
// a scope with no bundler, so there is nothing here to compile. The host that drives it,
// `EngineSim.ts`, is typed and carries the API surface.
//
// WHAT THIS SCOPE DOES NOT HAVE: no fetch, no XMLHttpRequest, no document, no setTimeout you should
// rely on, and in Chrome no `performance`. The wasm arrives as bytes over the port so no loader is
// ever entered, and the one unguarded global the glue touches is shimmed below.

/* global createEngineSim, registerProcessor, AudioWorkletProcessor, sampleRate, currentTime */

// Emscripten maps std::chrono::steady_clock onto emscripten_get_now, which is performance.now().
// The simulator calls it every frame to keep its own processing-time average, so without this the
// first render throws and the node goes permanently silent.
if (typeof performance === 'undefined') {
  globalThis.performance = { now: () => currentTime * 1000 }
}
if (typeof crypto === 'undefined') {
  globalThis.crypto = {
    getRandomValues(view) {
      for (let i = 0; i < view.length; i += 1) view[i] = (Math.random() * 0x100000000) >>> 0
      return view
    },
  }
}

const QUANTUM = 128

/** Keep in sync with the AudioParam enum in native/apex_enginesim.cpp and src/params.ts. */
const PARAM_COUNT = 10

class EngineSimProcessor extends AudioWorkletProcessor {
  // rpm, pedal and clutch are AudioParams rather than messages because the game touches them every
  // frame. A k-rate param gives exactly one value per render quantum, which is exactly how often
  // this processor consumes one, and it lets the caller ramp with setTargetAtTime instead of
  // flooding the port — a step change in pedal or held RPM is audible as a click.
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 0, minValue: 0, maxValue: 30000, automationRate: 'k-rate' },
      { name: 'pedal', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'clutch', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ]
  }

  constructor() {
    super()
    this.mod = null
    this.api = null
    this.buffer = 0
    this.ready = false
    this.failed = false
    this.muted = false
    this.telemetryCountdown = 0
    this.telemetryEvery = 16 // ~43 ms at 48 kHz: enough for a gauge, far below message-flood rates
    this.lastRpm = -1
    this.lastPedal = -1
    this.lastClutch = -1
    this.port.onmessage = (event) => this.onMessage(event.data)
  }

  async onMessage(message) {
    if (message.type === 'init') { await this.init(message); return }
    if (!this.ready) return
    switch (message.type) {
      case 'load': {
        // Compiling a Piranha script allocates and parses, which is exactly what real-time audio
        // code must not do — so it is deliberately not done from process(). The caller is expected
        // to have stopped or muted this node first; the glitch is one load, not a steady cost.
        const ok = message.source
          ? this.api.loadSource(message.source)
          : this.api.load(message.path)
        this.lastRpm = this.lastPedal = this.lastClutch = -1
        this.port.postMessage(ok === 1
          ? { type: 'loaded', name: this.api.name(), profile: this.profile() }
          : { type: 'error', error: this.api.error() })
        break
      }
      case 'gear': this.api.setGear(message.value); break
      case 'ignition': this.api.setIgnition(message.value ? 1 : 0); break
      case 'starter': this.api.setStarter(message.value ? 1 : 0); break
      case 'param': this.api.setParam(message.id, message.value); break
      case 'simFrequency': this.api.setSimFrequency(message.value); break
      case 'irLimit': this.api.setIrLimit(message.value); break
      case 'follow': this.api.followRpm(message.rpm); break
      case 'free': this.api.setFree(message.dyno ? 1 : 0, message.hold ? 1 : 0, message.rpm ?? 0); break
      case 'mute': this.muted = !!message.value; break
      default: break
    }
  }

  async init(message) {
    try {
      // Instantiate from the bytes the host sent rather than letting Emscripten load them.
      //
      // `wasmBinary` looks like the obvious option and does not work: Emscripten prunes the set of
      // Module properties it reads (INCOMING_MODULE_JS_API) and `wasmBinary` is not in the default
      // set, so it is silently ignored and the loader falls through to fetch — which this scope
      // does not have. The failure reads "both async and sync fetching of the wasm failed".
      // `instantiateWasm` is in the default set and is the documented hook, so it stays correct
      // even as the pinned SDK moves.
      this.mod = await createEngineSim({
        instantiateWasm: (imports, onDone) => {
          WebAssembly.instantiate(message.wasmBinary, imports)
            .then((result) => onDone(result.instance, result.module))
            .catch((error) => {
              this.failed = true
              this.port.postMessage({ type: 'error', error: `wasm instantiate: ${error}` })
            })
          return {} // Signals "asynchronous, wait for the callback".
        },
      })
      const mod = this.mod
      this.api = {
        init: mod.cwrap('es_init', 'number', ['number']),
        load: mod.cwrap('es_load', 'number', ['string']),
        loadSource: mod.cwrap('es_load_source', 'number', ['string']),
        error: mod.cwrap('es_error', 'string', []),
        name: mod.cwrap('es_name', 'string', []),
        render: mod.cwrap('es_render', 'number', ['number', 'number']),
        setPedal: mod.cwrap('es_set_pedal', null, ['number']),
        setIgnition: mod.cwrap('es_set_ignition', null, ['number']),
        setStarter: mod.cwrap('es_set_starter', null, ['number']),
        setClutch: mod.cwrap('es_set_clutch', null, ['number']),
        setGear: mod.cwrap('es_set_gear', null, ['number']),
        followRpm: mod.cwrap('es_set_follow_rpm', null, ['number']),
        setFree: mod.cwrap('es_set_free', null, ['number', 'number', 'number']),
        setSimFrequency: mod.cwrap('es_set_sim_frequency', null, ['number']),
        setIrLimit: mod.cwrap('es_set_ir_limit', null, ['number']),
        setParam: mod.cwrap('es_set_audio_param', null, ['number', 'number']),
        getParam: mod.cwrap('es_get_audio_param', 'number', ['number']),
        rpm: mod.cwrap('es_rpm', 'number', []),
        gear: mod.cwrap('es_gear', 'number', []),
        torque: mod.cwrap('es_torque', 'number', []),
        power: mod.cwrap('es_power', 'number', []),
        manifold: mod.cwrap('es_manifold_pressure', 'number', []),
        vehicleSpeed: mod.cwrap('es_vehicle_speed', 'number', []),
        cylinders: mod.cwrap('es_cylinders', 'number', []),
        redline: mod.cwrap('es_redline', 'number', []),
        displacement: mod.cwrap('es_displacement', 'number', []),
        simFrequency: mod.cwrap('es_sim_frequency', 'number', []),
      }
      this.buffer = mod._malloc(QUANTUM * 4)
      this.api.init(sampleRate)
      if (message.irLimit) this.api.setIrLimit(message.irLimit)
      this.ready = true
      this.port.postMessage({ type: 'ready', sampleRate })
    } catch (error) {
      this.failed = true
      this.port.postMessage({ type: 'error', error: String(error && error.message || error) })
    }
  }

  profile() {
    const params = []
    for (let i = 0; i < PARAM_COUNT; i += 1) params.push(this.api.getParam(i))
    return {
      name: this.api.name(),
      cylinders: this.api.cylinders(),
      redline: this.api.redline(),
      displacement: this.api.displacement(),
      simFrequency: this.api.simFrequency(),
      params,
    }
  }

  process(_inputs, outputs, parameters) {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const channel = output[0]

    if (!this.ready || this.muted) {
      channel.fill(0)
      for (let c = 1; c < output.length; c += 1) output[c].fill(0)
      return !this.failed
    }

    // k-rate params arrive as a one-element array. Only push a value across the FFI when it has
    // actually moved: es_set_follow_rpm also flips the dyno mode flags, so calling it every
    // quantum with an unchanged number is pure overhead in the one place that cannot afford it.
    const rpm = parameters.rpm[0]
    if (rpm !== this.lastRpm) { this.api.followRpm(rpm); this.lastRpm = rpm }
    const pedal = parameters.pedal[0]
    if (pedal !== this.lastPedal) { this.api.setPedal(pedal); this.lastPedal = pedal }
    const clutch = parameters.clutch[0]
    if (clutch !== this.lastClutch) { this.api.setClutch(clutch); this.lastClutch = clutch }

    const produced = this.api.render(this.buffer, channel.length)
    if (produced > 0) {
      // HEAPF32 has to be re-read every time: ALLOW_MEMORY_GROWTH replaces the backing buffer when
      // the heap grows, and a view captured at init would silently detach.
      const start = this.buffer >> 2
      channel.set(this.mod.HEAPF32.subarray(start, start + channel.length))
    } else {
      channel.fill(0)
    }
    // Mono source, so every other channel is the same signal. Placement in the world is the host's
    // job via a PannerNode; this node just makes the noise.
    for (let c = 1; c < output.length; c += 1) output[c].set(channel)

    if (--this.telemetryCountdown <= 0) {
      this.telemetryCountdown = this.telemetryEvery
      this.port.postMessage({
        type: 'telemetry',
        rpm: this.api.rpm(),
        gear: this.api.gear(),
        torque: this.api.torque(),
        power: this.api.power(),
        manifold: this.api.manifold(),
        vehicleSpeed: this.api.vehicleSpeed(),
      })
    }
    return true
  }
}

registerProcessor('apex-enginesim', EngineSimProcessor)
