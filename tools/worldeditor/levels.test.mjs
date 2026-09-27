// Does the level validator refuse what it should, and accept the worked example?
//
// The one that matters is a condition on a fact the engine does not measure. That level looks
// right, saves, loads, plays — and the event never fires, with nothing anywhere saying why. Every
// other check here is shape; that one is the reason the validator exists.
//
//   node tools/worldeditor/levels.test.mjs
import { validate, withDefaults, blank, FACTS } from './levels.mjs'

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

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
