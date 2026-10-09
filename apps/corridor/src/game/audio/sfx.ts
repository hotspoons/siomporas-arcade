// Playing the sound bank: one AudioContext, one bus, clips decoded on first use and placed in
// the world. `soundbank.ts` decides WHAT plays; this is HOW.
//
// Three rules, learned on the engine bus (enginesound.ts) and kept here:
//
//   - the context is made from a user gesture (`unlock`), never at load, or it is born suspended
//     and nothing ever comes out of it;
//   - the player's mute is COMBINED with the tab-hidden mute, never replaced by it, and the bus is
//     ramped before the context is suspended, because suspending mid-sample is a click;
//   - nothing here throws into the frame. A clip that will not fetch or decode is remembered as
//     silent and the game goes on; `stats()` is where a probe finds out.
//
// POSITION. One-shots with an `at` get a PannerNode (equal-power, inverse distance) and the
// listener is the camera, set once a frame by `setListener`. Everything is in three's world frame
// — x east, y up, z south — the frame the car, the camera and the impacts already share, so no
// conversion happens in here. A one-shot without `at` plays straight on the bus (the player's own
// gun: it is where you are).
//
// POLYPHONY. At 14 rounds a second from two guns plus their hits, plus a pile-up, the count climbs
// fast. `MAX_VOICES` live one-shots; past that the oldest is stopped. Nobody hears the 25th.

import * as T from '../../tuning'
import { squealMix, SoundBank, type BankManifest, type ResolvedClip, type SoundOverrides } from './soundbank'

const MAX_VOICES = 28

export interface PlayOpts {
  /** where, in three's world frame. Absent: on the bus, unplaced */
  at?: { x: number; y: number; z: number }
  /** 0…1 over the clip's own level */
  gain?: number
  /** playback rate; 1 is as recorded. Small random variety is added on top unless `vary` is 0 */
  rate?: number
  /** ± fraction of random rate variety, default 0.06 */
  vary?: number
  /** the override scopes, nearest first: the thing's own document, then the world's */
  scopes?: (SoundOverrides | null | undefined)[]
  /** the distance (m) the clip is heard at full level to. Default SFX_REF_M; an explosion wants more */
  ref?: number
}

export interface SfxStats {
  state: 'off' | 'unsupported' | AudioContextState
  bankLoaded: boolean
  decoded: number
  failed: number
  live: number
  played: number
  dropped: number
  muted: boolean
}

/** A loop the game keeps a handle on — the squeal — moved and levelled each frame. */
export interface LoopHandle {
  /** 0…1; 0 is silence */
  set(level: number, at?: { x: number; y: number; z: number }): void
  stop(): void
  readonly level: number
}

export class Sfx {
  bank: SoundBank | null = null
  private ctx: AudioContext | null = null
  private bus: GainNode | null = null
  private buffers = new Map<string, AudioBuffer | null | Promise<AudioBuffer | null>>()
  private live: { src: AudioBufferSourceNode; at: number }[] = []
  private muted = false
  private hiddenMuted = false
  private userMuted = false
  private userGain = 1
  private suspendTimer: ReturnType<typeof setTimeout> | null = null
  private counts = { decoded: 0, failed: 0, played: 0, dropped: 0 }
  private bankPromise: Promise<void> | null = null
  /** the world's own overrides, laid under every document's: a level that wants quieter guns */
  worldScope: SoundOverrides | null = null

  /** The bank manifest, fetched once. Safe to call before the context exists. */
  loadBank(url = '/sounds/bank.json', assetUrl?: (id: string, file: string) => string): Promise<void> {
    if (this.bankPromise) return this.bankPromise
    this.bankPromise = (async () => {
      try {
        const r = await fetch(url)
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const manifest = (await r.json()) as BankManifest
        this.bank = new SoundBank(manifest, { ext: preferredExt(manifest.formats), assetUrl })
      } catch (e) {
        console.warn('[sfx] no sound bank:', e)
      }
    })()
    return this.bankPromise
  }

