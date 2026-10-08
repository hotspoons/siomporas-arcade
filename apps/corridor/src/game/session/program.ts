// Stage 6 of the game pipeline: the program layer — the thing that makes a world a game.
//
// Rich: "apply a goal and actual game over top with a program — which can choose to do things like
// hide street names, alter modes of transport, even define new exploration techniques."
//
// Those three examples are deliberately different in kind, and they set the bar:
//
//   1. hide street names          a render flag. A declarative setting could do it.
//   2. alter modes of transport   swapping the player's controller. Not a setting — a choice
//                                 between implementations.
//   3. new exploration techniques arbitrary new behaviour. ONLY CODE CAN DO THIS.
//
// So the program layer is code, and the declarative `scenario` primitives (facts, conditions,
// actions — tools/worldeditor/levels.mjs) stay as the simple path rather than being replaced. A
// program is what you write when the simple path runs out.
//
// THE API SURFACE IS THE PRODUCT. It is what an agent is prompted against, what a person reads
// the types of, and what has to stay still while everything under it moves. So it is small, it is
// declarative wherever it can be, and it hands over the ECS world directly where it cannot —
// there is no point pretending a "new exploration technique" can be expressed as a setting.
//
// WHAT IS IN HERE AND WHAT IS NOT. This file is the API's SHAPE and its bookkeeping: the events, the
// scoring, the goal, the clock, the lifecycle. It holds no THREE, no DOM and no fetch, so a whole
// game can be stepped in a test — which is the only way "did the win condition ever fire" is a
// question with an answer. Everything that touches the renderer arrives through `ProgramHost`,
// which the app implements and a test fakes.
import { addComponent, addEntity, type World } from 'bitecs'
import { Transform, Visual } from '../actors/actors'
import type { ActorWorld } from '../actors/actorworld'
import type { Freedom, HudPart, SettingId, UiMode } from './gamepolicy'

/* ---- what a program can ask the world to do ---------------------------------------------- */

/**
 * The things a program may turn off.
 *
 * A closed list, because "hide street names" has to mean the same thing to the program, the
 * editor's form and the renderer, and a free-form string means a typo that silently hides nothing.
 */
export const HIDEABLE = {
  'street-names': 'the blades on the corner posts and the names in the HUD',
  minimap: 'the map in the corner',
  hud: 'the whole readout',
  traffic: 'the simulated vehicles',
  signals: 'the traffic lights, as if the power were out',
  buildings: 'the generated massing',
} as const
export type Hideable = keyof typeof HIDEABLE

/**
 * How the player gets about. Each is a controller, not a setting.
 *
 * Rich's library of interaction types: "definitely need a first person and third person character
 * mode... also basic helic/omnic/ornith-opter and jet and plane and UFO flying dynamics too so we
 * have a library of interaction types." `transport.ts` implements them; this names them.
 */
export const TRANSPORT = [
  'drive', 'walk', 'walk-third', 'fly', 'helicopter', 'omnicopter', 'ornithopter', 'plane', 'jet', 'ufo',
] as const
export type Transport = (typeof TRANSPORT)[number]

/**
 * The ones `transport.ts` flies, as opposed to the ones the viewer already had.
 *
 * `drive` is the car and `fly` is the free camera; the rest are craft
 * with physics. Kept here so a program's `api.transport(...)` and the viewer's switch agree about
 * which is which — a name in one list and not the other is a transport that silently does nothing.
 */
export const CRAFT_TRANSPORT = ['walk', 'walk-third', 'helicopter', 'omnicopter', 'ornithopter', 'plane', 'jet', 'ufo'] as const

/** What the program layer needs from the app. Everything renderer-shaped lives behind this. */
export interface ProgramHost {
  /** the simulation the program's entities live in */
  actors: ActorWorld
  /** turn something off, or back on */
  hide: (what: Hideable, hidden: boolean) => void
  /** point the player somewhere, with a line about it; null takes it down and the races' own waypoints return */
  waypoint?: (at: { x: number; y: number } | null, text?: string) => void
  /** a level-start post at a place. `kind` is start, pickup, dropoff, checkpoint, finish, goal. */
  mark?: (id: string, at: { x: number; y: number }, kind?: string) => void
  unmark?: (id: string) => void
  /** the program ended: the viewer may open the next stage */
  onFinish?: (outcome: 'win' | 'lose' | 'abandoned') => void
  /** swap the player's controller */
  transport: (mode: Transport) => void
  /** apply or tween a named look from the world's presets library */
  preset: (id: string | Record<string, number>, opts?: { over?: number }) => void
  /** say something to the player */
  say: (text: string, kind?: 'info' | 'ok' | 'warn') => void
  /** where the player is, in site metres */
  playerAt: () => { x: number; y: number; z: number } | null
  /** the player's speed, m/s */
  playerSpeed: () => number
  /** set the clock, "HH:MM" local to the site */
  setTime?: (hhmm: string) => void
  /** the weather selection, by name */
  setWeather?: (what: string) => void

  /*
   * WHAT THE WORLD HAS IN IT, and how to move it.
   *
   * Rich, 2026-09-28: "Anything placed in the map should be accessible from the code editor as an
   * instance that can be controlled in the ECS system (with instances listed in the editor we can
   * reference from code by an id or something)."
   *
   * The editor writes `placements.json`; the viewer loads it and puts objects in the scene. Until
   * now a program could not see any of it — you could spawn a car from nothing but not refer to
   * the water tower somebody placed, which is the thing levels are actually about.
   *
   * These two are the whole contract: what is there, and a way to put one somewhere else. A host
   * with no placements (a dry run, a bare test) simply omits them and `api.placed` returns null,
   * which is the same answer as "there is no such id" and needs no special case in a program.
   */
  placements?: () => PlacedThing[]
  /** move a placed object. The program moves the ENTITY; this is how that reaches the scene. */
  movePlacement?: (id: string, to: { x: number; y: number; z?: number | null; yaw_deg: number; scale: number }) => void

