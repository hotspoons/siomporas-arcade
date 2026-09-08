// Worlds: the built-in coast-to-coast route plus whatever the player has built,
// kept in localStorage. A "world" is a track set — one or more tracks wired into
// a directed graph with a start and at least one finish.

import { BUILTIN_ROUTE, WorldRoute, type RouteSource } from './Route'
import { emptyWorld, type WorldData } from './types'

const KEY = 'apex-coast.worlds.v1'
export const BUILTIN_WORLD = 'builtin'

export interface WorldRef {
  id: string
  name: string
  builtin: boolean
  tracks: number
}

export class WorldStore {
  private user: WorldData[] = []

  constructor() {
    this.load()
  }

  private load(): void {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as WorldData[]
      this.user = Array.isArray(raw) ? raw.filter((w) => w && Array.isArray(w.tracks)) : []
    } catch {
      this.user = []
    }
  }

  list(): WorldRef[] {
    return [{ id: BUILTIN_WORLD, name: BUILTIN_ROUTE.worldName, builtin: true, tracks: BUILTIN_ROUTE.ids.length }, ...this.user.map((w, i) => ({ id: `user:${i}`, name: w.name, builtin: false, tracks: w.tracks.length }))]
  }

  /** The authored data, or null for the built-in route (which has none — it is sections). */
  get(id: string): WorldData | null {
    if (!id.startsWith('user:')) return null
    return this.user[Number(id.slice(5))] ?? null
  }

  /** What the sim should drive for this id; falls back to the built-in route. */
  route(id: string, seed = 1): RouteSource {
    const data = this.get(id)
    if (!data || !data.tracks.length) return BUILTIN_ROUTE
    return new WorldRoute(data, seed)
  }

  name(id: string): string {
    return this.list().find((w) => w.id === id)?.name ?? BUILTIN_ROUTE.worldName
  }

  /** Save over `id` when it is one of the player's, otherwise add a new world; returns its id. */
  save(data: WorldData, id?: string): string {
    const i = id && id.startsWith('user:') ? Number(id.slice(5)) : -1
    if (i >= 0 && this.user[i]) {
      this.user[i] = structuredClone(data)
      this.persist()
      return id!
    }
    this.user.push(structuredClone(data))
    this.persist()
    return `user:${this.user.length - 1}`
  }

  remove(id: string): void {
    if (!id.startsWith('user:')) return
    this.user.splice(Number(id.slice(5)), 1)
    this.persist()
  }

  /** A name nothing else is using. */
  freeName(base: string): string {
    const taken = new Set(this.list().map((w) => w.name))
    if (!taken.has(base)) return base
    for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`
  }

  create(name?: string): { id: string; data: WorldData } {
    const data = emptyWorld(this.freeName(name ?? 'New World'))
    return { id: this.save(data), data }
  }

  private persist(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.user))
    } catch {
      /* best effort: a full quota should not lose the session */
    }
  }
}
