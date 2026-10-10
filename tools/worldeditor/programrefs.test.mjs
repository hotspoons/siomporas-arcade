// `program_refs`: what a level program can name in a world, for an agent — and does the code it
// hands out actually compile?
//
// The second question is the one that matters. A snippet that typechecks against nothing is the
// failure this whole list exists to prevent, so every snippet built from these literals is put in a
// program and checked against the SAME declaration bundle the editor and `program_check` use — and a
// deliberately wrong one is checked too, so a check that passes everything cannot pass this file.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { check } from './programs.mjs'
import { programRefs, spawnables } from './programrefs.mjs'
import { serverTools } from './mcptools.mjs'

const SITE = {
  'w/zones.json': { version: 1, zones: [{ id: 'z-01', name: "beltway jam: Largo", kind: 'traffic', polygon: [[0, 0], [10, 0], [10, 10]], traffic: { density: 0.6 } }] },
  'w/points.json': { version: 1, home: 'start', points: [
    { id: 'start', name: 'Start', kind: 'start', at: [0, 0], yaw_deg: 0 },
    { id: 'p-03', name: "Grump's yard", kind: 'spot', at: [100, 50], yaw_deg: 90, note: 'it\'s here' },
  ] },
  'w/placements.json': { items: [{ id: 'p-07', asset: 'watertower-01', tags: ['utility'] }] },
  'w/stunts.json': { version: 1, fixtures: [{ id: 'sx-01', name: 'The loop', piece: 'loop', at: [0, 0], yaw_deg: 0 }] },
  'w/courses.json': { version: 1, courses: [{ id: 'r-01', name: 'The stage', kind: 'stage', gates: [] }] },
}

const SERVICE = {
  '/api/catalog': { assets: [{ id: 'watertower-01', name: 'Water tower', category: 'utility', glb: 'assets/watertower-01.glb' }, { id: 'ghost', name: 'No model', category: 'x' }] },
  '/assetsvc/catalog': { items: [
    { id: 'fc-rx-7', subject: 'Mazda RX-7', kind: 'hero-car', finished: 2 },
    { id: 'cone', subject: 'Traffic cone', kind: 'prop', mesh: 1 },
    { id: 'drawn-only', subject: 'Not meshed', kind: 'prop', mesh: null, finished: null },
  ] },
  '/assetsvc/vehicles': { vehicles: [
    { id: 'beltway-nightmare', name: 'Beltway Nightmare', asset: 'fc-rx-7', doc: { sounds: { 'crash.heavy': ['slot:crash.medium'] } } },
    { id: 'no-model-yet', name: 'Numbers only', asset: null, doc: {} },
  ] },
  '/assetsvc/actors': { actors: [] },
  '/assetsvc/weapons': { weapons: [] },
  '/api/levels': { levels: [{ id: 'beltway', world: 'w', player: { vehicle: 'beltway-nightmare' } }, { id: 'elsewhere', world: 'other', player: { vehicle: 'no-model-yet' } }] },
}

const fake = (service = SERVICE) => ({
  get: async (p) => {
    if (!(p in service)) throw Object.assign(new Error(`404 ${p}`), { status: 404 })
    return service[p]
  },
  siteDoc: { read: async (slug, name) => SITE[`${slug}/${name}`] ?? null },
})

/** every snippet, inside the `setup` a real program has */
const programOf = (snippets) =>
  `import { defineGame } from '@apex/program'\nexport default defineGame({\n  setup(api) {\n${snippets.map((s) => s.split('\n').map((l) => `    ${l}`).join('\n')).join('\n')}\n  },\n})\n`

test('lists every group a world has, in the editor\'s order, with counts', async () => {
  const r = await programRefs(fake(), { slug: 'w' })
  assert.deepEqual(r.groups.map((g) => [g.kind, g.count]), [
    ['traffic', 1], ['point', 2], ['placement', 1], ['stunt', 1], ['race', 1], ['build', 1], ['sound', r.groups.find((g) => g.kind === 'sound').count], ['library', 4],
  ])
  // the bank is the repo's own: every slot, each with what it is for
  const sound = r.groups.find((g) => g.kind === 'sound')
  assert.ok(sound.count >= 10, `the bank has its slots (${sound.count})`)
  assert.ok(sound.refs.every((s) => s.desc && s.snippet.startsWith('api.audio.')))
})

test('the library is what a spawn can find: models only, and builds that wear one', async () => {
  const r = await programRefs(fake(), { slug: 'w', kinds: ['library'] })
  // not `ghost` (a kit entry with no model), not `drawn-only` (a drawing with no mesh), not
  // `no-model-yet` (a build that is numbers, not a thing)
  assert.deepEqual(r.groups[0].refs.map((x) => x.id).sort(), ['beltway-nightmare', 'cone', 'fc-rx-7', 'watertower-01'])
  const build = r.groups[0].refs.find((x) => x.id === 'beltway-nightmare')
  assert.match(build.desc, /vehicle build/)
})