  /**
   * THE PHYSICS WORLD, when there is one behind this run.
   *
   * Optional, and absent in a dry run — which is the point: `program.ts` holds no THREE, no DOM
   * and no wasm, so a whole game can be stepped in a test, and a program written against physics
   * still LOADS where there is none instead of throwing on its first line. Every method on
   * `api.physics` answers harmlessly when this is missing.
   *
   * See docs/corridor/PLAN-EDITOR-IDE.md §4. The engine's side of this lives in
   * `packages/engine/src/physics/`; nothing in this file imports it, because the boundary is what
   * keeps the program layer testable.
   */
  physics?: PhysicsHost
  /** weapons and damage, when the app has them */
  combat?: CombatHost
  /** the traffic zones and stunt fixtures this world was authored with */
  layers?: WorldLayersHost
  /** the interface: which one, what the player may change, what the HUD shows */
  ui?: UiHost
  /** which way the player faces: a compass bearing, degrees, 0 = north. Absent: `player()` says 0 */
  playerHeading?: () => number
  /** the ground here, metres above the datum — site x east, y north. Null off the map */
  ground?: (x: number, y: number) => number | null
  /** models a program puts into the world itself, when the app can draw them */
  models?: ModelHost
  /** the objective list, as the HUD draws it */
  objectives?: ObjectivesHost
}

/** Where the player is and what they are doing, in site metres. */
export interface PlayerState {
  x: number
  y: number
  z: number
  /** compass bearing, degrees, 0 = north, 90 = east */
  heading_deg: number
  /** m/s, unsigned */
  speed: number
}

/** Where a program-spawned model stands. `z` absent or null: on the ground there. */
export interface ModelPose {
  x: number
  y: number
  z?: number | null
  /** degrees anticlockwise from east, the way every site document writes a heading */
  yaw_deg?: number
  scale?: number
  /**
   * Metres from the camera inside which the model fades out, so a thing flying at the player never
   * blocks the view: opaque beyond this, 5% at a fifth of it and closer. Absent or 0: never fades.
   * Rich, 2026-10-08: the money flying at the car "causes some visibility problems".
   */
  nearFade?: number
}

/**
 * MODELS A PROGRAM PUTS IN THE WORLD. Rich, 2026-09-30, after the pizza level had to reach
 * `window.corridor.site.layers.placements` to hide a pizza stack and clone a wad of cash: the
 * program API could name a placed thing and not show, hide, move or make one.
 *
 * Every member optional, like the physics: a dry run draws nothing and a program that spawns is
 * still a program a test can step — `spawn` answers null there, and the rest answer false.
 */
export interface ModelHost {
  /** put a catalog asset at a pose; the id to move it by, or null when there is no such asset */
  spawn?: (asset: string, pose: ModelPose) => string | null
  move?: (id: string, pose: ModelPose) => boolean
  show?: (id: string, on: boolean) => boolean
  remove?: (id: string) => boolean
  /** where it is now, site metres */
  where?: (id: string) => Vec3 | null
}

/**
 * ONE THING TO DO, in a list the player can page through.
 *
 * Rich, 2026-09-30: *"we need to be able to cycle through objectives, so in the case of a pizza
 * stack we should be able to have a list of objectives showing the pizza, how long ago it was
 * ordered, and how far away the delivery address is — using the left and right D pad ... should
 * cycle objectives by default ... selecting the objective should repoint the arrow."*
 *
 * `at` is what the arrow points at when this one is selected; `detail` is the second line, which
 * a program rewrites as often as it likes ("ordered 14 min ago · 1.2 km"). `done` strikes it out
 * and takes it out of the cycle.
 */
export interface ObjectiveItem {
  id: string
  title: string
  detail?: string
  at?: { x: number; y: number } | null
  done?: boolean
}

export interface ObjectivesHost {
  /** draw the list, with the selected one marked; an empty list takes it down */
  show?: (items: ObjectiveItem[], selected: string | null) => void
}

/**
 * THE INTERFACE, as a program may shape it. Rich, 2026-09-30: the developer view, the map's
 * double-click teleport and the transport switch are each "disableable via the game script",
 * and "an API where we can turn off whole tabs or individual controls from the settings view".
 *
 * All optional on the host: a dry run has no interface and every call answers harmlessly. The
 * ids and the freedoms are the closed lists in gamepolicy.ts, so the editor completes them and a
 * typo is an error rather than a control that quietly stays on screen.
 */
export interface UiHost {
  /** switch the interface: the game's HUD and Escape menu, or the developer's bar */
  mode?: (m: UiMode) => void
  /** grant or take away a freedom: the developer view, the map teleport, the transport switch */
  allow?: (what: Freedom, allowed: boolean) => void
  /** hide (or show again) settings tabs and controls by id */
  settings?: (ids: string[], hidden: boolean) => void
  /** switch a piece of the game HUD off or on */
  hud?: (part: HudPart, on: boolean) => void
}

/** Site metres — x east, y north, z up. The frame every number in a program is in. */
export type Vec3 = { x: number; y: number; z: number }

/** What the player's car is doing, as the HUD, the sound and a program all read it. */
export interface CarState {
  /** m/s along the nose; negative in reverse */
  speed: number
  /** m/s across the car, + right */
  slide: number
  /** 0…1: how far past what the tyres hold the corner is asking */
  slip: number
  /** 0…1: the share of the demanded drive the tyres refused */
  wheelslip: number
  /** how many of the four wheels are on something */
  grounded: number
  airborne: boolean
  /** 0…1, accumulated impact damage */
  damage: number
}

/**
 * What the app's physics can be asked for. Every member optional on purpose — a host may have a
 * world and no destruction, and a program should degrade rather than explode.
 */
/** A blast. Site metres; `impulse` m/s at the centre falling to nothing at `radius` */
export interface ExplodeOpts {
  radius: number
  impulse: number
  /** how much of the throw goes up */
  lift?: number
  lineOfSight?: boolean
  breakAt?: number
  /** the dent at the centre, 0…1, falling off like the impulse. Absent: scaled from the force */
  damage?: number
}

/** The player's weapons. m/s for shoves, 0…1 for dents. */
export interface WeaponTuning {
  /** each gun round's shove; a car soaks rounds up, so a burst knocks where one round swerves */
  gunImpulse?: number
  /** the dent one gun round makes */
  gunDamage?: number
  missileImpulse?: number
  missileRadius?: number
  missileLift?: number
  /** the dent at the centre of a missile's blast */
  missileDamage?: number
}

/** What a hit did to a car, mildest first. */
export type HitEffect = 'swerve' | 'loose' | 'launched'

/** One simulated car. Site metres. */
export interface TrafficCar {
  entity: number
  x: number
  y: number
  z: number
  /** compass bearing, degrees, 0 = north */
  heading_deg: number
  /** m/s along the road; 0 for a loose car */
  speed: number
  /** knocked loose: the solver has it, not the road */
  loose: boolean
}

/** How to hit a car. Site metres. */
export interface TrafficHit {
  /** m/s: what grades it — a swerve, a knock, a launch */
  force: number
  /** where it comes from; default the player */
  from?: { x: number; y: number; z?: number }
  /** or the way it travels, instead of `from` */
  dir?: Vec3
  /** how much of the throw goes up; default 0.55 */
  lift?: number
  /** the dent, 0…1; absent: scaled from the force */
  damage?: number
}

