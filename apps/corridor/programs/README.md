# programs/

What turns a world into a game. One file per game, default-exporting `defineGame({ setup, update })`.

These are edited in the **Program** tab of the editor, which type-checks them in the browser against
the declarations in `src/generated/program-types.json` — regenerate that with
`node scripts/gen-program-types.mjs` after changing the API in `src/program.ts`, or the editor will
tell you a method you just added does not exist.

## Start here

`skeleton.ts` is the starting point Rich asked for (2026-09-29): *"a more comprehensive skeleton
project with things that depend on map specific assets either auto-discovered or example sections
commented out or both. Prefer both."*

It is both. Every section asks the world what it has — `api.races.ids()`, `api.traffic.ids()`,
`api.stunts.ids()`, `api.placements()` — and does nothing when the answer is nothing, so **a world
with no traffic zones has its traffic left alone**. Under each is a commented example with a real id
in it, for when you know what you want rather than what happens to be there.

Copy it, rename it, cut what you do not need.

## The rule worth keeping

**Nothing may assume the map has anything.** A program is written once and dropped onto a dozen
worlds; the one that assumes a stage exists is the one that breaks on eleven of them. Ask, and do
nothing gracefully.

## What the API reaches

| what | how | where it comes from |
| --- | --- | --- |
| races | `api.races.ids()`, `.get(id)`, `.start(id)`, `.abandon()`, `.state()` | the Races mode — `courses.json` |
| traffic | `api.traffic.ids()`, `.density(id)`, `.set(id, d, { over })`, `.at(x, y)` | the Traffic mode — `zones.json` |
| stunts | `api.stunts.ids()`, `.show(id, on)`, `.visible(id)`, `.where(id)` | the Stunts mode — `stunts.json` |
| placements | `api.placed(id)`, `api.placedWith(tag)`, `api.placements()` | the Place mode — `placements.json` |
| physics | `api.physics.explode/impulse/break/ray/profile` | the Rapier world, when one is running |
| the world | `api.world`, `api.actors` | the ECS itself, for anything the above cannot say |

A race starts on its own when the player drives into its ring; `api.races.start(id)` is for starting
one without that.

## What you can import

The editor resolves these, so the types of everything the API hands back are completable:

```ts
import { defineGame, type GameApi } from '@apex/program'
import { clock, type Course, type Gate } from '@apex/races'     // what `api.races.get` returns
import { type RaceState } from '@apex/racerun'                   // what `api.races.state` returns
import { levelOf, vehiclesPerKm, type Zone } from '@apex/zones'  // traffic zones
import { type StuntFixture } from '@apex/stunts'                 // loops and corkscrews
import { shares, type TrafficSetDoc } from '@apex/trafficsets'   // which vehicles the traffic is
import { type VehicleDoc } from '@apex/vehicles'
import { query, Transform, Vehicle } from '@apex/actors'         // the ECS, for everything else
```
