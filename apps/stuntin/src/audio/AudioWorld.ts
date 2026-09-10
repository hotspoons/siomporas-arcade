// Procedural car audio: an engine with a fake gearbox, tyre screech from slip,
// wind with speed, curb rumble, crash, lap chime, UI blips.

import type { SimEvent } from '../sim/Events'
import type { Snapshot } from '../sim/Snapshot'

export interface Volumes {
  master: number
  music: number
  sfx: number
  engine: number
}

export class AudioWorld {
  private ctx: AudioContext | null = null
  private master!: GainNode
  private engineBus!: GainNode
  private sfxBus!: GainNode
  private engineOscs: OscillatorNode[] = []
  private engineFilter!: BiquadFilterNode
  private screechGain!: GainNode
  private windGain!: GainNode
  private noiseBuffer!: AudioBuffer
  private volumes: Volumes = { master: 0.8, music: 0.4, sfx: 0.9, engine: 0.8 }
  private muted = false
  private running = false

  resume(): void {
    if (!this.ctx) this.init()
    if (this.ctx?.state === 'suspended') void this.ctx.resume()
  }

  private init(): void {
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    this.ctx = ctx
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -6
    limiter.ratio.value = 16
    this.master = ctx.createGain()
    this.master.connect(limiter).connect(ctx.destination)
    this.engineBus = ctx.createGain()
    this.sfxBus = ctx.createGain()
    this.engineBus.connect(this.master)
    this.sfxBus.connect(this.master)
    this.noiseBuffer = noise(ctx, 2)
    // Engine: saw + square an octave down + a rough saw a fifth up, lowpassed.
    this.engineFilter = ctx.createBiquadFilter()
    this.engineFilter.type = 'lowpass'
    this.engineFilter.frequency.value = 900
    this.engineFilter.Q.value = 3
    this.engineFilter.connect(this.engineBus)
    for (const [type, det, g] of [
      ['sawtooth', 0, 0.5],
      ['square', -1200, 0.35],
      ['sawtooth', 702, 0.18],
    ] as const) {
      const o = ctx.createOscillator()
      o.type = type
      o.detune.value = det
      o.frequency.value = 80
      const og = ctx.createGain()
      og.gain.value = g
      o.connect(og).connect(this.engineFilter)
      o.start()
      this.engineOscs.push(o)
    }
    // Screech: bandpassed noise with a wobble.
    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuffer
    src.loop = true
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 2200
    bp.Q.value = 8
    this.screechGain = ctx.createGain()
    this.screechGain.gain.value = 0
    src.connect(bp).connect(this.screechGain).connect(this.sfxBus)
    src.start()
    // Wind.
    const wind = ctx.createBufferSource()
    wind.buffer = this.noiseBuffer
    wind.loop = true
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 600
    this.windGain = ctx.createGain()
    this.windGain.gain.value = 0
    wind.connect(lp).connect(this.windGain).connect(this.sfxBus)
    wind.start(0, 0.7)
    this.applyVolumes()
  }

  setVolumes(v: Volumes): void {
    this.volumes = v
    this.applyVolumes()
  }

  /**
   * Close the audio hardware. A browser allows only a handful of AudioContexts per page, and the
   * arcade opens one per game entered, so leaving one running is not merely untidy — the fourth or
   * fifth game to be started gets no sound at all.
   */
  dispose(): void {
    const ctx = this.ctx
    this.ctx = null
    void ctx?.close().catch(() => {
      /* already closed, or closing on a context the page is tearing down anyway */
    })
  }

  setMuted(m: boolean): void {
    this.muted = m
    this.applyVolumes()
  }

  setRunning(on: boolean): void {
    this.running = on
    this.applyVolumes()
  }

  private applyVolumes(): void {
    if (!this.ctx) return
    this.master.gain.value = this.muted ? 0 : this.volumes.master
    this.engineBus.gain.value = this.running ? this.volumes.engine * 0.35 : 0
    this.sfxBus.gain.value = this.volumes.sfx
  }

  update(snap: Snapshot): void {
    if (!this.ctx) return
    const now = this.ctx.currentTime
    const h = snap.hud
    const rpm = h.rpm
    const hz = 55 + rpm * 190 + h.gear * 6
    for (const o of this.engineOscs) o.frequency.setTargetAtTime(hz, now, 0.04)
    this.engineFilter.frequency.setTargetAtTime(500 + rpm * 1800 + snap.car.throttle * 400, now, 0.06)
    const screech = snap.car.mode === 'track' && !snap.car.onGrass ? snap.car.slip : 0
    this.screechGain.gain.setTargetAtTime(screech * 0.25, now, 0.05)
    this.windGain.gain.setTargetAtTime(Math.min(1, h.speed / 80) ** 2 * 0.2, now, 0.2)
  }

  ui(kind: 'move' | 'select'): void {
    if (!this.ctx) return
    this.blip(kind === 'move' ? 660 : 880, 0.05, 0.12, 'square')
  }

  onEvent(e: SimEvent): void {
    if (!this.ctx) return
    switch (e.type) {
      case 'crash':
        this.thud(120, 25, 1.0, 1.0)
        this.noiseBurst(1.0, 0.9, 2500, 90)
        break
      case 'land':
        this.thud(140, 50, 0.25, 0.6)
        this.noiseBurst(0.2, 0.3, 1200)
        break
      case 'curb':
        this.noiseBurst(0.04, 0.25, 500)
        break
      case 'bump':
        this.thud(110, 40, 0.2, Math.min(1, 0.3 + e.a / 30))
        this.noiseBurst(Math.min(0.6, 0.1 + e.a / 40), 0.2, 900)
        break
      case 'rocket':
        // A rising whistle: gravity has left the building.
        this.noiseBurst(0.5, 1.4, 4000)
        for (let i = 0; i < 6; i++) setTimeout(() => this.ctx && this.blip(400 + i * 260, 0.18, 0.12, 'sine'), i * 90)
        break
      case 'lap':
        this.blip(659, 0.2, 0.3, 'triangle')
        setTimeout(() => this.ctx && this.blip(988, 0.3, 0.3, 'triangle'), 110)
        break
      case 'respawn':
        this.blip(330, 0.15, 0.2, 'sawtooth')
        break
      case 'offroad':
        this.noiseBurst(0.3, 0.3, 700)
        break
      default:
        break
    }
  }

  private blip(freq: number, dur: number, level: number, type: OscillatorType): void {
    const ctx = this.ctx!
    const t = ctx.currentTime
    const o = ctx.createOscillator()
    o.type = type
    o.frequency.value = freq
    const g = ctx.createGain()
    g.gain.setValueAtTime(level, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + dur)
    o.connect(g).connect(this.sfxBus)
    o.start(t)
    o.stop(t + dur + 0.02)
  }

  private thud(from: number, to: number, dur: number, level: number): void {
    const ctx = this.ctx!
    const t = ctx.currentTime
    const o = ctx.createOscillator()
    o.frequency.setValueAtTime(from, t)
    o.frequency.exponentialRampToValueAtTime(to, t + dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(level, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + dur)
    o.connect(g).connect(this.sfxBus)
    o.start(t)
    o.stop(t + dur + 0.02)
  }

  private noiseBurst(dur: number, level: number, cutoff: number, sweepTo?: number): void {
    const ctx = this.ctx!
    const t = ctx.currentTime
    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuffer
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.setValueAtTime(cutoff, t)
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(level, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + dur)
    src.connect(f).connect(g).connect(this.sfxBus)
    src.start(t, Math.random())
    src.stop(t + dur + 0.02)
  }
}

function noise(ctx: AudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  return buf
}