/** A hit on a car, as a program hears it. */
export interface TrafficHitInfo {
  entity: number
  effect: HitEffect
  force: number
  /** 'gun', 'missile', 'blast', 'program' */
  weapon: string
  /** where the car was, site metres */
  at: Vec3
}

export interface PhysicsHost {
  setProfile?: (id: string, overrides?: Record<string, number>) => void
  blendProfile?: (id: string, t: number, opts?: { over?: number }) => void
  explode?: (at: Vec3, opts: ExplodeOpts) => number
  /** the player's weapons: set what is given and answer everything in force; null puts the defaults back */
  weapons?: (set: WeaponTuning | null) => Required<WeaponTuning>
  impulse?: (entity: number, v: Vec3) => void
  break?: (what: number | string) => number
  ray?: (from: Vec3, dir: Vec3, maxDistance: number) => { entity: number; point: Vec3; normal: Vec3 } | null
  car?: () => CarState | null
  onImpact?: (fn: (e: { a: number; b: number; point: Vec3; impulse: number }) => void) => void
  /** give one entity its own handling, for a chase car that is not the player's */
  setEntityProfile?: (entity: number, id: string, overrides?: Record<string, number>) => void
}

/**
 * The TRAFFIC AREAS somebody painted, and the STUNT FIXTURES somebody placed.
 *
 * Rich, 2026-09-29: *"I don't see any of these placed assets like traffic or stunts appearing in
 * the program editor. I would have presumed they would show up as placeable references in code so
 * we do things like trigger traffic and show and hide stunts."*
 *
 * The same shape as `placed()` and for the same reason: the editor lists the ids beside the code,
 * which is how you know what to type. Optional throughout, so a dry run with no world still steps.
 */
export interface WorldLayersHost {
  /* ---- races ---------------------------------------------------------------------------------- */
  /** the circuits and stages this world was authored with */
  raceIds?: () => string[]
  /** one of them, by id — its name, kind, laps, and how many gates */
  race?: (id: string) => { id: string; name: string; kind: 'circuit' | 'stage'; laps: number; gates: number } | null
  /** begin one without driving into its marker. False when there is no such race */
  startRace?: (id: string) => boolean
  /** give up whatever is running */
  abandonRace?: () => void
  /** what the race is doing now */
  raceState?: () => { phase: string; course: string | null; time: number; penalties: number; lap: number; laps: number } | null

  /** the ids of the painted traffic zones */
  trafficIds?: () => string[]
  /** how busy one is now, 0…1, or null when there is no such zone */
  trafficDensity?: (id: string) => number | null
  /** make one busier or clearer, optionally easing over `over` seconds. False when there is no such zone */
  setTraffic?: (id: string, density: number, opts?: { over?: number }) => boolean
  /** how busy it is at a point, whatever zone that is — 0 outside every one */
  trafficAt?: (x: number, y: number) => number
  /** the simulated cars near a point (null: the player), nearest first */
  trafficCars?: (near: { x: number; y: number } | null, radius: number, max: number) => TrafficCar[]
  /** hit one car. What it did, or null when there is no such car in sight */
  trafficHit?: (entity: number, hit: TrafficHit) => HitEffect | null
  /** every hit on a car, by anything; returns the unsubscribe */
  onTrafficHit?: (fn: (e: TrafficHitInfo) => void) => () => void

  /** the ids of the stunt fixtures standing on the road */
  stuntIds?: () => string[]
  showStunt?: (id: string, on: boolean) => boolean
  stuntVisible?: (id: string) => boolean | null
  /** where one is, so a program can put a camera, a checkpoint or a countdown on it */
  stuntAt?: (id: string) => Vec3 | null
}

/**
 * What the app's COMBAT can be asked for. Optional throughout, like `PhysicsHost` and for the same
 * reason: a host may have weapons and no physics, or neither, and a program should degrade rather
 * than explode.
 *
 * WEAPONS ARE NAMED, NOT DESCRIBED. `arm` takes an asset id, because a weapon is an ordinary item in
 * the library with a document beside it (`src/weapons.ts`) — so a program says which weapon rather
 * than restating one, and the two cannot drift.
 */
export interface CombatHost {
  /** give an entity a weapon by asset id. False when there is no such weapon */
  arm?: (entity: number, weaponId: string) => boolean
  /** what it is holding, or null */
  armed?: (entity: number) => string | null
  /** fire what it is holding, in a direction. Returns what it hit, or null */
  fire?: (entity: number, dir: Vec3) => { entity: number | null; point: Vec3; damage: number } | null
  /** hurt something directly — a script, a trap, a fall */
  damage?: (entity: number, amount: number) => number
}

/** One thing the editor placed in this world. Site metres, compass bearing — as saved. */
export interface PlacedThing {
  id: string
  asset: string
  x: number
  y: number
  z: number | null
  yaw_deg: number
  scale: number
  tags: string[]
}

/* ---- zones: the one spatial primitive ---------------------------------------------------- */

/**
 * A named region a program can ask about.
 *
 * Circles and boxes only. Every goal anyone has described so far — reach a place, stay out of an
 * area, collect the things on a rooftop — is one of those two, and a polygon primitive is a
 * point-in-polygon test plus an editor for drawing them, which is a lot of surface for a case
 * nobody has yet.
 */
export type Zone =
  | { kind: 'circle'; x: number; y: number; r: number }
  | { kind: 'box'; x0: number; y0: number; x1: number; y1: number }

export function inZone(z: Zone, x: number, y: number): boolean {
  if (z.kind === 'circle') return (x - z.x) ** 2 + (y - z.y) ** 2 <= z.r * z.r
  return x >= Math.min(z.x0, z.x1) && x <= Math.max(z.x0, z.x1) && y >= Math.min(z.y0, z.y1) && y <= Math.max(z.y0, z.y1)
}

/* ---- facts: the vocabulary a condition is written against -------------------------------- */

/**
 * Everything a program or a scenario may read about the run.
 *
 * The same idea as the service's `FACTS` table, and deliberately the same words where they
 * overlap: a condition that mentions something nothing measures never fires, and nothing anywhere
 * says so. When something genuinely does not fit, the answer is one more fact here.
 */
export interface Facts {
  /** seconds since the run started, on the run's own clock */
  time: number
  score: number
  /** the player's speed, m/s */
  speed: number
  /** metres travelled */
  distance_m: number
  /** how many zones the player is inside right now */
  in_zones: number
  /** 1 while the run is over, else 0 */
  finished: number
}

