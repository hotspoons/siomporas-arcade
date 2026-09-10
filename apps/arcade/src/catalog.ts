// Every game in the arcade, and how to go and get it.
//
// This is the only file that knows all three games exist. The engine knows none of them; the games
// know nothing of each other or of the shell. `load` is a dynamic import, so a game's code — and
// the megabyte of three.js scene it builds — arrives when someone actually walks up to that
// cabinet. three and @apex/engine are shared by all of them, so they come down once, with the
// lobby, and the second game to be started loads far less than the first.

import type { GameModule } from '@apex/engine/app/GameModule'

export interface ArcadeGame {
  /** URL segment, and the directory its cabinet art lives in under `public/cabinets`. */
  readonly id: string
  readonly title: string
  /** What it owes its existence to. */
  readonly lineage: string
  readonly blurb: string
  /** The cabinet's painted body, where there is no side art to cover it. */
  readonly body: number
  /** What the marquee throws onto the room. Pulled toward the art's own dominant colour. */
  readonly glow: number
  load: () => Promise<GameModule>
}

export const GAMES: readonly ArcadeGame[] = [
  {
    id: 'radrun',
    title: 'TURBO RADRUN',
    lineage: 'OutRun · Turbo OutRun · Rad Mobile',
    blurb: 'Sprite-scaling road racer. Forks, checkpoints, turbo, and a radio.',
    body: 0x2a1630,
    glow: 0xff7a3c,
    load: () => import('@apex/coast/app/module').then((m) => m.game),
  },
  {
    id: 'stuntin',
    title: "STUNTIN'",
    lineage: "Hard Drivin' · Stunts",
    blurb: 'Loops, corkscrews and banked turns — and a track editor to build more.',
    body: 0x1b2438,
    glow: 0xffb347,
    load: () => import('@apex/stuntin/app/module').then((m) => m.game),
  },
  {
    id: 'apex',
    title: 'APEX CONDUIT',
    lineage: 'S.T.U.N. Runner',
    blurb: 'Wall-riding tunnel racer with a roof laser and a shockwave.',
    body: 0x0d1030,
    glow: 0x35d2ff,
    load: () => import('@apex/conduit/app/module').then((m) => m.game),
  },
]

export function findGame(id: string | undefined): ArcadeGame | null {
  return GAMES.find((g) => g.id === id) ?? null
}
