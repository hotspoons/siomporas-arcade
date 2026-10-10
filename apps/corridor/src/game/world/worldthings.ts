// Everything a world has that a program can name, in one list.
//
// Rich, 2026-09-29: *"Nothing shows up in the programming world listing except a set of apartments,
// no traffic zones, no stunts, nothing. Let's keep going and get these cleared so we can create an
// actual game!"*
//
// Rich, 2026-10-10: *"The game editor has no sound or placed items (e.g. traffic zones, points)
// listing in the right, nor no assets we can reference from the library in case we want to spawn
// something at a point for a given condition. We need these kinds of livability helpers, and these
// need to be advertised to the MCP tools for the editor as well."*
//
// The list beside the code existed to save you opening a JSON file to find out what
// `api.placed('…')` may be given — and it read `placements.json` and nothing else, so the moment
// there were four layers it was answering a quarter of the question. Then there were points, a
// sound bank and a library a program can spawn from, and it was answering half of it again. This is
// the whole answer: every id a program may say, grouped by what it is, each with a line about it
// and the code that uses it.
//
// WHY IT IS A PURE FUNCTION OVER DOCUMENTS. The editor fetches the files; a test hands it literals;
// and the world editor's MCP server (tools/worldeditor/mcptools.mjs, `program_refs`) imports THIS
// FILE — Node runs it with its types stripped — so an agent writing a level is offered the same
// rows and the same snippets a person clicks. That is why there is not one runtime import in here:
// Node resolves none of the app's extension-less paths, and a second copy of the snippets in the
// service would be a second answer to "what does a zone row insert", drifting from the first.
//
// AND EACH ROW CARRIES ITS OWN CODE. A traffic zone is a trigger and a density, a point is a place
// to arrive at, a placement is an entity, a sound is a slot, a library asset is something to spawn.
// Making every row insert `api.placed(id)`, or making the person remember which verb is which, is how
// you get a program that silently refers to nothing. Every snippet here is held against the real
// declarations by test/worldthings.test.ts — it must typecheck inside `setup(api) { … }`.

import type { CourseDoc } from '../race/races'
import type { StuntDoc } from '../stunt/stunts'
import type { ZoneDoc } from './zones'
import type { PointsDoc } from './points'

export type WorldThingKind = 'traffic' | 'point' | 'placement' | 'stunt' | 'race' | 'build' | 'sound' | 'library'

/** The order the groups are drawn in: the world's own layers, then what a program brings to it. */
export const KIND_ORDER: WorldThingKind[] = ['traffic', 'point', 'placement', 'stunt', 'race', 'build', 'sound', 'library']

export const KIND_LABEL: Record<WorldThingKind, string> = {
  traffic: 'Traffic zones',
  point: 'Points',
  placement: 'Placed',
  stunt: 'Stunt fixtures',
  race: 'Races',
  build: 'Level vehicles & actors',
  sound: 'Sounds',
  library: 'Library',
}

/** One line per group, for a heading's hover and for an agent reading the MCP answer. */
export const KIND_ABOUT: Record<WorldThingKind, string> = {
  traffic: "painted traffic zones (zones.json): an id is a trigger — on('enters', id) — and a density, api.traffic.set(id, …)",
  point: "named places (points.json): api.point(id) is where, in site metres; on('enters', id) is arriving there",
  placement: 'what the Place editor put down (placements.json): api.placed(id) is its entity, api.placedWith(tag) all with a tag',
  stunt: 'stunt fixtures (stunts.json): api.stunts.show(id, on), api.stunts.where(id)',
  race: 'race courses (courses.json): api.races.start(id), api.races.state()',
  build: "the vehicle, actor and weapon builds this world's levels name; api.models.spawn(id, pose) puts one down as scenery",
  sound: 'the sound bank (public/sounds/bank.json): api.audio.play(slot), api.audio.loop(slot), api.audio.override(slot, clips)',
  library: 'what api.models.spawn(id, pose) can put in the world: the kit, every library asset with a model, every build',
}

