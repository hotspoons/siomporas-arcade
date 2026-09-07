// Engine, tyres, turbo, bumps — and a radio with three original stations you
// tune before the run, each a little sequenced synth tune with its own tempo.

import type { SimEvent } from '../sim/Events'
import type { Snapshot } from '../sim/Snapshot'

export interface Volumes {
  master: number
  music: number
  sfx: number
  engine: number
}

interface Station {
  name: string
  bpm: number
  root: number
  bass: number[]
  lead: number[]
  scale: number[]
  leadWave: OscillatorType
}

export const STATIONS: Station[] = [
  { name: 'Splash Wave FM', bpm: 128, root: 55, bass: [0, 0, 7, 0, 5, 5, 3, 0], lead: [0, 4, 7, 9, 7, 4, 2, 4, 0, 4, 7, 11, 9, 7, 4, 2], scale: [0, 2, 4, 5, 7, 9, 11], leadWave: 'square' },
  { name: 'Magic Coast Radio', bpm: 112, root: 49, bass: [0, 3, 0, 5, 0, 3, 7, 5], lead: [7, 5, 3, 0, 3, 5, 7, 10, 7, 5, 3, 0, 5, 3, 0, 0], scale: [0, 2, 3, 5, 7, 8, 10], leadWave: 'triangle' },
  { name: 'Passing Breeze', bpm: 140, root: 61, bass: [0, 0, 5, 5, 3, 3, 7, 7], lead: [0, 2, 4, 7, 9, 7, 4, 2, 4, 7, 9, 12, 9, 7, 4, 0], scale: [0, 2, 4, 7, 9], leadWave: 'sawtooth' },
]

