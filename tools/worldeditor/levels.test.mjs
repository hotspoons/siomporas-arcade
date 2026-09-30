// Does the level validator refuse what it should, and accept the worked example?
//
// The one that matters is a condition on a fact the engine does not measure. That level looks
// right, saves, loads, plays — and the event never fires, with nothing anywhere saying why. Every
// other check here is shape; that one is the reason the validator exists.
//
//   node tools/worldeditor/levels.test.mjs
import { validate, withDefaults, blank, FACTS, PROFILES } from './levels.mjs'
import { readFileSync } from 'node:fs'

let failed = 0
const check = (name, got, want) => {
  const ok = got === want
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `   got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`)
  if (!ok) failed++
}
const first = (lvl) => validate(lvl).errors[0] ?? null

console.log('level document\n')

/* The worked example from the handoff: Route 3 rage. If this does not validate, the schema is
   wrong, not the example. */
const rage = withDefaults({
  id: 'route3-rage-01',
  world: 'crofton-triangle',
  defaults: { time: '17:30', weather: 'wet', season: 'autumn' },
  placements: [{ asset: 'water-tower-01', at: [120, -340], yaw: 90 }],
  simulations: [{ kind: 'traffic', density: 'rush', seed: 7, bounds: 'world', model: 'idm+mobil' }],
  mode: 'drive',
  scenario: {
    goal: { type: 'score', target: 5000, time_s: 300 },
    spawn: { at: 'Route 3 @ Waugh Chapel', facing: 'north' },
    events: [
      { when: 'score >= 2500', do: 'spawn', what: 'police', count: 2 },
      { when: 'wrecks >= 5', do: 'message', text: 'Traffic is now worse than you found it.' },
    ],
    scoring: [
      { event: 'wreck', points: 100 },
      { event: 'jam_length_m', points: 1, per: 10 },
    ],
  },
})
const r = validate(rage)
check('Route 3 rage validates', r.ok, true)
if (!r.ok) console.log('      ', r.errors.join('\n       '))
check('  and warns about nothing', r.warnings.length, 0)

/* THE ONE THAT MATTERS */
check(
  'a condition on a fact nothing measures is refused',
  first({ ...rage, scenario: { ...rage.scenario, events: [{ when: 'rage_meter >= 80', do: 'message', text: 'hi' }] } }),
  'scenario.events[0] tests "rage_meter", which the engine does not measure. Facts: ' + Object.keys(FACTS).join(', '),
)

/* shape */
check('a bad slug', first({ ...rage, id: 'Route 3!' }), 'id "Route 3!" is not a usable slug')
check('a mode that is not a mode', first({ ...rage, mode: 'swim' }), 'mode "swim" is not one of drive, fly, walk')
check('a clock that is not a clock', first({ ...rage, defaults: { time: '5:30pm' } }), 'defaults.time "5:30pm" is not HH:MM')
check('a placement with no position', first({ ...rage, placements: [{ asset: 'x' }] }), 'placements[0].at must be [x, y] or [x, y, z] in site metres')
check('an unseeded simulation is fine', validate({ ...rage, simulations: [{ kind: 'traffic' }] }).ok, true)
check('a fractional seed is not', first({ ...rage, simulations: [{ kind: 'traffic', seed: 1.5 }] }), 'simulations[0].seed must be a whole number — it is what makes a run repeatable')
check('an unwritable condition', first({ ...rage, scenario: { ...rage.scenario, events: [{ when: 'score is big', do: 'end', outcome: 'win' }] } }), 'scenario.events[0].when "score is big" is not "<fact> <op> <number>"')
check('an action that is not an action', first({ ...rage, scenario: { ...rage.scenario, events: [{ when: 'score >= 1', do: 'explode' }] } }), 'scenario.events[0].do "explode" is not one of spawn, message, end, score, weather, time')
check('ending without saying how', first({ ...rage, scenario: { ...rage.scenario, events: [{ when: 'time >= 300', do: 'end' }] } }), 'scenario.events[0] ends the level without saying win or lose')

