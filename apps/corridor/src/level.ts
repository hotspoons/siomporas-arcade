// A level, loaded: the world dressed as the document says.
//
// The level document is defined and validated in `tools/worldeditor/levels.mjs` — it names a
// baked world, splats to lay over it, assets to place in it, simulations to run in it and a
// scenario saying what you are meant to do. This is the half that reads one.
//
// WHAT IT DOES NOT DO. It does not load the world; the world is `?#<slug>` and was loaded before
// this ran. A level SETS things on a site already on screen, which is what makes a level cheap to
// switch and what will let a scenario change the weather mid-play later. If the document names a
// different world than the one loaded, that is an error and not a silent reload: reloading would
// throw away the session, and a level pointing at the wrong world is a thing somebody should be
// told about.
//
// The mode (drive/fly/walk) is deliberately NOT applied here. The handoff asks for it as a level
// property that can change mid-level, which means it is a controller swapped over one camera and
// one world, and that belongs with the controllers rather than with the loader.

import { DATA_BASE } from './site'

export interface LevelPlacement {
  asset: string
  at: [number, number] | [number, number, number]
  yaw?: number
}

export interface Level {
  id: string
  world: string
  /**
   * The middle layer of the three-layer look resolve (src/presets.ts): a named entry in the
   * world's presets library, or an inline map of knob values for a one-off.
   *
   * Applied BEFORE `defaults`, because time/weather/season here are the specific overrides a
   * level makes on top of the preset it chose, and after the world's own tuning.json, because
   * "this game is set at dusk in the rain" has to win over "this place usually looks like this".
   */
  preset?: string | Record<string, number>
  defaults?: { time?: string; weather?: string; season?: string }
  splats?: { run?: string; id?: string; at?: number[] }[]
  placements?: LevelPlacement[]
  simulations?: { kind: string; [k: string]: unknown }[]
  /**
   * THE CAR YOU DRIVE, when the level names one.
   *
   * `vehicle` is a catalog id and `profile` is one of the engine's five handling models. The
   * HANDLING NUMBERS ARE NOT HERE, deliberately: mass, wheelbase, gearing and brake bias live on
   * the asset (`AssetItem.vehicle`, schema in `src/vehicles.ts`) because they are facts about the
   * car, and a level that copied them would go stale the moment somebody tuned it. Only `profile`
   * belongs to the level — the same car is a different game in `sim` and in `taxi`.
   *
   * Absent is valid and means the engine's default chassis, which is what every level written
   * before 2026-09-29 gets.
   */
  player?: { vehicle: string; profile?: string } | null
  mode?: 'drive' | 'fly' | 'walk'
  scenario?: unknown
}

/** Where a level comes from: the editor's API in a pod, the data tree on a laptop. */
export async function loadLevel(id: string): Promise<Level | null> {
  const tried: string[] = []
  for (const url of [`${DATA_BASE}/api/levels/${id}`, `${DATA_BASE}/levels/${id}.json`]) {
    try {
      const r = await fetch(url, { cache: 'no-cache' })
      /*
       * A 200 IS NOT AN ANSWER. Any single-page app answers an unknown path with its own
       * index.html and a cheerful 200, so `r.ok` is true, `r.json()` throws on `<!doctype`, and a
       * catch that shrugs turns "this path is not served" into "there is no such level". That is
       * what happened here: /levels/<id>.json came back as the viewer's own HTML and this
       * returned null with nothing anywhere saying why.
       */
      const type = r.headers.get('content-type') ?? ''
      if (!r.ok) { tried.push(`${url} ${r.status}`); continue }
      if (!/json/i.test(type)) { tried.push(`${url} answered ${type || 'nothing'} — that path is not served here`); continue }
      const j = await r.json()
      const lvl = (j.level ?? j) as Level
      if (lvl?.id && lvl?.world) return lvl
      tried.push(`${url} is json but names no world`)
    } catch (e) {
      tried.push(`${url} ${String((e as Error)?.message ?? e).slice(0, 60)}`)
    }
  }
  console.warn(`level "${id}" not found:\n  ${tried.join('\n  ')}`)
  return null
}

