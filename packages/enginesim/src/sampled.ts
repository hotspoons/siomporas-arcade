// A baked engine, playing. The cheap half of the pair.
//
// `EngineSim` is the real thing: a rigid-body solver in the audio thread, about 45% of a core,
// and the note is the actual resonance of the actual cylinders. This is the same engine recorded
// (scripts/bake.mjs) and played back on four buffer sources, which is what the other twenty cars
// on the road get.
//
// THE SAME INTERFACE, deliberately. `drive(rpm, pedal)` and an `output` node, exactly as
// EngineSim has, so corridor's SpatialVoice does not know or care which it is feeding and a
// traffic car can be promoted to the simulated voice by swapping one object.
//
// FOUR SOURCES, NOT ONE PER LAYER. The rev is between two layers and the throttle is between
// closed and open, so the mix is a bilinear blend of four recordings: (lo, off), (hi, off),
// (lo, on), (hi, on). Keeping every layer playing at zero gain would be simpler and costs twenty
// buffer sources per car; four is the whole point of the exercise.
//
// EQUAL-GAIN BLENDING, not equal-power, in both directions. The four are recordings of the same
// engine and are strongly correlated, so they sum coherently and a √ law would be 3 dB loud in
// the middle — the same reason the interior and exterior buses in voice.ts blend linearly.

import { bracket, playbackRate, type EnginePack, type PackLayer } from './pack'

/** One slot in the mix: a source that can be re-pointed at a different layer while silent. */
class Slot {
  readonly gain: GainNode
  private source: AudioBufferSourceNode | null = null
  private layer: PackLayer | null = null
  private readonly ctx: BaseAudioContext
  private readonly buffers: Map<string, AudioBuffer>

  constructor(ctx: BaseAudioContext, buffers: Map<string, AudioBuffer>, out: AudioNode) {
    this.ctx = ctx
    this.buffers = buffers
    this.gain = ctx.createGain()
    this.gain.gain.value = 0
    this.gain.connect(out)
  }

  /**
   * Point this slot at a layer. Restarts the source, which is why it is only ever done while the
   * slot is silent — an AudioBufferSourceNode is a one-shot object and cannot be re-pointed.
   */
  private use(layer: PackLayer): void {
    const buffer = this.buffers.get(layer.file)
    if (!buffer) return
    this.source?.stop()
    this.source?.disconnect()
    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    src.loop = true
    // In SECONDS, from the manifest, not in samples: `decodeAudioData` resamples to the context's
    // rate, so a 48 kHz bake in a 44.1 kHz context no longer has the sample counts it was baked
    // with. The loop is a whole number of engine CYCLES, and that survives resampling.
    src.loopStart = layer.loopStart
    src.loopEnd = layer.loopEnd
    src.connect(this.gain)
    // A random start offset, so four cars on the same street do not phase-lock into one loud car.
    src.start(0, layer.loopStart + Math.random() * Math.max(1e-4, layer.loopEnd - layer.loopStart))
    this.source = src
    this.layer = layer
  }

  set(layer: PackLayer | null, gain: number, rpm: number, when: number, glide: number): void {
    if (!layer) {
      this.gain.gain.setTargetAtTime(0, when, glide)
      return
    }
    if (this.layer !== layer) {
      // SWAP WHILE SILENT. Re-pointing restarts the source at a random phase, which is a
      // discontinuity; doing it at zero gain makes it inaudible. The bracket only moves when the
      // crossfade has run to one end, so by then this slot's gain is already zero.
      if (this.gain.gain.value > 0.02 && this.layer) this.gain.gain.setValueAtTime(0, when)
      this.use(layer)
    }
    if (this.source) this.source.playbackRate.setTargetAtTime(playbackRate(layer.rpm, rpm), when, glide)
    this.gain.gain.setTargetAtTime(gain, when, glide)
  }

  dispose(): void {
    this.source?.stop()
    this.source?.disconnect()
    this.gain.disconnect()
  }
}

export interface SampledEngineOptions {
  /** AudioParam time constant. ~3 frames at 60 Hz by default. */
  glide?: number
}

export class SampledEngine {
  readonly output: GainNode
  readonly pack: EnginePack
  private readonly slots: [Slot, Slot, Slot, Slot]
  private readonly off: PackLayer[]
  private readonly on: PackLayer[]
  private readonly ctx: BaseAudioContext
  private readonly glide: number

  private constructor(ctx: BaseAudioContext, pack: EnginePack, buffers: Map<string, AudioBuffer>, options: SampledEngineOptions) {
    this.ctx = ctx
    this.pack = pack
    this.glide = options.glide ?? 0.05
    this.output = ctx.createGain()
    this.off = pack.layers.filter((l) => l.pedal === 0).sort((a, b) => a.rpm - b.rpm)
    this.on = pack.layers.filter((l) => l.pedal === 1).sort((a, b) => a.rpm - b.rpm)
    this.slots = [
      new Slot(ctx, buffers, this.output), new Slot(ctx, buffers, this.output),
      new Slot(ctx, buffers, this.output), new Slot(ctx, buffers, this.output),
    ]
  }

  /**
   * Fetch a pack and decode every layer in it.
   *
   * All of them, up front. A pack is a few hundred kilobytes and a car that streamed its layers
   * would fall silent at exactly the moment it revved — which is the moment you were listening.
   */
  static async load(
    ctx: BaseAudioContext, dir: string, options: SampledEngineOptions = {},
  ): Promise<SampledEngine> {
    const base = dir.replace(/\/$/, '')
    const pack = (await (await fetch(`${base}/pack.json`)).json()) as EnginePack
    const buffers = new Map<string, AudioBuffer>()
    await Promise.all(pack.layers.map(async (l) => {
      if (buffers.has(l.file)) return
      const bytes = await (await fetch(`${base}/${l.file}`)).arrayBuffer()
      buffers.set(l.file, await ctx.decodeAudioData(bytes))
    }))
    return new SampledEngine(ctx, pack, buffers, options)
  }

  /**
   * The whole interface: how fast it is turning and how far the throttle is open.
   *
   * Same two numbers as `EngineSim.drive`, because they are the same two numbers an `Engine`
   * component holds and the same two that decide what a combustion engine sounds like.
   */
  drive(rpm: number, pedal: number): void {
    const when = this.ctx.currentTime
    const t = Math.min(1, Math.max(0, pedal))
    const revs = Math.max(1, rpm)
    // The two ladders are bracketed independently: an engine's overrun set and its wide-open set
    // need not cover the same range, and on this catalog they do not.
    const a = bracket(this.off, revs)
    const b = bracket(this.on, revs)
    this.slots[0].set(this.off[a.lo] ?? null, (1 - a.t) * (1 - t), revs, when, this.glide)
    this.slots[1].set(this.off[a.hi] ?? null, a.t * (1 - t), revs, when, this.glide)
    this.slots[2].set(this.on[b.lo] ?? null, (1 - b.t) * t, revs, when, this.glide)
    this.slots[3].set(this.on[b.hi] ?? null, b.t * t, revs, when, this.glide)
  }

  /** For tests and probes: the four gains and rates actually in force. */
  get state() {
    return this.slots.map((s) => +s.gain.gain.value.toFixed(4))
  }

  disconnect(): void {
    for (const s of this.slots) s.dispose()
    this.output.disconnect()
  }
}