export interface WorldThing {
  id: string
  kind: WorldThingKind
  /** what it is, in a word or two: an asset id, a zone kind, a point kind, a slot's shape */
  what: string
  tags: string[]
  /** one line about it — the row's note */
  desc: string
  /** everything known about it, for a hover */
  detail: string
  /** the code clicking (or dragging) it inserts, already written for this id */
  insert: string
}

/** The placements file, as much of it as this needs. */
export interface PlacementDoc {
  items?: { id: string; asset: string; tags?: string[] }[]
}

/** One bank slot: `slots()` on the audio API answers the same shape. */
export interface SoundSlotInfo {
  slot: string
  desc: string
  loop?: boolean
  /** how many clips the bank has for it */
  clips?: number
}

/** Something a program can spawn — a row of the spawn catalog (assets/catalogmerge.ts `loadSpawnCatalog`). */
export interface Spawnable {
  id: string
  name: string
  category?: string
  /** prop, vehicle, actor, weapon, fixture */
  type?: string
  /** a build: the catalog model it wears */
  wears?: string
}

/** A vehicle, actor or weapon build a level of this world names, and what it overrides. */
export interface LevelBuild {
  id: string
  name: string
  kind: 'vehicle' | 'actor' | 'weapon'
  /** the catalog model it wears; null while it has none (and so cannot be spawned) */
  asset?: string | null
  /** the levels that name it, and as what — "beltway (player)" */
  usedBy?: string[]
  /** the sound slots its document overrides */
  sounds?: Record<string, unknown> | null
}

export interface WorldDocs {
  placements?: PlacementDoc | null
  zones?: ZoneDoc | null
  stunts?: StuntDoc | null
  courses?: CourseDoc | null
  points?: PointsDoc | null
  sounds?: SoundSlotInfo[] | null
  library?: Spawnable[] | null
  builds?: LevelBuild[] | null
}

/** A string literal for a snippet. Ids are tame, but a quote in one must not end the string early. */
const q = (s: string): string => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

