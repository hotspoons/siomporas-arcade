// Procedural audio on the Web Audio API. No samples. The engine is three
// detuned oscillators plus a noise band whose pitch and filter track speed —
// it carries most of the speed sensation. A reverb bus opens up between
// enclosed tube and open air; weapons, impacts and a tempo-linked music
// sequencer sit on top. A limiter guards the output.

import type { SimEvent } from '../sim/Events'
import type { SimSnapshot, VehicleSnap } from '../sim/SimSnapshot'
import { TRAFFIC_KIND_CODES } from '../sim/SimSnapshot'
import { SPEED_CRUISE } from '../sim/Tuning'
import type { SettingsData } from '../app/Settings'

export type AudioScene = 'title' | 'run' | 'paused' | 'summary'

const ENGINE_BASE_HZ = 46
const ENGINE_HZ_PER_MS = 0.3
/** Music tempo follows speed: BPM at rest and per m/s. */
const BPM_BASE = 96
const BPM_PER_MS = 0.16
const SCHEDULE_AHEAD = 0.25

const SCALE = [0, 2, 3, 5, 7, 10] // minor pentatonic-ish
const BASS_PATTERN = [0, 0, 7, 0, 5, 0, 7, 3]
const LEAD_PATTERN = [0, 3, 5, 3, 7, 5, 10, 7, 12, 10, 7, 5, 3, 5, 3, 0]

export class AudioWorld {
  private ctx: AudioContext | null = null
  private master!: GainNode
  private limiter!: DynamicsCompressorNode
  private engineBus!: GainNode
  private sfxBus!: GainNode
  private musicBus!: GainNode
  private reverbSend!: GainNode
  private duck!: GainNode
  private engineOsc: OscillatorNode[] = []
  private engineFilter!: BiquadFilterNode
  private engineNoiseGain!: GainNode
  private laserGain!: GainNode
  private laserOsc!: OscillatorNode
  private noiseBuffer!: AudioBuffer
  private volumes: SettingsData['audio'] = { master: 0.8, music: 0.5, sfx: 0.9, engine: 0.7 }
  private scene: AudioScene = 'title'
  private muted = false
  private timeScale = 1
  private started = false
  private nextBeat = 0
  private beat = 0
  private openness = 0
  /** 0 = enclosed tube, 1 = open air. Set by the app from the profile arc. */
  openTarget = 0
  private engineLevel = 0

  /** Must be called from a user gesture to unlock the context. */
  resume(): void {
    if (!this.ctx) this.init()
    if (this.ctx?.state === 'suspended') void this.ctx.resume()
  }

