// Replays. A run is recorded as poses (position, facing, wheels) sampled a few
// dozen times a second, not as inputs: a saved replay plays back the same way
// however the physics or the track are edited afterwards. Each file carries a
// full copy of the track it was driven on, so watching an old replay never
// depends on the track still existing — or still looking the same.
//
// Files live on A:\ (localStorage, presented as a floppy) and can be exported
// to and imported from real files.

import type { Snapshot } from '../sim/Snapshot'
import type { TrackData } from '../sim/Track'

/** Samples per second stored. Playback interpolates between them. */
export const REPLAY_HZ = 30
/** Floats per sample: pos(3), forward(3), up(3), speed, steer, wheelSpin, flags. */
const STRIDE = 13
/** Longest run kept, seconds — a very long session drops its oldest samples rather than growing forever. */
export const REPLAY_MAX_SECONDS = 480

export interface ReplayMeta {
  id: string
  /** As shown to the player: A:\NAME.RPL */
  file: string
  track: string
  car: string
  laps: number
  bestLap: number
  seconds: number
  recorded: number
}

export interface ReplayFile extends ReplayMeta {
  v: 1
  hz: number
  /** The track exactly as it was driven, so later edits can't change the replay. */
  trackData: TrackData
  /** Base64 of the Float32 sample stream. */
  frames: string
}

/** Records poses off the live snapshots at REPLAY_HZ. */
export class ReplayRecorder {
  private data: number[] = []
  private acc = 0
  private seconds = 0
  /** Metadata for whatever is being recorded now. */
  track: TrackData | null = null
  car = ''

  start(track: TrackData, car: string): void {
    this.data = []
    this.acc = 0
    this.seconds = 0
    this.track = track
    this.car = car
  }

  get length(): number {
    return this.seconds
  }

  get empty(): boolean {
    return this.data.length < STRIDE * 2
  }

  /** Call once per sim tick with the fresh snapshot. */
  sample(snap: Snapshot, dt: number): void {
    if (!this.track) return
    this.acc += dt
    this.seconds += dt
    const step = 1 / REPLAY_HZ
    if (this.acc < step) return
    this.acc -= step
    if (this.acc > step) this.acc = 0
    const c = snap.car
    this.data.push(
      c.pos.x,
      c.pos.y,
      c.pos.z,
      c.forward.x,
      c.forward.y,
      c.forward.z,
      c.up.x,
      c.up.y,
      c.up.z,
      c.speed,
      c.steer,
      c.wheelSpin,
      (c.braking ? 1 : 0) + (c.onGrass ? 2 : 0) + (snap.phase === 'replay' ? 4 : 0),
    )
    const max = REPLAY_MAX_SECONDS * REPLAY_HZ * STRIDE
    if (this.data.length > max) this.data.splice(0, this.data.length - max)
  }

  /** Freeze what has been recorded into a file (without an id or name yet). */
  build(name: string, snap: Snapshot): ReplayFile | null {
    if (!this.track || this.empty) return null
    const frames = new Float32Array(this.data)
    return {
      v: 1,
      id: '',
      file: fileName(name),
      track: this.track.name,
      car: this.car,
      laps: snap.hud.laps,
      bestLap: snap.hud.bestLap,
      seconds: Math.round((frames.length / STRIDE / REPLAY_HZ) * 10) / 10,
      recorded: Date.now(),
      hz: REPLAY_HZ,
      trackData: structuredClone(this.track),
      frames: encode(frames),
    }
  }
}

/** Plays a replay file back into a Snapshot the renderer already understands. */
export class ReplayPlayer {
  readonly file: ReplayFile
  readonly frames: Float32Array
  readonly count: number
  readonly duration: number
  time = 0
  speed = 1
  playing = true

  constructor(file: ReplayFile) {
    this.file = file
    this.frames = decode(file.frames)
    this.count = Math.floor(this.frames.length / STRIDE)
    this.duration = Math.max(0, (this.count - 1) / (file.hz || REPLAY_HZ))
  }

  advance(dt: number): void {
    if (!this.playing) return
    this.time += dt * this.speed
    if (this.time > this.duration) {
      this.time = this.duration
      this.playing = false
    }
    if (this.time < 0) this.time = 0
  }

  seek(t: number): void {
    this.time = Math.max(0, Math.min(this.duration, t))
  }

