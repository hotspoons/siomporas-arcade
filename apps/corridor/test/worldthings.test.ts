// Does the list beside the code show everything the world has — and what a program brings to it?
//
// Rich, 2026-09-29: *"Nothing shows up in the programming world listing except a set of apartments,
// no traffic zones, no stunts, nothing."* It listed placements and nothing else. The point of the
// list is that you do not have to open a JSON file to find out what a program may be given, so a
// list that covers one layer of four is worse than none — it tells you the others are empty.
//
// Rich, 2026-10-10: *"The game editor has no sound or placed items (e.g. traffic zones, points)
// listing in the right, nor no assets we can reference from the library in case we want to spawn
// something at a point for a given condition."* So: points, sounds, the level's builds and the
// spawnable library too, each row with code that uses it. Whether that code COMPILES is held in
// tools/worldeditor/programrefs.test.mjs, against the declaration bundle the editor checks with.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { countByKind, identOf, KIND_ORDER, levelBuilds, thingMatches, worldThings, type WorldDocs } from '../src/game/world/worldthings'
import { POINT_RADIUS_M } from '../src/game/session/program'

const docs: WorldDocs = {
  placements: { items: [{ id: 'p-01', asset: 'apartments-02', tags: ['apartments'] }] },
  zones: { version: 1 as const, zones: [{ id: 'z-01', name: 'Main street', kind: 'traffic' as const, polygon: [[0, 0], [1, 0], [1, 1]] as [number, number][], traffic: { density: 0.6 } }] },
  stunts: { version: 1 as const, fixtures: [{ id: 'sx-01', name: 'The loop', piece: 'loop', at: [0, 0] as [number, number], yaw_deg: 0 }] },
  courses: { version: 1 as const, courses: [{ id: 'r-01', name: 'The stage', kind: 'stage' as const, gates: [] }] },
  points: { version: 1, home: 'start', points: [
    { id: 'start', name: 'Start', kind: 'start', at: [0, 0], yaw_deg: 0 },
    { id: 'p-03', name: 'The yard', kind: 'spot', at: [100, 50], yaw_deg: 90 },
  ] },
  sounds: [{ slot: 'crash.heavy', desc: 'a wreck', clips: 3 }, { slot: 'tire.squeal.loop', desc: 'the tyres letting go', loop: true, clips: 1 }],
  library: [{ id: 'watertower-01', name: 'Water tower', category: 'utility', type: 'prop' }],
  builds: [{ id: 'rx7', name: 'The RX-7', kind: 'vehicle', asset: 'fc-rx-7', usedBy: ['beltway (player)'], sounds: { 'crash.heavy': ['slot:crash.medium'] } }],
}

describe('what a program can name in this world', () => {
  it('lists every layer and everything a program brings to it', () => {
    expect(countByKind(worldThings(docs))).toEqual({ traffic: 1, point: 2, placement: 1, stunt: 1, race: 1, build: 1, sound: 2, library: 1 })
    // in the order the groups are drawn
    const kinds = worldThings(docs).map((t) => t.kind)
    expect(kinds).toEqual([...kinds].sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b)))
  })

  /*
   * AND EACH ROW INSERTS THE CODE THAT USES IT. Eight kinds have eight verbs; a row that pasted
   * `api.placed('z-01')` for a traffic zone would type-check against nothing and do nothing.
   */
  it('gives each one the call that actually takes it', () => {
    const by = Object.fromEntries(worldThings(docs).map((t) => [`${t.kind}:${t.id}`, t.insert]))
    expect(by['traffic:z-01']).toMatch(/^api\.on\('enters', 'z-01', \(\) => \{\n[^]*api\.traffic\.set\('z-01', 1, \{ over: 4 \}\)\n\}\)$/)
    expect(by['point:p-03']).toMatch(/^api\.on\('enters', 'p-03', \(\) => \{/)
    expect(by['placement:p-01']).toBe("const p01 = api.placed('p-01') // apartments-02: an entity, or null")
    expect(by['stunt:sx-01']).toBe("api.stunts.show('sx-01', true)")
    expect(by['race:r-01']).toBe("api.races.start('r-01')")
    expect(by['sound:crash.heavy']).toBe("api.audio.play('crash.heavy') // a wreck")
    expect(by['sound:tire.squeal.loop']).toBe("api.audio.loop('tire.squeal.loop').set(1) // the tyres letting go")
  })

  /*
   * THE SENTENCE RICH ASKED FOR, as a Library row inserts it: when the player enters this world's
   * zone, spawn the asset at this world's point — a spot, not the start the player is standing on —
   * and take it away again. Real ids, so it runs as inserted.
   */
  it('makes a library row spawn at a real point on a real condition', () => {
    const lib = worldThings(docs).find((t) => t.kind === 'library')!
    expect(lib.insert).toContain("api.on('enters', 'z-01', () => {")
    expect(lib.insert).toContain("const at = api.point('p-03') ?? api.player()")
    expect(lib.insert).toContain("api.models.spawn('watertower-01', at)")
    expect(lib.insert).toContain('api.models.remove(id)')
    // with no zone and no point it still runs: a timer and the player
    const bare = worldThings({ library: docs.library }).find((t) => t.kind === 'library')!
    expect(bare.insert).toContain('api.after(5, () => {')
    expect(bare.insert).toContain('const at = api.player()')
  })

  it('says what each one is, beside its id, and everything about it on hover', () => {
    const things = worldThings(docs)
    expect(things.find((t) => t.id === 'sx-01')?.what).toBe('loop')
    expect(things.find((t) => t.id === 'z-01')?.tags).toContain('60% busy')
    expect(things.find((t) => t.id === 'start')?.desc).toBe('Start · start · home')
    // the point's hover states the ring the runtime actually uses
    expect(things.find((t) => t.id === 'p-03')?.detail).toContain(`within ${POINT_RADIUS_M} m`)
    // a sound a level's car overrides says which car
    expect(things.find((t) => t.id === 'crash.heavy')?.desc).toBe('a wreck · overridden by rx7')
  })

  it('searches every word across id, tags and description', () => {
    const things = worldThings(docs)
    expect(things.filter((t) => thingMatches(t, 'main street')).map((t) => t.id)).toEqual(['z-01'])
    expect(things.filter((t) => thingMatches(t, 'CRASH')).map((t) => t.id)).toEqual(['crash.heavy'])
    expect(things.every((t) => thingMatches(t, '  '))).toBe(true)
  })

  it('quotes an id that would end the string, and names variables JavaScript accepts', () => {
    const odd = worldThings({ stunts: { version: 1, fixtures: [{ id: "it's", name: '', piece: 'loop', at: [0, 0], yaw_deg: 0 }] } })
    expect(odd[0].insert).toBe("api.stunts.show('it\\'s', true)")
    expect(identOf('p-07')).toBe('p07')
    expect(identOf('water-tower-01')).toBe('waterTower01')
    expect(identOf('07-yard')).toBe('_07Yard')
  })

  it('knows which builds a world\'s levels name, and only that world\'s', () => {
    const levels = [{ id: 'beltway', world: 'dc', player: { vehicle: 'rx7' } }, { id: 'other', world: 'crofton', player: { vehicle: 'van' } }, { id: 'walk', world: 'dc' }]
    const builds = [{ kind: 'vehicle' as const, build: { id: 'rx7', name: 'RX-7', asset: 'fc-rx-7', doc: { sounds: { 'crash.heavy': [] } } } }, { kind: 'vehicle' as const, build: { id: 'van', name: 'Van', asset: null } }]
    expect(levelBuilds(levels, 'dc', builds)).toEqual([{ id: 'rx7', name: 'RX-7', kind: 'vehicle', asset: 'fc-rx-7', usedBy: ['beltway (player)'], sounds: { 'crash.heavy': [] } }])
    expect(levelBuilds(levels, 'nowhere', builds)).toEqual([])
  })

  /*
   * A MISSING FILE IS THE NORMAL CASE. Most worlds have no stunts and no races, and the editor
   * fetches documents of which most routinely 404. An empty list for those is right; an exception
   * would take the whole list down and show nothing at all — which is the reported bug.
   */
  it('is empty rather than broken when a world has none of something', () => {
    expect(worldThings({})).toEqual([])
    expect(worldThings({ zones: null, stunts: undefined, courses: null, points: null, sounds: null, library: null, builds: null })).toEqual([])
    expect(worldThings({ placements: { items: undefined } })).toEqual([])
  })
})

