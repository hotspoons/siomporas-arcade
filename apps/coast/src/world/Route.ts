// What the sim needs to know about a world: which stages exist, what follows
// what, and how to build one. The hand-authored coast-to-coast route and a world
// you laid out in the editor both answer the same questions, which is the whole
// reason the sim no longer reads STAGES directly.

import { Stage } from '../sim/Road'
import { ROUTE_LENGTH, STAGES, STAGE_BY_ID, THEMES, routeLength } from '../sim/Stages'
import { CompiledWorld } from './compile'
import { reachable, routeLengthOf, type WorldData } from './types'

export interface RouteSource {
  /** A label for the world (menus, results). */
  worldName: string
  /** Stage the run begins on. */
  start: string
  /** Every stage, in a sensible order for a "start at" list. */
  ids: string[]
  has(id: string): boolean
  name(id: string): string
  /** Build the stage. `seed` scatters the scenery; the road itself is fixed. */
  build(id: string, seed: number): Stage
  /** Stages in the longest run from `id` to a finish. */
  routeLength(id: string): number
}

/** The built-in coast-to-coast route: sections, hand-picked themes, no vibes. */
export const BUILTIN_ROUTE: RouteSource = {
  worldName: 'Coast to Coast',
  start: 'A',
  ids: STAGES.map((s) => s.id),
  has: (id) => Boolean(STAGE_BY_ID[id]),
  name: (id) => STAGE_BY_ID[id]?.name ?? id,
  build: (id, seed) => {
    const desc = STAGE_BY_ID[id] ?? STAGES[0]
    return new Stage(desc, THEMES[desc.theme], seed)
  },
  routeLength: (id) => (STAGE_BY_ID[id] ? routeLength(id) : ROUTE_LENGTH),
}

/** A world laid out in the editor. Stages compile on first use and are cached. */
export class WorldRoute implements RouteSource {
  readonly data: WorldData
  private compiled: CompiledWorld
  private seed = 1

  constructor(data: WorldData, seed = 1) {
    this.data = data
    this.compiled = new CompiledWorld(data, seed)
    this.seed = seed
  }

  get worldName(): string {
    return this.data.name
  }
  get start(): string {
    return this.data.start
  }
  get ids(): string[] {
    const live = reachable(this.data)
    const rest = this.data.tracks.filter((t) => !live.includes(t))
    return [...live, ...rest].map((t) => t.id)
  }
  has(id: string): boolean {
    return this.data.tracks.some((t) => t.id === id)
  }
  name(id: string): string {
    return this.data.tracks.find((t) => t.id === id)?.name ?? id
  }
  build(id: string, seed: number): Stage {
    if (seed !== this.seed) {
      this.seed = seed
      this.compiled = new CompiledWorld(this.data, seed)
    }
    const stage = this.compiled.stage(id) ?? this.compiled.stage(this.data.start)
    if (!stage) throw new Error(`world “${this.data.name}” has no drivable track`)
    return stage
  }
  routeLength(id: string): number {
    return Math.max(1, routeLengthOf(this.data, id))
  }
}