  /** Write the pose at the current time into a snapshot (interpolating between samples). */
  write(out: Snapshot): void {
    const hz = this.file.hz || REPLAY_HZ
    const f = Math.max(0, Math.min(this.count - 1, this.time * hz))
    const i = Math.min(Math.floor(f), Math.max(0, this.count - 2))
    const t = f - i
    const a = i * STRIDE
    const b = Math.min(i + 1, this.count - 1) * STRIDE
    const mix = (k: number) => this.frames[a + k] + (this.frames[b + k] - this.frames[a + k]) * t
    const c = out.car
    c.pos.set(mix(0), mix(1), mix(2))
    c.forward.set(mix(3), mix(4), mix(5))
    c.up.set(mix(6), mix(7), mix(8))
    c.speed = mix(9)
    c.steer = mix(10)
    c.wheelSpin = mix(11)
    const flags = this.frames[a + 12]
    c.braking = (flags & 1) !== 0
    c.onGrass = (flags & 2) !== 0
    c.mode = 'track'
    c.slip = 0
    out.phase = 'driving'
    out.time = this.time
    const h = out.hud
    h.speed = Math.abs(c.speed)
    h.lapTime = this.time
    h.laps = this.file.laps
    h.bestLap = this.file.bestLap
    h.gear = Math.min(5, 1 + Math.floor((Math.abs(c.speed) / 82) * 5))
    h.rpm = Math.abs(c.speed) < 0.3 ? 0.1 : ((Math.min(4.999, (Math.abs(c.speed) / 82) * 5) % 1) * 0.75 + 0.22)
  }
}

const KEY = 'apex-drivin.replays.v1'

/** The floppy: replays in localStorage, listed as files on A:\ */
export class ReplayStore {
  private index: ReplayMeta[] = []

  constructor() {
    try {
      this.index = JSON.parse(localStorage.getItem(KEY) ?? '[]') as ReplayMeta[]
    } catch {
      this.index = []
    }
  }

  list(): ReplayMeta[] {
    return [...this.index].sort((a, b) => b.recorded - a.recorded)
  }

  get(id: string): ReplayFile | null {
    try {
      const raw = localStorage.getItem(`${KEY}.${id}`)
      return raw ? (JSON.parse(raw) as ReplayFile) : null
    } catch {
      return null
    }
  }

  /** Save a file, returning its id — or null when the floppy is full. */
  save(file: ReplayFile): string | null {
    const id = `r${Date.now().toString(36)}`
    const named = { ...file, id, file: this.uniqueName(file.file) }
    try {
      localStorage.setItem(`${KEY}.${id}`, JSON.stringify(named))
    } catch {
      return null // out of space: the floppy is full
    }
    const { v: _v, hz: _hz, trackData: _t, frames: _f, ...meta } = named
    this.index.push(meta)
    this.persist()
    return id
  }

  remove(id: string): void {
    this.index = this.index.filter((m) => m.id !== id)
    try {
      localStorage.removeItem(`${KEY}.${id}`)
    } catch {
      /* fine */
    }
    this.persist()
  }

  /** Replays driven on a track of this name (edits don't matter — each file carries its own copy). */
  forTrack(name: string): ReplayMeta[] {
    return this.list().filter((m) => m.track === name)
  }

  private uniqueName(want: string): string {
    let name = want
    for (let n = 2; this.index.some((m) => m.file === name); n++) name = fileName(`${baseName(want)}${n}`)
    return name
  }

  private persist(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.index))
    } catch {
      /* fine */
    }
  }
}

/** A:\NAME.RPL — eight characters, upper case, like the floppy it pretends to be. */
export function fileName(name: string): string {
  return `A:\\${baseName(name).slice(0, 8) || 'RUN'}.RPL`
}

function baseName(name: string): string {
  return name
    .replace(/^A:\\/i, '')
    .replace(/\.RPL$/i, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
}

function encode(f: Float32Array): string {
  const bytes = new Uint8Array(f.buffer, f.byteOffset, f.byteLength)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function decode(s: string): Float32Array {
  const raw = atob(s)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return new Float32Array(bytes.buffer, 0, Math.floor(bytes.length / 4))
}

/** Parse an imported .rpl file, or null if it isn't one. */
export function parseReplay(text: string): ReplayFile | null {
  try {
    const f = JSON.parse(text) as ReplayFile
    if (f.v !== 1 || typeof f.frames !== 'string' || !f.trackData) return null
    return f
  } catch {
    return null
  }
}