export type Outcome = 'win' | 'lose' | 'abandoned'

/* ---- the API a program is written against ------------------------------------------------ */

export interface GameApi {
  /** the ECS world, for everything the declarative surface cannot express */
  readonly world: World
  readonly actors: ActorWorld
  /** the facts, as of this frame */
  facts(): Facts

  hide(what: Hideable): void
  show(what: Hideable): void
  transport(mode: Transport): void
  preset(id: string | Record<string, number>, opts?: { over?: number }): void
  say(text: string, kind?: 'info' | 'ok' | 'warn'): void
  time(hhmm: string): void
  weather(what: string): void

  /**
   * The interface. Everything here defaults to ON and to the player's own choice; a program
   * takes things away, and they come back when it stops.
   */
  ui: {
    /** force the game's interface or the developer's; the player's Escape-menu choice is overruled */
    mode(m: UiMode): void
    /** may the player switch to the developer view from the Escape menu? */
    developer(allowed: boolean): void
    /** may a double-click on the map drop the car there? */
    teleport(allowed: boolean): void
    /** may the player leave the car, fly, walk, or take a craft (Tab, V, B, the menu)? */
    transport(allowed: boolean): void
    settings: {
      /** hide settings: a tab (`'display'`) or a control (`'display.theme'`) */
      hide(...ids: SettingId[]): void
      show(...ids: SettingId[]): void
    }
    hud: {
      hide(part: HudPart): void
      show(part: HudPart): void
    }
  }

  /*
   * THINGS THE EDITOR PLACED, AS ENTITIES.
   *
   * `placed('p-07')` is the water tower somebody dragged into the world, as an ECS entity with a
   * Transform and a Visual — so every system that moves things moves it, and a program can make
   * the crane swing by writing to `Transform.yaw`. The entity is created the first time it is
   * asked for and the same one comes back afterwards, so `placed` in an `each` is not a leak.
   *
   * The ids are what the editor lists beside the code, which is how you know what to type.
   */
  placed(id: string): number | null
  /** every placement carrying a tag — the editor writes the asset's category as one */
  placedWith(tag: string): number[]
  /** what is in this world, ids and all, for a program that would rather look than be told */
  placements(): PlacedThing[]

  /**
   * PHYSICS, for the games that want their own.
   *
   * "let you define your own physics for individual games" — a level may say how the car handles,
   * blow something up, shove an entity, ask what is solid along a ray, and watch for impacts.
   *
   * IT IS SAFE WITHOUT A PHYSICS WORLD. A dry run has none; every call here does nothing and the
   * readers answer null, so a program that uses physics is still a program you can step in a test.
   * `available` is how a program asks rather than guesses.
   */
  /**
   * THE WORLD'S OWN LAYERS: the traffic somebody painted and the stunts somebody placed.
   *
   * Editor-placed things, as references a program can name — the same idea as `placed(id)` for a
   * water tower, and the reason `ids()` exists is so a program can look rather than be told.
   *
   * SAFE WITH NO WORLD. A dry run has no zones and no fixtures; every setter answers false and
   * every reader answers null or zero, so a program that closes a bridge is still a program you can
   * step in a test.
   */
  readonly traffic: {
    /** every painted zone, by id */
    ids(): string[]
    /** how busy one is now, 0…1 */
    density(id: string): number | null
    /**
     * Make one busier or clearer. `over` eases it in seconds rather than in one frame, because a
     * road that fills up between two frames looks like a bug rather than like a jam.
     */
    set(id: string, density: number, opts?: { over?: number }): boolean
    /** how busy it is at a point — 0 outside every zone, which is what a world with none is */
    at(x: number, y: number): number
    /**
     * THE CARS THEMSELVES, nearest first: entity, where, which way, how fast, and whether one is
     * already loose. `near` defaults to the player; `radius` to 300 m; `max` to 50.
     */
    cars(opts?: { near?: { x: number; y: number }; radius?: number; max?: number }): TrafficCar[]
    /**
     * Hit one car. Graded by `force` (m/s): under the knock threshold a driven car SWERVES across its
     * lane and drives on; over it the car is knocked LOOSE and thrown; a throw that leaves it
     * climbing fast is a LAUNCH. Answers which, or null when there is no such car in sight.
     */
    hit(entity: number, hit: TrafficHit): HitEffect | null
    /**
     * Every hit on a car — the player's gun and missiles, an `explode`, a `hit` — with what it did.
     * The physical effect has already happened; this is for what a level does about it (pay out,
     * score, say something). A burst of gunfire is a hit per round: watch `effect` change.
     */
    onHit(fn: (e: TrafficHitInfo) => void): void
  }
  /**
   * THE RACES THIS WORLD WAS AUTHORED WITH.
   *
   * A program picks one by id and starts it, or watches the one the player drove into. The ids are
   * what the editor lists beside the code — the same rule as `placed`, `traffic` and `stunts`.
   */
  readonly races: {
    /** every circuit and stage, by id */
    ids(): string[]
    /** one of them: its name, kind, laps and gate count */
    get(id: string): { id: string; name: string; kind: 'circuit' | 'stage'; laps: number; gates: number } | null
    /** begin one. False when this world has no such race */
    start(id: string): boolean
    /** give up whatever is running */
    abandon(): void
    /** what is happening now — phase, elapsed time, penalties, lap */
    state(): { phase: string; course: string | null; time: number; penalties: number; lap: number; laps: number } | null
  }
  readonly stunts: {
    /** every fixture standing on the road, by id */
    ids(): string[]
    /** show or hide one. The baked road under it comes back when it is hidden */
    show(id: string, on: boolean): boolean
    visible(id: string): boolean | null
    /** where it is, in site metres */
    where(id: string): Vec3 | null
  }
  readonly physics: {
    /** is there a physics world behind this run at all */
    available(): boolean
    /** how the player's car handles. `overrides` is a partial DriveProfile, by key */
    profile(id: string, overrides?: Record<string, number>): void
    /** move toward another profile — the car gets looser as it takes damage */
    blend(id: string, t: number, opts?: { over?: number }): void
    /** one entity's own handling, for something that is not the player */
    entityProfile(entity: number, id: string, overrides?: Record<string, number>): void
    /**
     * A bomb, in site metres. Returns how many things it moved. Traffic in reach is graded like
     * any hit (see `traffic.hit`): the edge of a blast makes cars swerve, the middle throws them,
     * and `damage` (0…1 at the centre) dents them.
     */
    explode(at: Vec3, opts: ExplodeOpts): number
    /**
     * THE PLAYER'S WEAPONS, as a level wants them: the gun's per-round shove and the missile's
     * blast, and how much each dents. Pass only what changes; the answer is everything in force.
     * The defaults come back when the program stops.
     */
    weapons(set?: WeaponTuning): Required<WeaponTuning>
    /** shove one entity */
    impulse(entity: number, v: Vec3): void
    /** break a named breakable, or an entity. Returns how many pieces */
    break(what: number | string): number
    /** what is solid along this ray — the primitive a new exploration technique needs */
    ray(from: Vec3, dir: Vec3, maxDistance: number): { entity: number; point: Vec3; normal: Vec3 } | null
    /** the player's car, read-only */
    car(): Readonly<CarState> | null
    /** something was hit hard enough to matter */
    onImpact(fn: (e: { a: number; b: number; point: Vec3; impulse: number }) => void): void
  }

