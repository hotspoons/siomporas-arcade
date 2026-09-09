// Local leaderboards and best-run input tapes, per course, in localStorage.
// Tapes are stored base64-packed so a 10-minute run is ~100 KB.

import { STEER_VERSION } from './Settings'

export interface RecordEntry {
  name: string
  score: number
  kills: number
  gates: number
  distance: number
  finished: boolean
  seed: number
  date: number
}

interface CourseRecords {
  entries: RecordEntry[]
  bestTape?: { seed: number; tape: string; score: number; steering?: number; steerV?: number }
}

const KEY = 'apex-conduit.records.v1'
const MAX_ENTRIES = 10

export class Records {
  private data: Record<string, CourseRecords>

  constructor() {
    this.data = load()
  }

  list(courseId: string): RecordEntry[] {
    return this.data[courseId]?.entries ?? []
  }

  submit(courseId: string, entry: RecordEntry, tape: Int32Array, steering = 1): { rank: number; isBest: boolean } {
    const rec = (this.data[courseId] ??= { entries: [] })
    rec.entries.push(entry)
    rec.entries.sort((a, b) => b.score - a.score)
    const rank = rec.entries.indexOf(entry) + 1
    rec.entries.length = Math.min(rec.entries.length, MAX_ENTRIES)
    const isBest = rank === 1 && entry.score > 0
    // The tape only replays faithfully under the steering speed it was driven with, so keep that too.
    if (isBest || !rec.bestTape) rec.bestTape = { seed: entry.seed, tape: packTape(tape), score: entry.score, steering, steerV: STEER_VERSION }
    save(this.data)
    return { rank: rank <= MAX_ENTRIES ? rank : 0, isBest }
  }

  bestTape(courseId: string): { seed: number; tape: Int32Array; steering: number } | null {
    const t = this.data[courseId]?.bestTape
    if (!t) return null
    // A tape only replays faithfully under the steering speed it was driven with — and that number is a
    // multiplier on a base rate that has since doubled, so an older tape's multiplier is halved to mean
    // the same thing it meant when it was recorded.
    const scale = (t.steerV ?? 1) < STEER_VERSION ? 0.5 : 1
    return { seed: t.seed, tape: unpackTape(t.tape), steering: (t.steering ?? 1) * scale }
  }

  clear(): void {
    this.data = {}
    save(this.data)
  }
}

function load(): Record<string, CourseRecords> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, CourseRecords>
  } catch {
    return {}
  }
}

function save(d: Record<string, CourseRecords>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(d))
  } catch {
    /* quota or private mode; records are best-effort */
  }
}

function packTape(tape: Int32Array): string {
  const bytes = new Uint8Array(tape.buffer, tape.byteOffset, tape.byteLength)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)))
  return btoa(s)
}

function unpackTape(b64: string): Int32Array {
  const s = atob(b64)
  const bytes = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i)
  return new Int32Array(bytes.buffer, 0, Math.floor(bytes.length / 4))
}