  /**
   * The first user gesture — the same `pointerdown`/`keydown` hook the engine uses. Creates the
   * context the first time; resumes it afterwards if it was suspended by the browser.
   */
  unlock(): void {
    if (typeof AudioContext === 'undefined') return
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext({ latencyHint: 'interactive' })
        this.bus = this.ctx.createGain()
        this.bus.gain.value = this.muted ? 0 : this.busGain()
        this.bus.connect(this.ctx.destination)
        const l = this.ctx.listener
        if (l.forwardX) { l.forwardX.value = 0; l.forwardY.value = 0; l.forwardZ.value = -1; l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0 }
      } catch {
        this.ctx = null
        return
      }
    }
    if (this.ctx.state === 'suspended' && !this.muted) void this.ctx.resume().catch(() => { /* still not allowed */ })
  }

  /** a context already made — the editor's preview shares one with its engine bench */
  get context(): AudioContext | null {
    return this.ctx
  }

  /** the camera, once a frame, in three's world frame */
  setListener(pos: { x: number; y: number; z: number }, forward: { x: number; y: number; z: number }, up: { x: number; y: number; z: number }): void {
    const ctx = this.ctx
    if (!ctx) return
    const l = ctx.listener
    const t = ctx.currentTime
    if (l.positionX) {
      l.positionX.setTargetAtTime(pos.x, t, 0.02); l.positionY.setTargetAtTime(pos.y, t, 0.02); l.positionZ.setTargetAtTime(pos.z, t, 0.02)
      l.forwardX.setTargetAtTime(forward.x, t, 0.02); l.forwardY.setTargetAtTime(forward.y, t, 0.02); l.forwardZ.setTargetAtTime(forward.z, t, 0.02)
      l.upX.setTargetAtTime(up.x, t, 0.02); l.upY.setTargetAtTime(up.y, t, 0.02); l.upZ.setTargetAtTime(up.z, t, 0.02)
    } else {
      // Safari before 14.1: the deprecated setters are all there is
      ;(l as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(pos.x, pos.y, pos.z)
      ;(l as unknown as { setOrientation(...a: number[]): void }).setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z)
    }
  }

  /** One of a slot's clips, now. Returns false when nothing could play (no bank, muted, silent slot). */
  play(slot: string, o: PlayOpts = {}): boolean {
    const ctx = this.ctx, bus = this.bus, bank = this.bank
    if (!ctx || !bus || !bank || this.muted) return false
    const clip = bank.pick(slot, [...(o.scopes ?? []), this.worldScope])
    if (!clip) return false
    const buf = this.buffer(clip)
    if (buf instanceof Promise) {
      // the first time a slot is heard its clip is still decoding; a 30 ms late gunshot is fine,
      // a crash sound half a second after the crash is not — so one-shots wait at most briefly
      const started = performance.now()
      void buf.then((b) => { if (b && performance.now() - started < 400) this.start(b, o) })
      return true
    }
    if (!buf) return false
    this.start(buf, o)
    return true
  }

  /** Decode a slot's clips ahead of time — called once the bank is known, for the slots a car fires. */
  warm(slots: string[], scopes: (SoundOverrides | null | undefined)[] = []): void {
    const bank = this.bank
    if (!bank || !this.ctx) return
    for (const slot of slots) for (const c of bank.resolve(slot, [...scopes, this.worldScope])) void this.buffer(c)
  }

  /**
   * A levelled loop: the squeal. The slot's clips are its levels in order (`ordered` in the bank);
   * every level runs from the first `set`, mixed by `squealMix`, so moving between them is a
   * crossfade and not a restart. Idle at level 0 it costs three silent sources — nothing.
   */
  loop(slot: string, scopes: (SoundOverrides | null | undefined)[] = []): LoopHandle {
    let voices: { src: AudioBufferSourceNode; gain: GainNode }[] | null = null
    let panner: PannerNode | null = null
    let building = false
    let level = 0
    let stopped = false
    const build = () => {
      const ctx = this.ctx, bus = this.bus, bank = this.bank
      if (!ctx || !bus || !bank || building || voices) return
      const clips = bank.resolve(slot, [...scopes, this.worldScope])
      if (!clips.length) { voices = []; return }
      building = true
      void Promise.all(clips.map((c) => this.buffer(c))).then((bufs) => {
        building = false
        if (stopped) return
        panner = this.panner(ctx, T.SFX_REF_M)
        panner.connect(bus)
        voices = []
        for (const b of bufs) {
          if (!b) continue
          const src = ctx.createBufferSource()
          src.buffer = b
          src.loop = true
          const gain = ctx.createGain()
          gain.gain.value = 0
          src.connect(gain)
          gain.connect(panner)
          src.start()
          voices.push({ src, gain })
        }
      })
    }
    // arrows, not methods: `this` in here is the Sfx, and a method on the handle would shadow it
    return {
      get level() { return level },
      set: (l, at) => {
        level = Math.min(1, Math.max(0, Number.isFinite(l) ? l : 0))
        if (stopped) return
        if (!voices) { if (level > 0) build(); return }
        const ctx = this.ctx!
        const { gains, rate } = squealMix(level, voices.length)
        const t = ctx.currentTime
        for (const [i, v] of voices.entries()) {
          v.gain.gain.setTargetAtTime(gains[i] ?? 0, t, 0.04)
          v.src.playbackRate.setTargetAtTime(rate, t, 0.08)
        }
        if (at && panner) place(panner, at, t)
      },
      stop: () => {
        stopped = true
        for (const v of voices ?? []) { try { v.src.stop() } catch { /* already */ } v.src.disconnect(); v.gain.disconnect() }
        panner?.disconnect()
        voices = null
      },
    }
  }

  /** the tab is hidden or unfocused, or the game is paused */
  setMuted(muted: boolean): void {
    this.hiddenMuted = muted
    this.applyMute()
  }

  /** the player's volume (Settings → Audio: master × sfx) and mute, over the SFX_MASTER knob */
  setUserAudio(gain: number, muted: boolean): void {
    this.userGain = Number.isFinite(gain) ? Math.min(1, Math.max(0, gain)) : 1
    this.userMuted = muted
    this.applyMute()
    if (!this.muted && this.bus && this.ctx) this.bus.gain.setTargetAtTime(this.busGain(), this.ctx.currentTime, 0.03)
  }

  /** a knob moved: the bus follows SFX_MASTER without a settings round-trip */
  refreshGain(): void {
    if (!this.muted && this.bus && this.ctx) this.bus.gain.setTargetAtTime(this.busGain(), this.ctx.currentTime, 0.03)
  }

  stats(): SfxStats {
    return {
      state: typeof AudioContext === 'undefined' ? 'unsupported' : this.ctx ? this.ctx.state : 'off',
      bankLoaded: !!this.bank,
      ...this.counts,
      live: this.live.length,
      muted: this.muted,
    }
  }

  private busGain(): number {
    return T.SFX_MASTER * this.userGain
  }

  private applyMute(): void {
    const muted = this.hiddenMuted || this.userMuted
    if (this.muted === muted) return
    this.muted = muted
    const ctx = this.ctx, bus = this.bus
    if (!ctx || !bus) return
    const RAMP = 0.08
    if (muted) {
      bus.gain.setTargetAtTime(0, ctx.currentTime, RAMP / 3)
      this.suspendTimer = setTimeout(() => {
        this.suspendTimer = null
        if (this.muted) void ctx.suspend().catch(() => { /* closing */ })
      }, RAMP * 4 * 1000)
    } else {
      if (this.suspendTimer !== null) { clearTimeout(this.suspendTimer); this.suspendTimer = null }
      void ctx.resume().then(() => bus.gain.setTargetAtTime(this.busGain(), ctx.currentTime, RAMP / 3)).catch(() => { /* going away */ })
    }
  }

  private buffer(clip: ResolvedClip): AudioBuffer | null | Promise<AudioBuffer | null> {
    const have = this.buffers.get(clip.url)
    if (have !== undefined) return have
    const ctx = this.ctx!
    const p = (async () => {
      try {
        const r = await fetch(clip.url)
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const b = await ctx.decodeAudioData(await r.arrayBuffer())
        this.counts.decoded++
        this.buffers.set(clip.url, b)
        return b
      } catch (e) {
        this.counts.failed++
        this.buffers.set(clip.url, null)
        console.warn(`[sfx] ${clip.url}:`, e)
        return null
      }
    })()
    this.buffers.set(clip.url, p)
    return p
  }

  private panner(ctx: AudioContext, ref: number): PannerNode {
    const p = ctx.createPanner()
    p.panningModel = 'equalpower'
    p.distanceModel = 'inverse'
    p.refDistance = Math.max(0.5, ref)
    p.maxDistance = Math.max(ref + 1, T.SFX_MAX_M)
    p.rolloffFactor = 1
    return p
  }

  private start(buf: AudioBuffer, o: PlayOpts): void {
    const ctx = this.ctx!, bus = this.bus!
    if (this.live.length >= MAX_VOICES) {
      const old = this.live.shift()!
      try { old.src.stop() } catch { /* done */ }
      this.counts.dropped++
    }
    const src = ctx.createBufferSource()
    src.buffer = buf
    const vary = o.vary ?? 0.06
    src.playbackRate.value = (o.rate ?? 1) * (1 + (Math.random() * 2 - 1) * vary)
    const gain = ctx.createGain()
    gain.gain.value = Math.min(2, Math.max(0, o.gain ?? 1))
    src.connect(gain)
    if (o.at) {
      const p = this.panner(ctx, o.ref ?? T.SFX_REF_M)
      place(p, o.at, ctx.currentTime)
      gain.connect(p)
      p.connect(bus)
    } else gain.connect(bus)
    const rec = { src, at: ctx.currentTime }
    this.live.push(rec)
    src.onended = () => {
      const i = this.live.indexOf(rec)
      if (i >= 0) this.live.splice(i, 1)
      src.disconnect()
      gain.disconnect()
    }
    src.start()
    this.counts.played++
  }
}

function place(p: PannerNode, at: { x: number; y: number; z: number }, t: number): void {
  if (p.positionX) { p.positionX.setTargetAtTime(at.x, t, 0.01); p.positionY.setTargetAtTime(at.y, t, 0.01); p.positionZ.setTargetAtTime(at.z, t, 0.01) }
  else (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(at.x, at.y, at.z)
}

/** ogg where Vorbis decodes (Chrome, Firefox, Edge), mp3 where it does not (Safari). */
export function preferredExt(formats: string[]): 'ogg' | 'mp3' {
  if (!formats.includes('mp3')) return 'ogg'
  if (!formats.includes('ogg')) return 'mp3'
  try {
    const a = document.createElement('audio')
    return a.canPlayType('audio/ogg; codecs="vorbis"') ? 'ogg' : 'mp3'
  } catch {
    return 'ogg'
  }
}