  /**
   * COMBAT: arm something, and make it fire.
   *
   * Deliberately four calls. Everything else a fight needs — who is hostile, how much health is
   * left, what is in range — is already the ECS's, and a second vocabulary for it here would be a
   * second thing to keep in step. These are the verbs the ECS has no way to express.
   *
   * Safe with no combat host: `arm` returns false, `fire` returns null, nothing throws, and a
   * program that uses them is still a program you can step in a test.
   */
  /** give an entity a weapon from the asset library, by id. False if there is no such weapon */
  arm(entity: number, weaponId: string): boolean
  /** what an entity is holding, or null */
  armed(entity: number): string | null
  /** fire what it is holding. Returns what was hit, or null for a miss or an empty hand */
  fire(entity: number, dir: Vec3): { entity: number | null; point: Vec3; damage: number } | null
  /** hurt something directly. Returns the health it has left */
  hurt(entity: number, amount: number): number

  /** name a region, so `on('enters', …)` and `in()` can refer to it */
  zone(name: string, z: Zone): void
  /** is the player in it right now */
  in(name: string): boolean

  award(points: number): void
  /** what the player is trying to do, in a sentence the HUD can show */
  goal(text: string): void
  /**
   * Point the player at a place, site metres, with a line about it — the arrow in the corner and
   * the message under it. Null takes it down; while a program has none, the races supply their
   * own (the entry ring, then the next gate).
   */
  waypoint(at: { x: number; y: number } | null, text?: string): void
  /** the same post a level start uses, at a pickup or a drop-off */
  mark(id: string, at: { x: number; y: number }, kind?: string): void
  unmark(id: string): void
  win(text?: string): void
  lose(text?: string): void

  /** where the player is, which way they face, how fast — null with no player */
  player(): PlayerState | null
  /** the ground at a point, metres above the datum; null off the map or in a dry run */
  ground(x: number, y: number): number | null

  /**
   * MODELS OF THE PROGRAM'S OWN: a pickup on the ground, a reward flying at the car. Assets are
   * catalog ids (anything the editor could place). Safe with no host: `spawn` answers null.
   */
  readonly models: {
    spawn(asset: string, pose: ModelPose): string | null
    move(id: string, pose: ModelPose): boolean
    show(id: string, on: boolean): boolean
    remove(id: string): boolean
    where(id: string): Vec3 | null
  }

  /**
   * THE OBJECTIVE LIST. The HUD draws it, the D-pad (and Q / E) page through it, and the arrow
   * points at whichever is selected. `set` replaces the list and keeps the selection when its id
   * survives; `complete` strikes one out and moves the selection on. An explicit `waypoint()`
   * call still wins until the selection next changes.
   */
  readonly objectives: {
    set(items: ObjectiveItem[]): void
    list(): ObjectiveItem[]
    select(id: string | null): void
    selected(): ObjectiveItem | null
    next(): void
    prev(): void
    complete(id: string): void
    /** told whenever the selection changes — by the program or by the player */
    onSelect(fn: (item: ObjectiveItem | null) => void): void
  }

  /** every frame, with the real delta */
  each(fn: (dt: number, facts: Facts) => void): void
  /** once, after `after` seconds of run time */
  after(seconds: number, fn: () => void): void
  /** every `seconds` of run time */
  every(seconds: number, fn: () => void): void
  /** the player crossed into or out of a zone */
  on(event: 'enters' | 'leaves', zone: string, fn: () => void): void
  /** the run ended */
  on(event: 'ends', fn: (outcome: Outcome) => void): void
  /** when a fact crosses a threshold, once per crossing */
  when(condition: (f: Facts) => boolean, fn: () => void): void
}

export interface GameDef {
  /** run once when the level starts */
  setup?: (api: GameApi) => void | Promise<void>
  /** run every frame. `api.each` is the same thing; this is here because it reads better. */
  update?: (dt: number, api: GameApi) => void
  /** run when the level is torn down */
  teardown?: (api: GameApi) => void
}

/** What `programs/<id>.ts` default-exports. A function only so the shape is checkable. */
export function defineGame(def: GameDef): GameDef {
  return def
}

/** A number that is actually a number. `NaN` in a radius is a query over the whole world. */
const finite = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n)
/** A point that is actually a point. */
const vec = (v: unknown): boolean => !!v && finite((v as Vec3).x) && finite((v as Vec3).y) && finite((v as Vec3).z)

/* ---- the runner -------------------------------------------------------------------------- */

interface Timer { at: number; every: number | null; fn: () => void }
interface Watch { cond: (f: Facts) => boolean; fn: () => void; was: boolean }

/**
 * One run of one program.
 *
 * TIME IS THE RUN'S OWN, advanced by `tick`, not read from a clock. A program that says "after 30
 * seconds" means thirty seconds of play, so pausing has to pause it and a test has to be able to
 * step it — reading `performance.now()` here would make every timed goal untestable and every
 * paused game keep counting.
 *
 * NOTHING THROWN BY A PROGRAM ESCAPES. A program is code from a person or an agent; a typo in
 * somebody's `update` must show up as one message and a stopped program, not as a dead frame loop
 * that takes the rest of the viewer with it.
 */
export class GameRun {
  private readonly host: ProgramHost
  private readonly def: GameDef
  private zones = new Map<string, Zone>()
  private inside = new Set<string>()
  private frameFns: ((dt: number, f: Facts) => void)[] = []
  private timers: Timer[] = []
  private watches: Watch[] = []
  private enters = new Map<string, (() => void)[]>()
  private leaves = new Map<string, (() => void)[]>()
  private endFns: ((o: Outcome) => void)[] = []
  /** what to undo when the program stops: hit listeners, weapon overrides */
  private cleanups: (() => void)[] = []
  private readonly resetWeapons = (): void => { this.host.physics?.weapons?.(null) }