/*
 * WHAT THE LIST OFFERS IS WHAT A SPAWN FINDS. The viewer resolves `api.models.spawn` through
 * `loadSpawnCatalog` (catalogmerge.ts); the MCP server lists through `spawnables`
 * (tools/worldeditor/programrefs.mjs), over its own routes. Same literals in, same ids out — or an
 * agent is told it can spawn something the game cannot find.
 */
describe('the spawn catalog and the MCP library agree', () => {
  beforeAll(() => { vi.stubGlobal('location', { search: '', origin: 'http://localhost', hostname: 'localhost' }) })
  afterAll(() => { vi.unstubAllGlobals() })

  it('lists the same ids from the same kit, library and builds', async () => {
    const { shippedEntries, libraryEntries, mergeCatalog, buildEntries } = await import('../src/assets/catalogmerge')
    const { typeOf } = await import('../src/assets/classes')
    // @ts-expect-error -- a plain .mjs with no declarations; the test only needs it to run
    const { spawnables } = await import('../../../tools/worldeditor/programrefs.mjs')
    const kit = [{ id: 'barn-01', name: 'Barn', category: 'barn', glb: 'assets/barn-01.glb', footprint_m: [30, 14] as [number, number], height_m: 11 }, { id: 'ghost', name: 'No model', category: 'x', footprint_m: [1, 1] as [number, number], height_m: 1 }]
    const items = [
      { id: 'fc-rx-7', subject: 'RX-7', kind: 'hero-car', finished: 2, mesh: 1 },
      { id: 'cone', subject: 'Cone', kind: 'prop', mesh: 1, finished: null },
      { id: 'drawn', subject: 'Drawn', kind: 'prop', mesh: null, finished: null },
      { id: 'walker', subject: 'Walker', kind: 'pedestrian', mesh: 3, finished: null },
    ]
    const builds = [
      { kind: 'vehicle' as const, build: { id: 'beltway-nightmare', name: 'Beltway Nightmare', asset: 'fc-rx-7' } },
      { kind: 'vehicle' as const, build: { id: 'numbers', name: 'Numbers', asset: null } },
    ]
    const models = mergeCatalog(shippedEntries({ assets: kit }), libraryEntries(items as never, ['prop', 'fixture', 'vehicle', 'actor', 'weapon']))
    const byId = new Map(models.map((e) => [e.id, e]))
    const viewer = [...models, ...buildEntries(byId, builds).filter((b) => !byId.has(b.id))].map((e) => e.id).sort()
    const mcp = (spawnables({ kit, items, builds }, typeOf) as { id: string }[]).map((e) => e.id).sort()
    expect(viewer).toEqual(['barn-01', 'beltway-nightmare', 'cone', 'fc-rx-7', 'walker'])
    expect(mcp).toEqual(viewer)
  })
})