export class AudioWorld {
  private ctx: AudioContext | null = null
  private master!: GainNode
  private engineBus!: GainNode
  private sfxBus!: GainNode
  private musicBus!: GainNode
  private engineOscs: OscillatorNode[] = []
  private engineFilter!: BiquadFilterNode
  private screechGain!: GainNode
  private noiseBuffer!: AudioBuffer
  private volumes: Volumes = { master: 0.8, music: 0.6, sfx: 0.9, engine: 0.6 }
  private muted = false
  private running = false
  private station = 0
  private nextBeat = 0
  private beat = 0
  musicOn = true

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
    this.musicBus = ctx.createGain()
    this.engineBus.connect(this.master)
    this.sfxBus.connect(this.master)
    this.musicBus.connect(this.master)
    this.noiseBuffer = noise(ctx, 2)
    this.engineFilter = ctx.createBiquadFilter()
    this.engineFilter.type = 'lowpass'
    this.engineFilter.frequency.value = 800
    this.engineFilter.Q.value = 2
    this.engineFilter.connect(this.engineBus)
    for (const [type, det, g] of [
      ['sawtooth', 0, 0.5],
      ['square', -1200, 0.3],
    ] as const) {
      const o = ctx.createOscillator()
      o.type = type
      o.detune.value = det
      o.frequency.value = 70
      const og = ctx.createGain()
      og.gain.value = g
      o.connect(og).connect(this.engineFilter)
      o.start()
      this.engineOscs.push(o)
    }
    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuffer
    src.loop = true
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 2400
    bp.Q.value = 6
    this.screechGain = ctx.createGain()
    this.screechGain.gain.value = 0
    src.connect(bp).connect(this.screechGain).connect(this.sfxBus)
    src.start()
    this.nextBeat = ctx.currentTime + 0.1
    this.applyVolumes()
  }

  setVolumes(v: Volumes): void {
    this.volumes = v
    this.applyVolumes()
  }
  setMuted(m: boolean): void {
    this.muted = m
    this.applyVolumes()
  }
  setRunning(on: boolean): void {
    this.running = on
    this.applyVolumes()
  }
  setStation(i: number): void {
    this.station = i
    this.beat = 0
  }
  private applyVolumes(): void {
    if (!this.ctx) return
    this.master.gain.value = this.muted ? 0 : this.volumes.master
    this.engineBus.gain.value = this.running ? this.volumes.engine * 0.3 : 0
    this.sfxBus.gain.value = this.volumes.sfx
    this.musicBus.gain.value = this.musicOn ? this.volumes.music * 0.35 : 0
  }

  update(snap: Snapshot, sliding: boolean): void {
    const ctx = this.ctx
    if (!ctx) return
    const now = ctx.currentTime
    const r = snap.speed / snap.maxSpeed
    const hz = 60 + ((r * 4) % 1) * 140 + Math.floor(r * 4) * 20
    for (const o of this.engineOscs) o.frequency.setTargetAtTime(hz, now, 0.05)
    this.engineFilter.frequency.setTargetAtTime(500 + r * 2200 + (snap.hud.turboActive ? 1500 : 0), now, 0.08)
    this.screechGain.gain.setTargetAtTime(sliding ? 0.2 : 0, now, 0.05)
    const st = STATIONS[this.station] ?? STATIONS[0]
    const beatLen = 60 / st.bpm / 2
    while (this.nextBeat < now + 0.25) {
      this.scheduleBeat(st, this.nextBeat, this.beat, beatLen)
      this.nextBeat += beatLen
      this.beat++
    }
  }

  private scheduleBeat(st: Station, t: number, beat: number, len: number): void {
    if (!this.musicOn) return
    if (beat % 2 === 0) this.kick(t)
    if (beat % 4 === 2) this.snare(t)
    this.hat(t, beat % 2 === 1 ? 0.18 : 0.08)
    if (beat % 2 === 0) {
      const b = st.bass[(beat / 2) % st.bass.length]
      this.tone(st.root * Math.pow(2, b / 12), t, len * 1.7, 0.4, 'sawtooth', 300)
    }
    const phrase = Math.floor(beat / 32) % 4
    if (phrase !== 1) {
      const n = st.lead[beat % st.lead.length]
      const deg = st.scale[n % st.scale.length] + 12 * Math.floor(n / st.scale.length)
      this.tone(st.root * 4 * Math.pow(2, deg / 12), t, len * 0.85, 0.11, st.leadWave, 2600)
      if (phrase === 3) this.tone(st.root * 2 * Math.pow(2, (deg + 4) / 12), t, len * 0.8, 0.06, 'triangle', 1800)
    }
  }
  private kick(t: number): void {
    const ctx = this.ctx!
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.frequency.setValueAtTime(150, t)
    o.frequency.exponentialRampToValueAtTime(40, t + 0.1)
    g.gain.setValueAtTime(0.9, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2)
    o.connect(g).connect(this.musicBus)
    o.start(t)
    o.stop(t + 0.22)
  }
  private snare(t: number): void {
    const ctx = this.ctx!
    const s = ctx.createBufferSource()
    s.buffer = this.noiseBuffer
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 1800
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.35, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12)
    s.connect(bp).connect(g).connect(this.musicBus)
    s.start(t, Math.random())
    s.stop(t + 0.13)
  }
  private hat(t: number, level: number): void {
    const ctx = this.ctx!
    const s = ctx.createBufferSource()
    s.buffer = this.noiseBuffer
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 8000
    const g = ctx.createGain()
    g.gain.setValueAtTime(level, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.04)
    s.connect(hp).connect(g).connect(this.musicBus)
    s.start(t, Math.random())
    s.stop(t + 0.05)
  }
  private tone(freq: number, t: number, dur: number, level: number, type: OscillatorType, cutoff: number): void {
    const ctx = this.ctx!
    const o = ctx.createOscillator()
    o.type = type
    o.frequency.value = freq
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = cutoff
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(level, t + 0.01)
    g.gain.exponentialRampToValueAtTime(0.001, t + dur)
    o.connect(f).connect(g).connect(this.musicBus)
    o.start(t)
    o.stop(t + dur + 0.05)
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
  private burst(dur: number, level: number, cutoff: number): void {
    const ctx = this.ctx!
    const t = ctx.currentTime
    const s = ctx.createBufferSource()
    s.buffer = this.noiseBuffer
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = cutoff
    const g = ctx.createGain()
    g.gain.setValueAtTime(level, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + dur)
    s.connect(f).connect(g).connect(this.sfxBus)
    s.start(t, Math.random())
    s.stop(t + dur + 0.02)
  }
  ui(kind: 'move' | 'select'): void {
    if (this.ctx) this.blip(kind === 'move' ? 660 : 880, 0.05, 0.12, 'square')
  }
  onEvent(e: SimEvent): void {
    if (!this.ctx) return
    switch (e.type) {
      case 'crash':
        this.thud(140, 30, 0.9, 1)
        this.burst(0.9, 0.9, 2500)
        break
      case 'bump':
        this.thud(200, 80, 0.2, 0.6)
        this.burst(0.15, 0.4, 1500)
        break
      case 'checkpoint':
        for (let i = 0; i < 3; i++) setTimeout(() => this.ctx && this.blip(660 * Math.pow(2, i / 6), 0.25, 0.3, 'triangle'), i * 100)
        break
      case 'turbo':
        this.burst(0.8, 0.5, 6000)
        this.thud(80, 220, 0.6, 0.4)
        break
      case 'gear':
        this.blip(e.a === 1 ? 440 : 330, 0.08, 0.2, 'square')
        break
      case 'offroad':
        this.burst(0.3, 0.3, 800)
        break
      case 'pass':
        this.blip(900, 0.06, 0.08, 'sine')
        break
      case 'timeout':
        this.thud(220, 55, 1.2, 0.6)
        break
      case 'finish':
        for (let i = 0; i < 6; i++) setTimeout(() => this.ctx && this.blip(523 * Math.pow(2, i / 6), 0.4, 0.3, 'triangle'), i * 110)
        break
      default:
        break
    }
  }
}

function noise(ctx: AudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  return buf
}