export interface LevelHost {
  /** the slug actually on screen */
  world: string
  setTimeLocal: (date: string | undefined, time: string) => void
  setWeather: (w: string) => void
  /** apply the level's preset; returns how many knobs it moved, or null if there is no such preset */
  applyPreset?: (p: string | Record<string, number>) => number | null
  setSeason: (s: string) => void
  /** put assets in: the same call `placements.json` goes through */
  place: (items: LevelPlacement[]) => Promise<number>
  attachSplats: (names: string[]) => Promise<number>
  say: (msg: string) => void
}

/**
 * Apply a level to the site already on screen. Returns what it did, per part.
 *
 * EVERY PART IS INDEPENDENT AND REPORTED. A level whose weather applies, whose assets are missing
 * from the catalog and whose splat run has not finished is a common, ordinary state — the editor
 * should show three different things about it rather than one "failed". So nothing here throws
 * for a part that could not be done; it comes back in the report and the rest still happens.
 */
export async function applyLevel(level: Level, host: LevelHost): Promise<{ ok: boolean; world: string; applied: string[]; skipped: { part: string; why: string }[] }> {
  const applied: string[] = []
  const skipped: { part: string; why: string }[] = []

  if (level.world !== host.world) {
    return {
      ok: false,
      world: host.world,
      applied,
      skipped: [{ part: 'world', why: `this level is for "${level.world}" and "${host.world}" is loaded — open #${level.world} first` }],
    }
  }

  // the preset first: `defaults` below is what this level changes ON TOP of the look it chose
  if (level.preset !== undefined) {
    if (!host.applyPreset) skipped.push({ part: 'preset', why: 'this viewer has no presets library loaded' })
    else {
      const n = host.applyPreset(level.preset)
      if (n === null) skipped.push({ part: 'preset', why: `no preset "${String(level.preset)}" in this world's library` })
      else applied.push(`preset ${typeof level.preset === 'string' ? level.preset : `${n} knobs`}`)
    }
  }

  const d = level.defaults ?? {}
  if (d.time) {
    host.setTimeLocal(undefined, d.time)
    applied.push(`time ${d.time}`)
  }
  if (d.weather) {
    host.setWeather(d.weather)
    applied.push(`weather ${d.weather}`)
  }
  if (d.season) {
    host.setSeason(d.season)
    applied.push(`season ${d.season}`)
  }

  if (level.placements?.length) {
    try {
      const n = await host.place(level.placements)
      applied.push(`${n} of ${level.placements.length} placements`)
      if (n < level.placements.length) skipped.push({ part: 'placements', why: `${level.placements.length - n} asset(s) are not in the catalog` })
    } catch (e) {
      skipped.push({ part: 'placements', why: String((e as Error)?.message ?? e) })
    }
  }

  if (level.splats?.length) {
    const names = level.splats.map((s) => s.id ?? s.run).filter(Boolean) as string[]
    try {
      const n = await host.attachSplats(names)
      applied.push(`${n} of ${names.length} captures`)
      if (n < names.length) skipped.push({ part: 'splats', why: `${names.length - n} capture(s) are not published for this world yet` })
    } catch (e) {
      skipped.push({ part: 'splats', why: String((e as Error)?.message ?? e) })
    }
  }

  // simulations and the scenario are named here and run elsewhere: this reports what a level ASKS
  // for, so a person can see that a level wants traffic before anything can provide it
  for (const s of level.simulations ?? []) skipped.push({ part: `simulation:${s.kind}`, why: 'not running yet — the simulation layer is the next step' })
  if (level.scenario) skipped.push({ part: 'scenario', why: 'not running yet — goals, events and scoring are the step after' })

  host.say(applied.length ? `${level.id}: ${applied.join(', ')}` : `${level.id}: nothing to apply`)
  return { ok: true, world: host.world, applied, skipped }
}