  private init(): void {
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    this.ctx = ctx
    this.limiter = ctx.createDynamicsCompressor()
    this.limiter.threshold.value = -6
    this.limiter.knee.value = 4
    this.limiter.ratio.value = 16
    this.limiter.attack.value = 0.002
    this.limiter.release.value = 0.12
    this.master = ctx.createGain()
    this.duck = ctx.createGain()
    this.master.connect(this.duck).connect(this.limiter).connect(ctx.destination)
    this.engineBus = ctx.createGain()
    this.sfxBus = ctx.createGain()
    this.musicBus = ctx.createGain()
    this.engineBus.connect(this.master)
    this.sfxBus.connect(this.master)
    this.musicBus.connect(this.master)

    // Reverb: generated impulse, 1.8 s decaying noise.
    const conv = ctx.createConvolver()
    conv.buffer = impulse(ctx, 1.8, 2.2)
    this.reverbSend = ctx.createGain()
    this.reverbSend.gain.value = 0.35
    this.reverbSend.connect(conv).connect(this.master)
    this.sfxBus.connect(this.reverbSend)
    this.engineBus.connect(this.reverbSend)

    this.noiseBuffer = noise(ctx, 2)

    // Engine.
    this.engineFilter = ctx.createBiquadFilter()
    this.engineFilter.type = 'lowpass'
    this.engineFilter.frequency.value = 800
    this.engineFilter.Q.value = 2
    this.engineFilter.connect(this.engineBus)
    const detunes = [0, 7, -1205]
    const types: OscillatorType[] = ['sawtooth', 'sawtooth', 'square']
    for (let i = 0; i < 3; i++) {
      const o = ctx.createOscillator()
      o.type = types[i]
      o.detune.value = detunes[i]
      o.frequency.value = ENGINE_BASE_HZ
      const g = ctx.createGain()
      g.gain.value = i === 2 ? 0.35 : 0.5
      o.connect(g).connect(this.engineFilter)
      o.start()
      this.engineOsc.push(o)
    }
    const noiseSrc = ctx.createBufferSource()
    noiseSrc.buffer = this.noiseBuffer
    noiseSrc.loop = true
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 1200
    bp.Q.value = 0.7
    this.engineNoiseGain = ctx.createGain()
    this.engineNoiseGain.gain.value = 0
    noiseSrc.connect(bp).connect(this.engineNoiseGain).connect(this.engineBus)
    noiseSrc.start()

    // Laser: a continuous beam — two detuned saws under a high whine, through a
    // resonant lowpass whose cutoff is swept by a smooth sine LFO. No hard
    // gating: square-wave chopping is what made the old one yap.
    this.laserGain = ctx.createGain()
    this.laserGain.gain.value = 0
    const beamLp = ctx.createBiquadFilter()
    beamLp.type = 'lowpass'
    beamLp.frequency.value = 2600
    beamLp.Q.value = 6
    const lfo = ctx.createOscillator()
    lfo.type = 'sine'
    lfo.frequency.value = 17
    const lfoGain = ctx.createGain()
    lfoGain.gain.value = 900
    lfo.connect(lfoGain).connect(beamLp.frequency)
    lfo.start()
    for (const [f, det, g] of [
      [330, 0, 0.5],
      [330, 9, 0.5],
    ] as const) {
      const o = ctx.createOscillator()
      o.type = 'sawtooth'
      o.frequency.value = f
      o.detune.value = det
      const og = ctx.createGain()
      og.gain.value = g
      o.connect(og).connect(beamLp)
      o.start()
    }
    this.laserOsc = ctx.createOscillator()
    this.laserOsc.type = 'triangle'
    this.laserOsc.frequency.value = 2100
    const vib = ctx.createOscillator()
    vib.frequency.value = 6
    const vibGain = ctx.createGain()
    vibGain.gain.value = 40
    vib.connect(vibGain).connect(this.laserOsc.frequency)
    vib.start()
    const whineGain = ctx.createGain()
    whineGain.gain.value = 0.35
    this.laserOsc.connect(whineGain).connect(beamLp)
    this.laserOsc.start()
    beamLp.connect(this.laserGain).connect(this.sfxBus)

    this.applyVolumes()
    this.started = true
    this.nextBeat = ctx.currentTime + 0.1
  }

  setVolumes(v: SettingsData['audio']): void {
    this.volumes = v
    this.applyVolumes()
  }

