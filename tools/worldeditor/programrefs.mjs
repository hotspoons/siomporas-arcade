// What a level program can name in one world — the Program pane's "In this world" list, for an agent.
//
// Rich, 2026-10-10: *"The game editor has no sound or placed items (e.g. traffic zones, points)
// listing in the right, nor no assets we can reference from the library in case we want to spawn
// something at a point for a given condition. We need these kinds of livability helpers, and these
// need to be advertised to the MCP tools for the editor as well."*
//
// THE ROWS ARE THE EDITOR'S OWN. `worldThings` (apps/corridor/src/game/world/worldthings.ts) turns
// a world's documents into ids, descriptions and snippets, and it is imported from the app's source
// here — Node runs it with its types stripped — rather than copied. A copy of the snippets would be
// a second answer to "what does a zone row insert" and the two would part company the first time
// one of them was fixed. What this file adds is only the GATHERING: the service reads the site
// documents from its volume, the bank from the repo, and the library and the builds from the asset
// service, where the page fetches the same things over HTTP.
//
// THE LIBRARY RULE IS THE VIEWER'S. `loadSpawnCatalog` (assets/catalogmerge.ts) decides what
// `api.models.spawn` can find: the kit, every library asset with a model, every build that wears
// one. `spawnables` below is that rule over the service's own routes; programrefs.test.mjs holds the
// two to the same answer on the same literals.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { soundSlots } from './vocab.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '../../apps/corridor/src')

/*
 * LOADED WHEN ASKED, not at the top. A pod missing the app's source (an image built before the
 * Dockerfile copied it) should lose this one tool with a message that says why, not the whole MCP
 * server at import time.
 */
let shared = null
async function app() {
  shared ??= Promise.all([
    import(pathToFileURL(path.join(APP, 'game/world/worldthings.ts')).href),
    import(pathToFileURL(path.join(APP, 'assets/classes.ts')).href),
  ]).then(([things, classes]) => ({ ...things, typeOf: classes.typeOf }))
  return shared
}

/** The document, or null — a world nobody has painted has no zones.json, and that is the normal case. */
async function doc(siteDoc, slug, name) {
  try {
    return await siteDoc.read(slug, name)
  } catch {
    return null
  }
}

/** A service answer, or a fallback: no asset service is a normal state, and the list is still the world's. */
async function maybe(fn, fallback) {
  try {
    return (await fn()) ?? fallback
  } catch {
    return fallback
  }
}

/**
 * What `api.models.spawn` can find, over the service's routes — the rule `loadSpawnCatalog` applies
 * in the browser: the kit's entries that have a model, the library's items that have a mesh
 * (whatever they are), and the vehicle, actor and weapon builds that wear one of those.
 */
export function spawnables({ kit, items, builds }, typeOf) {
  const byId = new Map()
  for (const e of kit ?? []) if (e?.id && e.glb) byId.set(e.id, { id: e.id, name: e.name ?? e.id, category: e.category, type: 'prop' })
  for (const it of items ?? []) {
    if (!it?.id || !(it.finished || it.mesh)) continue
    const type = typeOf(it)
    byId.set(it.id, { id: it.id, name: it.subject || it.id, category: it.kind || type, type })
  }
  const out = [...byId.values()]
  for (const { kind, build } of builds ?? []) {
    const wears = build?.asset ? byId.get(build.asset) : null
    if (!wears || !build.id || byId.has(build.id)) continue
    out.push({ ...wears, id: build.id, name: build.name || build.id, type: kind, wears: wears.id })
  }
  return out
}

const KINDS = ['traffic', 'point', 'placement', 'stunt', 'race', 'build', 'sound', 'library']

/**
 * The answer to `program_refs`: the groups, in the editor's order, each with its rows.
 *
 * `get` is the service calling itself (mcptools.mjs `apiFetch`), `siteDoc` reads a site document
 * off the volume. Both injected, so a test hands in literals.
 */
export async function programRefs({ get, siteDoc }, a) {
  const slug = String(a?.slug ?? '')
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) throw new Error('slug is a world slug — world_list has them')
  const { worldThings, levelBuilds, KIND_ORDER, KIND_LABEL, KIND_ABOUT, thingMatches, typeOf } = await app()
  const want = Array.isArray(a.kinds) && a.kinds.length ? new Set(a.kinds) : null
  for (const k of want ?? []) if (!KINDS.includes(k)) throw new Error(`kind ${JSON.stringify(k)} is not one of ${KINDS.join(', ')}`)

  const [placements, zones, stunts, courses, points, bank, kit, items, levels, ...colls] = await Promise.all([
    doc(siteDoc, slug, 'placements.json'),
    doc(siteDoc, slug, 'zones.json'),
    doc(siteDoc, slug, 'stunts.json'),
    doc(siteDoc, slug, 'courses.json'),
    doc(siteDoc, slug, 'points.json'),
    soundSlots(),
    maybe(async () => (await get('/api/catalog'))?.assets, []),
    maybe(async () => (await get('/assetsvc/catalog'))?.items, []),
    maybe(async () => (await get('/api/levels'))?.levels, []),
    ...['vehicles', 'actors', 'weapons'].map((c) => maybe(async () => (await get(`/assetsvc/${c}`))?.[c], [])),
  ])
  const builds = [['vehicle', colls[0]], ['actor', colls[1]], ['weapon', colls[2]]].flatMap(([kind, list]) => (list ?? []).map((build) => ({ kind, build })))

  const things = worldThings({
    placements, zones, stunts, courses, points,
    sounds: bank.map((s) => ({ slot: s.slot, desc: s.desc, loop: s.loop, clips: s.clips.length })),
    library: spawnables({ kit, items, builds }, typeOf),
    builds: levelBuilds(levels, slug, builds),
  })
  const limit = Math.max(1, Math.min(1000, Number(a.limit) || 100))
  const groups = []
  for (const kind of KIND_ORDER) {
    if (want && !want.has(kind)) continue
    const all = things.filter((t) => t.kind === kind)
    const hit = all.filter((t) => thingMatches(t, a.q ?? ''))
    if (!all.length) continue
    groups.push({
      kind,
      title: KIND_LABEL[kind],
      about: KIND_ABOUT[kind],
      count: all.length,
      ...(hit.length !== all.length ? { matched: hit.length } : {}),
      ...(hit.length > limit ? { shown: limit } : {}),
      refs: hit.slice(0, limit).map((t) => ({ id: t.id, what: t.what, desc: t.desc, detail: t.detail, snippet: t.insert })),
    })
  }
  return {
    world: slug,
    groups,
    note: "Every snippet typechecks inside `setup(api) { … }` of a defineGame program. A world zone id or point id works as a zone name in api.on('enters' | 'leaves', id, …) and api.in(id) without declaring it. program_api has the declarations; program_check checks a file.",
  }
}