  private t = 0
  private travelled = 0
  private last: { x: number; y: number } | null = null

  score = 0
  goalText = ''
  outcome: Outcome | null = null
  /** the objective list and which one the arrow follows; what a HUD and a probe read */
  objectiveItems: ObjectiveItem[] = []
  selectedObjective: string | null = null
  private selectFns: ((item: ObjectiveItem | null) => void)[] = []
  /** what went wrong, if the program threw. A stopped program is not a silent one. */
  error: string | null = null
  readonly messages: { text: string; kind: string; at: number }[] = []

  constructor(host: ProgramHost, def: GameDef) {
    this.host = host
    this.def = def
  }

  get api(): GameApi {
    const H = this.host
    const api: GameApi = {
      get world() { return H.actors.world },
      get actors() { return H.actors },
      facts: () => this.facts(),

      hide: (w) => H.hide(w, true),
      show: (w) => H.hide(w, false),
      transport: (m) => H.transport(m),
      preset: (id, o) => H.preset(id, o),
      say: (t, k) => { this.messages.push({ text: t, kind: k ?? 'info', at: this.t }); H.say(t, k) },
      time: (hhmm) => H.setTime?.(hhmm),
      weather: (w) => H.setWeather?.(w),

      ui: {
        mode: (m) => { if (m === 'game' || m === 'dev') H.ui?.mode?.(m) },
        developer: (ok) => H.ui?.allow?.('developer', !!ok),
        teleport: (ok) => H.ui?.allow?.('teleport', !!ok),
        transport: (ok) => H.ui?.allow?.('transport', !!ok),
        settings: {
          hide: (...ids) => H.ui?.settings?.(ids.filter((id) => typeof id === 'string'), true),
          show: (...ids) => H.ui?.settings?.(ids.filter((id) => typeof id === 'string'), false),
        },
        hud: {
          hide: (part) => H.ui?.hud?.(part, false),
          show: (part) => H.ui?.hud?.(part, true),
        },
      },

      /*
       * NOTHING HERE THROWS AND NOTHING HERE ASSUMES.
       *
       * A program is code from a person or an agent, and a host may be a dry run with no physics
       * at all — so every call is guarded at this one boundary rather than in each program. A
       * number that is not a number is refused here too: `explode` with a radius of NaN reaches
       * Rapier as a query over the whole world.
       */
      traffic: {
        ids: () => H.layers?.trafficIds?.() ?? [],
        density: (id) => H.layers?.trafficDensity?.(id) ?? null,
        set: (id, d, o) => (H.layers?.setTraffic && typeof id === 'string' && finite(d)
          ? H.layers.setTraffic(id, Math.max(0, Math.min(1, d)), o)
          : false),
        at: (x, y) => (H.layers?.trafficAt && finite(x) && finite(y) ? H.layers.trafficAt(x, y) : 0),
        cars: (o) => {
          if (!H.layers?.trafficCars) return []
          const near = o?.near && finite(o.near.x) && finite(o.near.y) ? o.near : null
          return H.layers.trafficCars(near, finite(o?.radius) ? Math.max(0, o!.radius!) : 300, finite(o?.max) ? Math.max(0, Math.floor(o!.max!)) : 50)
        },
        hit: (e, h) => (H.layers?.trafficHit && finite(e) && h && finite(h.force) && (!h.dir || vec(h.dir))
          ? H.layers.trafficHit(e, h)
          : null),
        onHit: (fn) => {
          const off = H.layers?.onTrafficHit?.((e) => this.guard(() => fn(e)))
          if (off) this.cleanups.push(off)
        },
      },
      races: {
        ids: () => H.layers?.raceIds?.() ?? [],
        get: (id) => H.layers?.race?.(id) ?? null,
        start: (id) => (typeof id === 'string' && id ? H.layers?.startRace?.(id) ?? false : false),
        abandon: () => H.layers?.abandonRace?.(),
        state: () => H.layers?.raceState?.() ?? null,
      },
      stunts: {
        ids: () => H.layers?.stuntIds?.() ?? [],
        show: (id, on) => H.layers?.showStunt?.(id, !!on) ?? false,
        visible: (id) => H.layers?.stuntVisible?.(id) ?? null,
        where: (id) => H.layers?.stuntAt?.(id) ?? null,
      },

      physics: {
        available: () => !!H.physics,
        profile: (id, o) => H.physics?.setProfile?.(id, o),
        blend: (id, t, o) => H.physics?.blendProfile?.(id, finite(t) ? t : 0, o),
        entityProfile: (e, id, o) => H.physics?.setEntityProfile?.(e, id, o),
        explode: (at, opts) => (H.physics?.explode && vec(at) && finite(opts?.radius) && finite(opts?.impulse)
          ? H.physics.explode(at, opts)
          : 0),
        weapons: (set) => {
          const clean: WeaponTuning = {}
          for (const [k, v] of Object.entries(set ?? {})) if (finite(v)) (clean as Record<string, number>)[k] = v as number
          if (!H.physics?.weapons) return { gunImpulse: 0, gunDamage: 0, missileImpulse: 0, missileRadius: 0, missileLift: 0, missileDamage: 0 }
          if (Object.keys(clean).length && !this.cleanups.includes(this.resetWeapons)) this.cleanups.push(this.resetWeapons)
          return H.physics.weapons(clean)
        },
        impulse: (e, v) => { if (H.physics?.impulse && vec(v)) H.physics.impulse(e, v) },
        break: (what) => H.physics?.break?.(what) ?? 0,
        ray: (from, dir, max) => (H.physics?.ray && vec(from) && vec(dir) && finite(max) ? H.physics.ray(from, dir, max) : null),
        car: () => H.physics?.car?.() ?? null,
        onImpact: (fn) => H.physics?.onImpact?.((e) => this.guard(() => fn(e))),
      },

      arm: (e, id) => (typeof id === 'string' && id ? H.combat?.arm?.(e, id) ?? false : false),
      armed: (e) => H.combat?.armed?.(e) ?? null,
      fire: (e, dir) => (H.combat?.fire && vec(dir) ? H.combat.fire(e, dir) : null),
      hurt: (e, amount) => (H.combat?.damage && finite(amount) ? H.combat.damage(e, amount) : 0),

      placed: (id) => this.entityFor(id),
      placedWith: (tag) => (H.placements?.() ?? []).filter((p) => p.tags.includes(tag)).map((p) => this.entityFor(p.id)).filter((e): e is number => e !== null),
      placements: () => H.placements?.() ?? [],

      zone: (name, z) => { this.zones.set(name, z) },
      in: (name) => this.inside.has(name),

      award: (p) => { this.score += p },
      goal: (text) => { this.goalText = text },
      waypoint: (at, text) => this.host.waypoint?.(at, text),
      mark: (id, at, kind) => { if (id && at && Number.isFinite(at.x) && Number.isFinite(at.y)) this.host.mark?.(id, at, kind) },
      unmark: (id) => { if (id) this.host.unmark?.(id) },
      win: (text) => this.finish('win', text),
      lose: (text) => this.finish('lose', text),

      player: () => {
        const at = H.playerAt()
        if (!at) return null
        return { x: at.x, y: at.y, z: at.z, heading_deg: H.playerHeading?.() ?? 0, speed: Math.abs(H.playerSpeed()) }
      },
      ground: (x, y) => (H.ground && finite(x) && finite(y) ? H.ground(x, y) : null),

      models: {
        spawn: (asset, pose) => (H.models?.spawn && typeof asset === 'string' && asset && pose && finite(pose.x) && finite(pose.y) ? H.models.spawn(asset, pose) : null),
        move: (id, pose) => (H.models?.move && pose && finite(pose.x) && finite(pose.y) ? H.models.move(id, pose) : false),
        show: (id, on) => H.models?.show?.(id, !!on) ?? false,
        remove: (id) => H.models?.remove?.(id) ?? false,
        where: (id) => H.models?.where?.(id) ?? null,
      },

      objectives: {
        set: (items) => this.setObjectives(items),
        list: () => this.objectiveItems.map((o) => ({ ...o })),
        select: (id) => this.selectObjective(id),
        selected: () => this.objectiveItems.find((o) => o.id === this.selectedObjective) ?? null,
        next: () => this.cycleObjective(1),
        prev: () => this.cycleObjective(-1),
        complete: (id) => {
          const o = this.objectiveItems.find((x) => x.id === id)
          if (!o || o.done) return
          o.done = true
          if (this.selectedObjective === id) this.selectObjective(this.firstOpenObjective())
          else this.showObjectives()
        },
        onSelect: (fn) => { this.selectFns.push(fn) },
      },

      each: (fn) => { this.frameFns.push(fn) },
      after: (s, fn) => { this.timers.push({ at: this.t + s, every: null, fn }) },
      every: (s, fn) => { this.timers.push({ at: this.t + s, every: Math.max(1e-3, s), fn }) },
      on: ((event: string, a: unknown, b?: unknown) => {
        if (event === 'ends') { this.endFns.push(a as (o: Outcome) => void); return }
        const map = event === 'enters' ? this.enters : this.leaves
        const name = a as string
        const list = map.get(name) ?? []
        list.push(b as () => void)
        map.set(name, list)
      }) as GameApi['on'],
      when: (cond, fn) => { this.watches.push({ cond, fn, was: cond(this.facts()) }) },
    }
    return api
  }