test('the level\'s builds carry who names them and which sounds they override', async () => {
  const r = await programRefs(fake(), { slug: 'w', kinds: ['build', 'sound'] })
  const build = r.groups.find((g) => g.kind === 'build').refs[0]
  assert.equal(build.id, 'beltway-nightmare')
  assert.match(build.desc, /beltway \(player\)/)
  assert.match(build.detail, /crash\.heavy/)
  const heavy = r.groups.find((g) => g.kind === 'sound').refs.find((s) => s.id === 'crash.heavy')
  assert.match(heavy.desc, /overridden by beltway-nightmare/)
  // a level in another world does not put its car in this one: `no-model-yet` is named by a
  // level of `other`, and is not a build row here
  assert.equal(r.groups.find((g) => g.kind === 'build').refs.length, 1)
})

test('the library snippet is the sentence asked for: on entering the zone, spawn at the point', async () => {
  const r = await programRefs(fake(), { slug: 'w', kinds: ['library'], q: 'cone' })
  const s = r.groups[0].refs[0].snippet
  assert.match(s, /api\.on\('enters', 'z-01'/)
  assert.match(s, /api\.point\('p-03'\)/, 'a spot, not the start the player is already at')
  assert.match(s, /api\.models\.spawn\('cone', at\)/)
  assert.match(s, /api\.models\.remove\(id\)/)
})

test('kinds and q narrow it; a bad slug or kind is refused with the words to fix it', async () => {
  const r = await programRefs(fake(), { slug: 'w', q: 'largo' })
  const shown = r.groups.filter((g) => g.refs.length).map((g) => [g.kind, g.refs.map((x) => x.id)])
  assert.deepEqual(shown, [['traffic', ['z-01']]])
  // a group says how many it has and how many matched, so an empty search is not an empty world
  assert.deepEqual([r.groups[1].kind, r.groups[1].count, r.groups[1].matched], ['point', 2, 0])
  const narrowed = await programRefs(fake(), { slug: 'w', kinds: ['point', 'race'] })
  assert.deepEqual(narrowed.groups.map((g) => g.kind), ['point', 'race'])
  await assert.rejects(programRefs(fake(), { slug: '../etc' }), /world slug/)
  await assert.rejects(programRefs(fake(), { slug: 'w', kinds: ['zones'] }), /not one of/)
})

test('no asset service is a world without a library, not an error', async () => {
  const r = await programRefs(fake({}), { slug: 'w' })
  assert.deepEqual(r.groups.map((g) => g.kind), ['traffic', 'point', 'placement', 'stunt', 'race', 'sound'])
})

test('EVERY SNIPPET TYPECHECKS against the declarations a program is checked with', async () => {
  const r = await programRefs(fake(), { slug: 'w' })
  const snippets = r.groups.flatMap((g) => g.refs.map((x) => x.snippet))
  assert.ok(snippets.length > 20)
  const c = await check(programOf(snippets))
  assert.deepEqual(c.problems, [], 'the snippets as one program')
  assert.equal(c.ok, true)
  // and the check can fail: a call that does not exist, and an id where a number belongs
  const bad = await check(programOf([...snippets.slice(0, 2), "api.points('p-03').x", "api.traffic.set('z-01', 'busy')"]))
  assert.equal(bad.ok, false)
  // an error on each of the two wrong lines, and none anywhere else
  const lines = new Set(bad.problems.filter((p) => p.category === 'error').map((p) => p.line))
  assert.equal(lines.size, 2)
})

test('spawnables keeps the library\'s word over the kit\'s for the same id', () => {
  const list = spawnables({ kit: [{ id: 'a', name: 'Kit A', glb: 'x.glb' }], items: [{ id: 'a', subject: 'Library A', kind: 'pedestrian', mesh: 1 }], builds: [] }, (it) => (it.kind === 'pedestrian' ? 'actor' : 'prop'))
  assert.deepEqual(list, [{ id: 'a', name: 'Library A', category: 'pedestrian', type: 'actor' }])
})

test('the tool is advertised, and says what it answers', () => {
  const tools = serverTools({ apiFetch: async () => ({}), root: '/nowhere', siteDoc: { read: async () => null, write: async () => '' } })
  const t = tools.find((x) => x.name === 'program_refs')
  assert.ok(t)
  assert.deepEqual(t.inputSchema.required, ['slug'])
  for (const word of ['snippet', 'api.models.spawn', 'api.point', 'sound', 'library']) assert.ok(t.description.includes(word), word)
  const api = tools.find((x) => x.name === 'program_api')
  assert.match(api.description, /api\.point\(id\)/)
  assert.match(api.description, /program_refs/)
})