/** A comment line that cannot close itself or run onto the next one. */
const say = (s: string): string => String(s).replace(/\s+/g, ' ').replace(/\*\//g, '* /').trim()

/** A JavaScript name from an id: `p-07` → `p07`, `water-tower-01` → `waterTower01`. */
export function identOf(id: string): string {
  const parts = String(id).split(/[^A-Za-z0-9]+/).filter(Boolean)
  const name = parts.map((p, i) => (i ? p[0].toUpperCase() + p.slice(1) : p.toLowerCase())).join('')
  return /^[A-Za-z_]/.test(name) ? name : `_${name || 'thing'}`
}

/**
 * Where a spawn snippet goes and what sets it off, from what this world actually has.
 *
 * A REAL ID, NOT A PLACEHOLDER. The snippet a Library row inserts names this world's first painted
 * zone and its first point, so it runs as inserted; with neither it falls back to a timer and the
 * player, which runs anywhere. A placeholder like `'your-zone'` typechecks and does nothing, which
 * is the one failure this list exists to prevent.
 */
interface SnippetCtx {
  zone: string | null
  point: string | null
}

function contextOf(docs: WorldDocs): SnippetCtx {
  const zone = docs.zones?.zones?.find((z) => z?.id)?.id ?? null
  const pts = (docs.points?.points ?? []).filter((p) => p?.id)
  // a spot, a checkpoint or a finish is somewhere to put something; the start is where you already are
  const point = (pts.find((p) => p.kind === 'spot' || p.kind === 'checkpoint' || p.kind === 'finish') ?? pts[0])?.id ?? null
  return { zone, point }
}

/** "when the player enters z-01, put <asset> at <point>, and take it away after a minute" */
function spawnSnippet(asset: string, label: string, c: SnippetCtx): string {
  const when = c.zone ? `api.on('enters', ${q(c.zone)}, () => {` : 'api.after(5, () => {'
  const where = c.point ? `api.point(${q(c.point)}) ?? api.player()` : 'api.player()'
  const why = `${c.zone ? `when the player enters ${c.zone}` : 'five seconds in'}, put ${say(label)} ${c.point ? `at ${c.point}` : 'where the player is'}`
  return [
    `// ${why}; gone again after a minute`,
    when,
    `  const at = ${where}`,
    `  const id = at ? api.models.spawn(${q(asset)}, at) : null`,
    '  if (id) api.after(60, () => api.models.remove(id))',
    '})',
  ].join('\n')
}

/**
 * The lot, in the order they are drawn.
 *
 * MISSING IS EMPTY, not an error. Most worlds have no stunts and no races; a site that has never
 * been painted has no `zones.json` at all, and a list that throws for the normal case is a list
 * nobody sees.
 */
export function worldThings(docs: WorldDocs): WorldThing[] {
  const out: WorldThing[] = []
  const c = contextOf(docs)

  for (const z of docs.zones?.zones ?? []) {
    if (!z?.id) continue
    const density = z.traffic?.density
    const busy = density === undefined ? null : `${Math.round(density * 100)}% busy`
    const tags = [z.name, busy].filter(Boolean) as string[]
    const name = z.name || z.id
    out.push({
      id: z.id,
      kind: 'traffic',
      what: z.kind ?? 'zone',
      tags,
      desc: `${name}${busy ? ` · ${busy}` : ''}`,
      detail: `Traffic zone ${z.id} "${name}"${busy ? `, ${busy}` : ''}${z.traffic?.densityMax !== undefined ? ` to ${Math.round(z.traffic.densityMax * 100)}%` : ''}, an outline of ${z.polygon?.length ?? 0} points. As a trigger: api.on('enters' | 'leaves', '${z.id}', …) and api.in('${z.id}'). As traffic: api.traffic.set('${z.id}', 0…1, { over }) and api.traffic.density('${z.id}').`,
      // the zone as a trigger, and the useful thing to do to its traffic when it fires
      insert: [`api.on('enters', ${q(z.id)}, () => {`, `  // ${say(name)} — jam it while the player is in it`, `  api.traffic.set(${q(z.id)}, 1, { over: 4 })`, '})'].join('\n'),
    })
  }

  for (const p of docs.points?.points ?? []) {
    if (!p?.id) continue
    const name = p.name || p.id
    const home = docs.points?.home === p.id
    const tags = [p.kind, p.mode, home ? 'home' : null].filter(Boolean) as string[]
    const at = Array.isArray(p.at) ? `${Math.round(p.at[0])}, ${Math.round(p.at[1])}` : '?'
    out.push({
      id: p.id,
      kind: 'point',
      what: p.kind ?? 'point',
      tags,
      desc: `${name} · ${p.kind}${home ? ' · home' : ''}`,
      detail: `Point ${p.id} "${name}", a ${p.kind}${p.mode ? ` (${p.mode})` : ''} at ${at} site metres, heading ${Math.round(p.yaw_deg ?? 0)}°${p.note ? `. Note: ${p.note}` : ''}. api.point('${p.id}') answers { x, y, z, yaw_deg } — a pose api.models.spawn takes as it is. api.on('enters', '${p.id}', …) fires within 15 m of it.`,
      insert: [`api.on('enters', ${q(p.id)}, () => {`, `  // arrived at ${say(name)}; api.point(${q(p.id)}) is where it is`, `  api.say(${q(name)})`, '})'].join('\n'),
    })
  }

  for (const p of docs.placements?.items ?? []) {
    if (!p?.id) continue
    const tags = p.tags ?? []
    out.push({
      id: p.id,
      kind: 'placement',
      what: p.asset ?? 'placement',
      tags,
      desc: `${p.asset ?? 'placement'}${tags.length ? ` · ${tags.join(' ')}` : ''}`,
      detail: `Placed ${p.asset} as ${p.id}${tags.length ? `, tagged ${tags.join(', ')}` : ''}. api.placed('${p.id}') is its ECS entity (write Transform to move it); ${tags.length ? `api.placedWith('${tags[0]}') is every placement tagged ${tags[0]}` : 'api.placedWith(tag) finds placements by tag'}.`,
      insert: `const ${identOf(p.id)} = api.placed(${q(p.id)}) // ${say(p.asset ?? '')}: an entity, or null`,
    })
  }

  for (const f of docs.stunts?.fixtures ?? []) {
    if (!f?.id) continue
    out.push({
      id: f.id,
      kind: 'stunt',
      what: f.piece ?? 'fixture',
      tags: f.name ? [f.name] : [],
      desc: `${f.piece ?? 'fixture'}${f.name ? ` · ${f.name}` : ''}`,
      detail: `Stunt fixture ${f.id}${f.name ? ` "${f.name}"` : ''}, a ${f.piece}. api.stunts.show('${f.id}', true | false), api.stunts.visible('${f.id}'), api.stunts.where('${f.id}').`,
      insert: `api.stunts.show(${q(f.id)}, true)`,
    })
  }

  for (const r of docs.courses?.courses ?? []) {
    if (!r?.id) continue
    const gates = `${r.gates?.length ?? 0} gates`
    out.push({
      id: r.id,
      kind: 'race',
      what: r.kind ?? 'race',
      tags: [r.name, gates].filter(Boolean) as string[],
      desc: `${r.name || r.kind} · ${r.kind} · ${gates}`,
      detail: `Race ${r.id} "${r.name}", a ${r.kind}${r.kind === 'circuit' ? ` of ${r.laps ?? 1} laps` : ''} with ${gates}. api.races.start('${r.id}'); api.races.state() is how it is going.`,
      insert: `api.races.start(${q(r.id)})`,
    })
  }

  for (const b of docs.builds ?? []) {
    if (!b?.id) continue
    const slots = Object.keys(b.sounds ?? {})
    const used = b.usedBy ?? []
    out.push({
      id: b.id,
      kind: 'build',
      what: b.kind,
      tags: [b.kind, ...used],
      desc: `${b.name || b.id} · ${b.kind}${used.length ? ` · ${used.join(', ')}` : ''}`,
      detail: `${b.kind} build ${b.id} "${b.name}"${b.asset ? `, wearing ${b.asset}` : ', with no model yet'}${used.length ? `; named by ${used.join(', ')}` : ''}${slots.length ? `; overrides the sounds ${slots.join(', ')}` : ''}. api.models.spawn('${b.id}', pose) puts its model down as scenery — not a car anybody drives.`,
      insert: b.asset ? spawnSnippet(b.id, b.name || b.id, c) : `// ${say(b.id)} has no model yet, so there is nothing to spawn`,
    })
  }

  /*
   * THE SOUNDS, with who overrides each. A level's car may carry its own `crash.heavy`; the row
   * says so, because "why does my bang sound like that" is answered by which document won.
   */
  const overriddenBy = new Map<string, string[]>()
  for (const b of docs.builds ?? []) for (const slot of Object.keys(b?.sounds ?? {})) overriddenBy.set(slot, [...(overriddenBy.get(slot) ?? []), b.id])
  for (const s of docs.sounds ?? []) {
    if (!s?.slot) continue
    const by = overriddenBy.get(s.slot) ?? []
    const shape = s.loop ? 'loop' : 'one-shot'
    out.push({
      id: s.slot,
      kind: 'sound',
      what: shape,
      tags: [shape, ...by.map((id) => `overridden by ${id}`)],
      desc: `${s.desc}${by.length ? ` · overridden by ${by.join(', ')}` : ''}`,
      detail: `Sound slot ${s.slot}: ${s.desc}. A ${shape}${s.clips !== undefined ? ` with ${s.clips} clip${s.clips === 1 ? '' : 's'} in the bank` : ''}${by.length ? `; ${by.join(', ')} carr${by.length === 1 ? 'ies' : 'y'} ${by.length === 1 ? 'its' : 'their'} own` : ''}. ${s.loop ? `api.audio.loop('${s.slot}') is a handle: set(0…1) fades it, stop() ends it.` : `api.audio.play('${s.slot}', { at }) plays it at a place in site metres; with no at, at the player.`} api.audio.override('${s.slot}', clips) swaps it for the whole level.`,
      insert: s.loop ? `api.audio.loop(${q(s.slot)}).set(1) // ${say(s.desc)}` : `api.audio.play(${q(s.slot)}) // ${say(s.desc)}`,
    })
  }

  for (const a of docs.library ?? []) {
    if (!a?.id) continue
    const what = a.type ?? a.category ?? 'asset'
    out.push({
      id: a.id,
      kind: 'library',
      what,
      tags: [a.category, a.type, a.wears ? `wears ${a.wears}` : null].filter((t, i, all): t is string => !!t && all.indexOf(t) === i),
      desc: `${a.name || a.id} · ${a.wears ? `${a.type} build` : (a.category ?? what)}`,
      detail: `${a.name || a.id} (${a.id}), ${a.wears ? `a ${a.type} build wearing ${a.wears}` : `${a.type ?? 'an asset'}${a.category ? `, filed as ${a.category}` : ''}`}. api.models.spawn('${a.id}', { x, y, z?, yaw_deg?, scale? }) puts one in the world and answers its id; api.models.move / show / remove take that id.`,
      insert: spawnSnippet(a.id, a.name || a.id, c),
    })
  }

  return out
}

/**
 * The builds this world's levels name, and as what: the player's car today. A level names a
 * vehicle build in `player.vehicle`; that is the car whose sounds a crash in that level makes, so
 * its overrides are what the Sounds group marks.
 *
 * `builds` is every build the asset service has, with which collection it came from.
 */
export function levelBuilds(
  levels: { id: string; world: string; player?: { vehicle?: string } | null }[] | null | undefined,
  world: string,
  builds: { kind: LevelBuild['kind']; build: { id: string; name?: string; asset?: string | null; doc?: unknown } }[] | null | undefined,
): LevelBuild[] {
  const named = new Map<string, string[]>()
  for (const l of levels ?? []) {
    if (l?.world !== world) continue
    const v = l.player?.vehicle
    if (v) named.set(v, [...(named.get(v) ?? []), `${l.id} (player)`])
  }
  const out: LevelBuild[] = []
  for (const [id, usedBy] of named) {
    const hit = (builds ?? []).find((b) => b.build?.id === id)
    if (!hit) continue
    const b = hit.build
    const sounds = (b.doc as { sounds?: Record<string, unknown> } | null | undefined)?.sounds ?? null
    out.push({ id: b.id, name: b.name ?? b.id, kind: hit.kind, asset: b.asset ?? null, usedBy, sounds })
  }
  return out
}

/** How many of each — for a heading, and for a program that wants to know what it is dealing with. */
export function countByKind(things: WorldThing[]): Record<WorldThingKind, number> {
  const out = Object.fromEntries(KIND_ORDER.map((k) => [k, 0])) as Record<WorldThingKind, number>
  for (const t of things) out[t.kind]++
  return out
}

/**
 * Does a row answer a search? Every word somewhere in its id, what it is, its tags or its line —
 * so "crash" finds the crash slots and "jam largo" finds the zone named that.
 */
export function thingMatches(t: WorldThing, query: string): boolean {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = `${t.id} ${t.what} ${t.tags.join(' ')} ${t.desc}`.toLowerCase()
  return words.every((w) => hay.includes(w))
}