  /**
   * The entity for a placement, made once.
   *
   * IT CARRIES THE SAME NUMBERS THE DOCUMENT DOES, which is what makes it controllable: a system
   * that writes `Transform.x` has moved the thing in the world, and `syncPlaced` carries that
   * back out to the scene at the end of the tick. The entity is NOT given `Autonomous`: a placed
   * building is not traffic, and anything that should drive itself is a program's decision.
   */
  private placedEntities = new Map<string, number>()
  private entityFor(id: string): number | null {
    const known = this.placedEntities.get(id)
    if (known !== undefined) return known
    const p = (this.host.placements?.() ?? []).find((x) => x.id === id)
    if (!p) return null
    const w = this.host.actors.world
    const e = addEntity(w)
    addComponent(w, e, Transform)
    addComponent(w, e, Visual)
    Transform.x[e] = p.x
    Transform.y[e] = p.y
    Transform.z[e] = p.z ?? 0
    Transform.yaw[e] = (p.yaw_deg * Math.PI) / 180
    Visual.scale[e] = p.scale
    this.placedEntities.set(id, e)
    // SEEDED FROM THE ENTITY, NOT THE DOCUMENT. `Transform` is a Float32Array, so 90° stored and
    // read back is 90.000001 — and comparing that against the document's 90 reports every
    // placement as moved on the first tick, which is a scene rebuild per prop for nothing.
    this.placedWas.set(id, { ...this.poseOf(e), z: p.z })
    return e
  }

  /**
   * Carry any entity the program moved back out to the scene.
   *
   * ONLY WHAT CHANGED. This runs every tick over every placement a program has touched, and
   * telling the viewer to move an object that is exactly where it already is would rebuild a
   * matrix per frame per prop for nothing.
   */
  private placedWas = new Map<string, { x: number; y: number; z: number | null; yaw: number; scale: number }>()

  /** What the entity says its pose is, in the document's units. */
  private poseOf(e: number): { x: number; y: number; z: number; yaw: number; scale: number } {
    return {
      x: Transform.x[e],
      y: Transform.y[e],
      z: Transform.z[e],
      yaw: (((Transform.yaw[e] * 180) / Math.PI) % 360 + 360) % 360,
      scale: Visual.scale[e] || 1,
    }
  }

  private syncPlaced(): void {
    const move = this.host.movePlacement
    if (!move) return
    for (const [id, e] of this.placedEntities) {
      const was = this.placedWas.get(id)!
      const now = this.poseOf(e)
      // A TOLERANCE, not equality. These are float32s written and read every tick, so an exact
      // comparison reports movement that never happened; a millimetre and a thousandth of a
      // degree are below anything a person placed and above the noise.
      const still = Math.abs(now.x - was.x) < 1e-3
        && Math.abs(now.y - was.y) < 1e-3
        && Math.abs(now.scale - was.scale) < 1e-4
        && Math.min(Math.abs(now.yaw - was.yaw), 360 - Math.abs(now.yaw - was.yaw)) < 1e-3
        && (was.z === null || Math.abs(now.z - was.z) < 1e-3)
      if (still) continue
      move(id, { x: now.x, y: now.y, z: was.z === null ? null : now.z, yaw_deg: now.yaw, scale: now.scale })
      this.placedWas.set(id, { ...now, z: was.z })
    }
  }

  /** The zones this program declared, by name — what a dry run reports and a HUD can list. */
  get zoneNames(): string[] {
    return [...this.zones.keys()]
  }

  /* ---- objectives ------------------------------------------------------------------------- */

  private firstOpenObjective(): string | null {
    return this.objectiveItems.find((o) => !o.done)?.id ?? this.objectiveItems[0]?.id ?? null
  }