  private applyVolumes(): void {
    if (!this.ctx) return
    const v = this.volumes
    const sceneMusic = this.scene === 'paused' ? 0.4 : this.scene === 'title' ? 0.8 : 1
    this.master.gain.value = this.muted ? 0 : v.master
    this.engineBus.gain.value = this.scene === 'run' ? v.engine * 0.5 : this.scene === 'paused' ? v.engine * 0.12 : 0
    this.sfxBus.gain.value = v.sfx
    this.musicBus.gain.value = v.music * 0.4 * sceneMusic
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

  setScene(s: AudioScene): void {
    this.scene = s
    this.applyVolumes()
  }

  setTimeScale(t: number): void {
    this.timeScale = t
  }

  ui(kind: 'move' | 'select'): void {
    if (!this.ctx) return
    this.blip(kind === 'move' ? 660 : 880, 0.04, 0.12, 'square')
  }

  update(snap: SimSnapshot, v: VehicleSnap, dt: number): void {
    const ctx = this.ctx
    if (!ctx || !this.started) return
    const now = ctx.currentTime
    // Engine: pitch and filter follow speed; boost adds a resonant sweep.
    const target = this.scene === 'run' ? 1 : 0
    this.engineLevel += (target - this.engineLevel) * Math.min(1, dt * 4)
    const speed = v.speed * this.timeScale
    const hz = (ENGINE_BASE_HZ + Math.max(0, speed - 150) * ENGINE_HZ_PER_MS) * (v.airborne ? 1.12 : 1)
    for (const o of this.engineOsc) o.frequency.setTargetAtTime(hz, now, 0.05)
    const boost = v.onBoost ? 1 : 0
    this.engineFilter.frequency.setTargetAtTime(300 + speed * 3.5 + boost * 1800, now, 0.08)
    this.engineFilter.Q.setTargetAtTime(2 + boost * 8, now, 0.1)
    this.engineNoiseGain.gain.setTargetAtTime(this.engineLevel * (0.04 + Math.max(0, (speed - SPEED_CRUISE) / 400) * 0.25 + boost * 0.2), now, 0.1)
    // Reverb: heavy in a tube, dry in the open.
    this.openness += (this.openTarget - this.openness) * Math.min(1, dt * 3)
    this.reverbSend.gain.setTargetAtTime(0.45 - 0.38 * this.openness, now, 0.2)
    // Laser gate.
    this.laserGain.gain.setTargetAtTime(snap.laserFiring ? (snap.laserHit ? 0.2 : 0.13) : 0, now, snap.laserFiring ? 0.015 : 0.05)
    this.laserOsc.frequency.setTargetAtTime(snap.laserHit ? 2600 : 2100, now, 0.04)

    // Music scheduler.
    const bpm = (BPM_BASE + Math.max(0, speed - 150) * BPM_PER_MS) * (this.scene === 'run' ? 1 : 0.8)
    const beatLen = 60 / bpm / 2 // eighth notes
    while (this.nextBeat < now + SCHEDULE_AHEAD) {
      this.scheduleBeat(this.nextBeat, this.beat, beatLen)
      this.nextBeat += beatLen
      this.beat++
    }
  }

  private scheduleBeat(t: number, beat: number, len: number): void {
    const ctx = this.ctx!
    const root = 41.2 // E1
    const bass = BASS_PATTERN[beat % BASS_PATTERN.length]
    // Kick on downbeats, hat on every eighth, bass every other.
    if (beat % 2 === 0) this.kick(t)
    this.hat(t, beat % 4 === 2 ? 0.25 : 0.12)
    if (beat % 2 === 0) this.tone(root * Math.pow(2, bass / 12), t, len * 1.8, 0.35, 'sawtooth', 220)
    // Lead: sparse, only every 16 beats plays a phrase.
    const phrase = Math.floor(beat / 16) % 3
    if (phrase === 1 || phrase === 2) {
      const n = LEAD_PATTERN[beat % LEAD_PATTERN.length]
      const deg = SCALE[n % SCALE.length] + 12 * Math.floor(n / SCALE.length)
      this.tone(root * 4 * Math.pow(2, deg / 12), t, len * 0.9, 0.09, 'square', 1800)
    }
    void ctx
  }

  private kick(t: number): void {
    const ctx = this.ctx!
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.frequency.setValueAtTime(140, t)
    o.frequency.exponentialRampToValueAtTime(38, t + 0.12)
    g.gain.setValueAtTime(0.9, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22)
    o.connect(g).connect(this.musicBus)
    o.start(t)
    o.stop(t + 0.25)
  }

  private hat(t: number, level: number): void {
    const ctx = this.ctx!
    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuffer
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 7000
    const g = ctx.createGain()
    g.gain.setValueAtTime(level, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05)
    src.connect(hp).connect(g).connect(this.musicBus)
    src.start(t, Math.random() * 1.5)
    src.stop(t + 0.06)
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

  private blip(freq: number, dur: number, level: number, type: OscillatorType, bus?: GainNode): void {
    const ctx = this.ctx!
    const t = ctx.currentTime
    const o = ctx.createOscillator()
    o.type = type
    o.frequency.value = freq
    const g = ctx.createGain()
    g.gain.setValueAtTime(level, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + dur)
    o.connect(g).connect(bus ?? this.sfxBus)
    o.start(t)
    o.stop(t + dur + 0.02)
  }

  private noiseBurst(dur: number, level: number, cutoff: number, type: BiquadFilterType = 'lowpass', sweepTo?: number): void {
    const ctx = this.ctx!
    const t = ctx.currentTime
    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuffer
    const f = ctx.createBiquadFilter()
    f.type = type
    f.frequency.setValueAtTime(cutoff, t)
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(level, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + dur)
    src.connect(f).connect(g).connect(this.sfxBus)
    src.start(t, Math.random())
    src.stop(t + dur + 0.02)
  }

  private thud(fromHz: number, toHz: number, dur: number, level: number): void {
    const ctx = this.ctx!
    const t = ctx.currentTime
    const o = ctx.createOscillator()
    o.frequency.setValueAtTime(fromHz, t)
    o.frequency.exponentialRampToValueAtTime(toHz, t + dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(level, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + dur)
    o.connect(g).connect(this.sfxBus)
    o.start(t)
    o.stop(t + dur + 0.02)
  }

  private horn(freq: number, dur: number): void {
    const ctx = this.ctx!
    const t = ctx.currentTime
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(0.35, t + 0.05)
    g.gain.setValueAtTime(0.35, t + dur - 0.1)
    g.gain.exponentialRampToValueAtTime(0.001, t + dur)
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 1400
    for (const det of [0, 5, -1200]) {
      const o = ctx.createOscillator()
      o.type = 'sawtooth'
      o.frequency.value = freq
      o.detune.value = det
      o.connect(lp)
      o.start(t)
      o.stop(t + dur + 0.05)
    }
    lp.connect(g).connect(this.sfxBus)
  }

  private duckFor(ms: number, depth: number): void {
    const t = this.ctx!.currentTime
    this.duck.gain.cancelScheduledValues(t)
    this.duck.gain.setValueAtTime(depth, t)
    this.duck.gain.linearRampToValueAtTime(1, t + ms / 1000)
  }

  onEvent(e: SimEvent): void {
    if (!this.ctx) return
    switch (e.type) {
      case 'kill': {
        const kind = TRAFFIC_KIND_CODES[e.a]
        const big = kind === 'GATE_BOSS' ? 3 : kind === 'ARMORED' || kind === 'BLOCKER' ? 1.6 : 1
        this.noiseBurst(0.25 * big, 0.5, 1800 * big, 'lowpass', 120)
        this.thud(180 * big, 40, 0.2 * big, 0.5)
        break
      }
      case 'collision':
        this.thud(110, 35, 0.3, 0.9)
        this.noiseBurst(0.3, 0.6, 900, 'lowpass', 200)
        this.duckFor(200, 0.5)
        break
      case 'hit':
        this.thud(220, 80, 0.15, 0.5)
        this.noiseBurst(0.12, 0.4, 2500)
        break
      case 'scrape':
        this.noiseBurst(0.1, 0.18, 3000, 'bandpass')
        break
      case 'gate':
        this.blip(659, 0.25, 0.3, 'triangle')
        setTimeout(() => this.ctx && this.blip(988, 0.35, 0.3, 'triangle'), 90)
        break
      case 'shockwave':
        this.thud(140, 28, 0.7, 1.0)
        this.noiseBurst(0.8, 0.8, 200, 'bandpass', 7000)
        this.duckFor(300, 0.25)
        break
      case 'overheat':
        this.blip(880, 0.12, 0.3, 'square')
        setTimeout(() => this.ctx && this.blip(660, 0.18, 0.3, 'square'), 140)
        break
      case 'pickup':
      case 'ring':
        this.blip(1046, 0.12, 0.25, 'triangle')
        setTimeout(() => this.ctx && this.blip(1568, 0.2, 0.25, 'triangle'), 70)
        break
      case 'launch':
        this.noiseBurst(0.5, 0.25, 600, 'highpass')
        break
      case 'land':
        this.thud(160, 50, 0.2, 0.6)
        this.noiseBurst(0.2, 0.3, 1200)
        break
      case 'spinout':
        this.thud(150, 40, 0.8, 0.9)
        this.noiseBurst(0.7, 0.6, 2000, 'lowpass', 150)
        break
      case 'crash':
        this.thud(120, 20, 1.2, 1.0)
        this.noiseBurst(1.2, 0.9, 3000, 'lowpass', 80)
        this.duckFor(600, 0.3)
        break
      case 'enemy_shot':
        this.blip(300, 0.1, 0.12, 'sawtooth')
        break
      case 'boost_enter':
        this.noiseBurst(0.4, 0.3, 400, 'bandpass', 5000)
        break
      case 'combo':
      case 'charge_earned':
        this.blip(1318, 0.1, 0.2, 'square')
        setTimeout(() => this.ctx && this.blip(1760, 0.15, 0.2, 'square'), 60)
        break
      case 'finish':
        for (let i = 0; i < 4; i++) setTimeout(() => this.ctx && this.blip(523 * Math.pow(2, i / 4), 0.4, 0.3, 'triangle'), i * 120)
        break
      case 'timeout':
        this.thud(200, 60, 0.8, 0.6)
        break
      case 'boss_spawn':
        this.thud(60, 30, 1.0, 0.7)
        break
      case 'train':
        // Two-tone horn, a beat apart.
        this.horn(220, 0.5)
        setTimeout(() => this.ctx && this.horn(277, 0.7), 180)
        break
      case 'shot_fired':
        if (e.a > 0 && Math.random() < 0.5) this.noiseBurst(0.05, 0.12, 4000, 'bandpass')
        break
      default:
        break
    }
  }
}

function impulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const rate = ctx.sampleRate
  const len = Math.floor(rate * seconds)
  const buf = ctx.createBuffer(2, len, rate)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay)
  }
  return buf
}

function noise(ctx: AudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  return buf
}