/* the warning that is a warning and not an error: it is a valid document and an unplayable level */
const unwinnable = validate({ ...rage, scenario: { ...rage.scenario, scoring: [] } })
check('a score goal with no scoring warns', unwinnable.warnings[0], 'the goal is a score and nothing scores: this level cannot be won')
check('  and still validates', unwinnable.ok, true)

/* defaults */
const b = blank('empty-01', 'crofton-triangle')
check('a blank level validates', validate(b).ok, true)
check('  and opens at half past five', b.defaults.time, '17:30')
check('  in drive', b.mode, 'drive')

/* ---- who you are driving -------------------------------------------------------------------
   The field that connects a car in the library to a level you can drive it in. Until 2026-09-29 a
   level could place a car as SCENERY and had no way to say which one you sat in.

   NOTE FOR WHOEVER ADDS THE NEXT CASE: these go ABOVE the `process.exit` below. The first version
   of this block was appended to the end of the file, after the exit, using `node:test`'s `test()`
   which this file does not import — so it never ran, and a mutation that broke the drift guard
   still reported "all passed". A test that cannot fail is worse than no test. */
const player = (p) => validate({ ...blank('lvl-01', 'crofton-triangle'), player: p })
check('a catalog id and a profile', player({ vehicle: 'rx7-fd', profile: 'sim' }).ok, true)
check('  the profile is optional', player({ vehicle: 'rx7-fd' }).ok, true)
check('  and so is the whole field, since every level written before it has none', validate(blank('lvl-01', 'crofton-triangle')).ok, true)
check('  absent says nothing: a warning on every document is not a signal', validate(blank('lvl-01', 'crofton-triangle')).warnings.length, 0)
check('a player naming no vehicle is refused', first({ ...blank('lvl-01', 'crofton-triangle'), player: { profile: 'sim' } }), 'player.vehicle names no asset — it is a catalog id')
check('a profile that is not one names the ones that are', first({ ...blank('lvl-01', 'crofton-triangle'), player: { vehicle: 'rx7-fd', profile: 'realistic' } }), 'player.profile "realistic" is not one of stunts, taxi, street, rush, sim')
// Rich, 2026-09-29: "Unrigged cars should still be usable as vehicles, the wheels just won't turn."
// The engine places raycast wheels from the wheelbase and track and has never needed bones, so
// nothing here may refuse an asset for lacking one — and nothing here can even see one.
check('  and nothing is said about a rig', player({ vehicle: 'a-car-with-no-skeleton' }).ok, true)

/* THE COPY, AND ITS GUARD. `levels.mjs` has no bundler and must not import the game to read five
   strings, so `PROFILES` is a copy — and an unguarded copy is how two lists stop agreeing with
   nobody finding out. This reads the real one off disk. */
{
  const src = readFileSync(new URL('../../packages/engine/src/physics/profiles.ts', import.meta.url), 'utf8')
  const block = src.slice(src.indexOf('export const PROFILES'), src.indexOf('export type ProfileId'))
  const real = [...block.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1])
  // if the parse breaks, this says so instead of quietly comparing two empty lists
  check('the engine declares at least five profiles (else this parse is wrong)', real.length >= 5, true)
  check('  and the copy in levels.mjs still matches them', [...PROFILES].sort().join(','), real.sort().join(','))
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)

test('a key no loader reads is warned about by name, with the keys a level has', () => {
  const v = validate({ id: 'x', world: 'w', physics: true, ui: 'game' })
  assert.equal(v.ok, true)
  assert.ok(v.warnings.some((w) => w.startsWith('"physics" is not something a level says')), v.warnings.join('\n'))
  assert.ok(v.warnings.some((w) => w.startsWith('"ui" is not')))
  assert.equal(validate({ id: 'x', world: 'w', name: 'n', description: 'd', program: 'a.ts' }).warnings.length, 0)
})