  private setObjectives(items: ObjectiveItem[]): void {
    this.objectiveItems = (Array.isArray(items) ? items : [])
      .filter((o) => o && typeof o.id === 'string' && o.id)
      .map((o) => ({ id: o.id, title: String(o.title ?? o.id), detail: o.detail, at: o.at && finite(o.at.x) && finite(o.at.y) ? { x: o.at.x, y: o.at.y } : null, done: !!o.done }))
    const cur = this.objectiveItems.find((o) => o.id === this.selectedObjective)
    // the same one stays selected while it is still open; otherwise the first open one
    if (cur && !cur.done) this.selectObjective(cur.id, { keep: true })
    else this.selectObjective(this.firstOpenObjective())
  }

  /**
   * Select one. `keep` means the id did not change (a `set` refreshed the details): the HUD and
   * the arrow's line are redrawn, but the program is not told of a selection that did not happen
   * and an explicit waypoint is not overruled.
   */
  private selectObjective(id: string | null, opts: { keep?: boolean } = {}): void {
    const item = this.objectiveItems.find((o) => o.id === id) ?? null
    const changed = (item?.id ?? null) !== this.selectedObjective
    this.selectedObjective = item?.id ?? null
    this.showObjectives()
    if (item?.at && (changed || opts.keep)) this.host.waypoint?.(item.at, item.detail ? `${item.title} · ${item.detail}` : item.title)
    else if (changed && !item) this.host.waypoint?.(null)
    if (changed) for (const fn of this.selectFns) this.guard(fn as () => void, item)
  }

  /**
   * The player paged the list (the D-pad, Q / E): the next open objective in that direction,
   * wrapping. With nothing open it pages through everything, so a finished list is still readable.
   */
  cycleObjective(dir: 1 | -1): void {
    if (this.outcome || this.error) return
    const open = this.objectiveItems.filter((o) => !o.done)
    const ring = open.length ? open : this.objectiveItems
    if (!ring.length) return
    const i = ring.findIndex((o) => o.id === this.selectedObjective)
    const j = i < 0 ? (dir > 0 ? 0 : ring.length - 1) : (i + dir + ring.length) % ring.length
    this.selectObjective(ring[j].id)
  }

  private showObjectives(): void {
    this.host.objectives?.show?.(this.objectiveItems.map((o) => ({ ...o })), this.selectedObjective)
  }

  facts(): Facts {
    return {
      time: this.t,
      score: this.score,
      speed: this.host.playerSpeed(),
      distance_m: this.travelled,
      in_zones: this.inside.size,
      finished: this.outcome ? 1 : 0,
    }
  }

  /** Run `setup`. Returns false if the program threw, with `error` set. */
  async start(): Promise<boolean> {
    // WHERE THE PLAYER IS WHEN THE LEVEL STARTS is where `distance_m` counts from. Without this,
    // the first tick only establishes the origin and the distance covered in that frame is lost —
    // small every frame, and exactly wrong for a "travel one kilometre" goal measured from a spawn.
    const at = this.host.playerAt()
    if (at) this.last = { x: at.x, y: at.y }
    try {
      await this.def.setup?.(this.api)
      return true
    } catch (e) {
      this.error = String((e as Error)?.message ?? e)
      return false
    }
  }

  /**
   * Advance the run by `dt` real seconds.
   *
   * Order matters and is the order a person would expect: move the clock, work out where the
   * player is, fire the zone crossings, fire the timers, fire the watches, then the frame
   * callbacks and `update`. Zones before timers so a program that awards on entry and checks the
   * score on a timer sees the award.
   */
  tick(dt: number): void {
    if (this.outcome || this.error) return
    const step = Math.max(0, dt)
    this.t += step

    const at = this.host.playerAt()
    if (at) {
      if (this.last) this.travelled += Math.hypot(at.x - this.last.x, at.y - this.last.y)
      this.last = { x: at.x, y: at.y }
      for (const [name, z] of this.zones) {
        const now = inZone(z, at.x, at.y)
        const was = this.inside.has(name)
        if (now && !was) { this.inside.add(name); this.fire(this.enters.get(name)) }
        else if (!now && was) { this.inside.delete(name); this.fire(this.leaves.get(name)) }
      }
    }

    // a copy, because a timer may add another and a repeating one is rescheduled in place
    for (const timer of [...this.timers]) {
      if (this.outcome || this.error) break
      if (this.t < timer.at) continue
      this.guard(timer.fn)
      if (timer.every) timer.at += timer.every
      else this.timers = this.timers.filter((x) => x !== timer)
    }

    for (const w of this.watches) {
      if (this.outcome || this.error) break
      let now = false
      try { now = w.cond(this.facts()) } catch (e) { this.fault(e); break }
      // ONCE PER CROSSING, not every frame it holds: `when(f => f.score >= 100)` firing sixty
      // times a second is the difference between a bonus and an infinite loop
      if (now && !w.was) this.guard(w.fn)
      w.was = now
    }

    for (const fn of [...this.frameFns]) {
      if (this.outcome || this.error) break
      this.guard(() => fn(step, this.facts()))
    }
    if (!this.outcome && !this.error && this.def.update) this.guard(() => this.def.update!(step, this.api))
    // LAST, so a program that moved something this frame sees it move this frame. Before the
    // update it would be one tick behind, which reads as input lag on anything being steered.
    this.syncPlaced()
  }

  finish(outcome: Outcome, text?: string): void {
    if (this.outcome) return
    this.outcome = outcome
    if (text) {
      this.messages.push({ text, kind: outcome === 'win' ? 'ok' : 'warn', at: this.t })
      this.host.say(text, outcome === 'win' ? 'ok' : 'warn')
    }
    for (const fn of this.endFns) this.guard(fn as () => void, outcome)
    this.host.onFinish?.(outcome)
  }

  stop(): void {
    if (!this.outcome) this.finish('abandoned')
    this.guard(() => this.def.teardown?.(this.api))
    for (const fn of this.cleanups.splice(0)) this.guard(fn)
    this.objectiveItems = []
    this.selectedObjective = null
    this.host.objectives?.show?.([], null)
  }

  /** Run a program's callback; a throw stops the program and says so, and takes nothing with it. */
  private guard(fn: (...a: never[]) => void, ...args: unknown[]): void {
    try {
      ;(fn as (...a: unknown[]) => void)(...args)
    } catch (e) {
      this.fault(e)
    }
  }

  private fault(e: unknown): void {
    if (this.error) return
    this.error = String((e as Error)?.message ?? e)
    this.host.say(`the level's program stopped: ${this.error}`, 'warn')
  }

  private fire(list: (() => void)[] | undefined): void {
    for (const fn of list ?? []) {
      if (this.outcome || this.error) return
      this.guard(fn)
    }
  }
}
