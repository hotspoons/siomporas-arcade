// Saved tracks: built-ins plus the player's own in localStorage.

import type { TrackData } from '../sim/Track'
import { BUILTIN_TRACKS } from '../sim/tracks'

// Still `drivin`: the game was renamed, and this is where a player's saved tracks already live.
// Renaming the key would hide every track anyone has built.
const KEY = 'apex-drivin.tracks.v1'

export interface TrackRef {
  id: string
  name: string
  builtin: boolean
}

export class TrackStore {
  private user: TrackData[] = []

  constructor() {
    try {
      this.user = JSON.parse(localStorage.getItem(KEY) ?? '[]') as TrackData[]
    } catch {
      this.user = []
    }
  }

  list(): TrackRef[] {
    return [...BUILTIN_TRACKS.map((t, i) => ({ id: `builtin:${i}`, name: t.name, builtin: true })), ...this.user.map((t, i) => ({ id: `user:${i}`, name: t.name, builtin: false }))]
  }

  get(id: string): TrackData | null {
    const [kind, idx] = id.split(':')
    const i = Number(idx)
    if (kind === 'builtin') return BUILTIN_TRACKS[i] ?? null
    return this.user[i] ?? null
  }

  save(data: TrackData, id?: string): string {
    const [kind, idx] = (id ?? '').split(':')
    if (kind === 'user' && this.user[Number(idx)]) {
      this.user[Number(idx)] = data
      this.persist()
      return id!
    }
    this.user.push(data)
    this.persist()
    return `user:${this.user.length - 1}`
  }

  remove(id: string): void {
    const [kind, idx] = id.split(':')
    if (kind !== 'user') return
    this.user.splice(Number(idx), 1)
    this.persist()
  }

  private persist(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.user))
    } catch {
      /* best effort */
    }
  }
}
