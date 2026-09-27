// A level: a world, dressed, set in motion, and given something to do.
//
// This is the document the Stage panel edits and the game loads. It is deliberately THIN — it
// names things that already exist rather than containing them:
//
//     world        a baked site on the volume (sites/<slug>/)
//     splats       trained captures to lay over it
//     placements   assets from the catalog, positioned
//     simulations  traffic and the like, as properties rather than code
//     scenario     goal, events, scoring — three primitives, and no more
//
// WHY NOT A SCRIPTING LANGUAGE. The scenario could be arbitrary code and then nobody writes one:
// every level becomes a programming task, the editor cannot show you what a level does without
// running it, and an agent asked to write one invents a shape that does not validate. Three
// declarative primitives over a small table of FACTS cover the rage simulator, the tractor beam
// and both kids' games, which is the whole current demand. When something genuinely does not fit,
// the answer is one more fact in the table, not an escape hatch into JavaScript.
//
// The facts a scenario may read are listed here, in FACTS, and validation checks against them —
// so a condition that mentions something the engine does not measure is refused at save time
// rather than silently never firing at 2 a.m.

/** Everything a scenario may test. Add here when the engine can genuinely measure it. */
export const FACTS = {
  score: 'points so far',
  time: 'seconds since the level started',
  speed: 'the player\'s speed, m/s',
  wrecks: 'vehicles wrecked',
  jam_length_m: 'metres of queued traffic behind the worst blockage',
  at_junction: '1 when the player is inside a junction, else 0',
  distance_m: 'metres travelled',
  airtime_s: 'seconds since the wheels last touched',
}

/** What an event may do. Each maps to one engine call and nothing else. */
export const ACTIONS = {
  spawn: 'put something into the world (what, count)',
  message: 'say something to the player (text)',
  end: 'finish the level (outcome: win | lose)',
  score: 'add points (points)',
  weather: 'change the weather (what)',
  time: 'set the clock (text, "HH:MM")',
}

export const MODES = ['drive', 'fly', 'walk']

const SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/
/** `score >= 2500`, `wrecks > 5`, `time < 60`. One fact, one operator, one number. */
const CONDITION = /^([a-z_]+)\s*(>=|<=|==|>|<)\s*(-?\d+(?:\.\d+)?)$/

function bad(msg) {
  return Object.assign(new Error(msg), { status: 400 })
}

/**
 * Check a level. Returns `{ ok, errors, warnings }` — it does not throw, because the editor wants
 * to show a person every problem at once rather than the first one.
 *
 * WHAT IS CHECKED AND WHAT IS NOT. Shape, vocabulary and references-within-the-document are
 * checked here. Whether `world` is actually baked, or an asset is in the catalog, is checked by
 * the caller against the volume: this module has no filesystem and is therefore testable without
 * one, and the same function validates a level an agent just wrote before it ever reaches disk.
 */
export function validate(level) {
  const errors = []
  const warnings = []
  const E = (m) => errors.push(m)

  if (!SLUG.test(level?.id ?? '')) E(`id ${JSON.stringify(level?.id)} is not a usable slug`)
  if (!SLUG.test(level?.world ?? '')) E(`world ${JSON.stringify(level?.world)} is not a usable slug`)
  if (level.mode !== undefined && !MODES.includes(level.mode)) E(`mode ${JSON.stringify(level.mode)} is not one of ${MODES.join(', ')}`)

  const d = level.defaults ?? {}
  if (d.time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.time)) E(`defaults.time ${JSON.stringify(d.time)} is not HH:MM`)

  for (const [i, p] of (level.placements ?? []).entries()) {
    if (!p?.asset) E(`placements[${i}] has no asset`)
    if (!Array.isArray(p?.at) || p.at.length < 2 || !p.at.every((n) => Number.isFinite(n))) E(`placements[${i}].at must be [x, y] or [x, y, z] in site metres`)
    if (p.yaw !== undefined && !Number.isFinite(p.yaw)) E(`placements[${i}].yaw must be a number of degrees`)
  }

  for (const [i, s] of (level.splats ?? []).entries()) {
    if (!s?.run && !s?.id) E(`splats[${i}] names neither a run nor an id`)
  }

  for (const [i, s] of (level.simulations ?? []).entries()) {
    if (!s?.kind) E(`simulations[${i}] has no kind`)
    if (s?.seed !== undefined && !Number.isInteger(s.seed)) E(`simulations[${i}].seed must be a whole number — it is what makes a run repeatable`)
  }

  const sc = level.scenario
  if (sc) {
    if (sc.goal) {
      if (!sc.goal.type) E('scenario.goal has no type')
      if (sc.goal.time_s !== undefined && !(sc.goal.time_s > 0)) E('scenario.goal.time_s must be positive')
    }
    for (const [i, ev] of (sc.events ?? []).entries()) {
      const m = CONDITION.exec(String(ev?.when ?? ''))
      if (!m) {
        E(`scenario.events[${i}].when ${JSON.stringify(ev?.when)} is not "<fact> <op> <number>"`)
      } else if (!(m[1] in FACTS)) {
        // the fault this catches: a condition on something nothing measures never fires, and
        // nothing anywhere says so
        E(`scenario.events[${i}] tests "${m[1]}", which the engine does not measure. Facts: ${Object.keys(FACTS).join(', ')}`)
      }
      if (!ev?.do) E(`scenario.events[${i}] has no action`)
      else if (!(ev.do in ACTIONS)) E(`scenario.events[${i}].do "${ev.do}" is not one of ${Object.keys(ACTIONS).join(', ')}`)
      if (ev?.do === 'end' && !['win', 'lose'].includes(ev.outcome)) E(`scenario.events[${i}] ends the level without saying win or lose`)
    }
    for (const [i, r] of (sc.scoring ?? []).entries()) {
      if (!r?.event) E(`scenario.scoring[${i}] has no event`)
      if (!Number.isFinite(r?.points)) E(`scenario.scoring[${i}].points must be a number`)
      if (r?.per !== undefined && !(r.per > 0)) E(`scenario.scoring[${i}].per must be positive`)
    }
    if (sc.goal?.type === 'score' && !(sc.scoring ?? []).length) {
      warnings.push('the goal is a score and nothing scores: this level cannot be won')
    }
  }
  return { ok: !errors.length, errors, warnings }
}

/** A level with everything the engine needs filled in, so a loader never guesses. */
export function withDefaults(level) {
  return {
    mode: 'drive',
    defaults: { time: '17:30', weather: 'clear', season: 'summer' },
    splats: [],
    placements: [],
    simulations: [],
    ...level,
    defaults: { time: '17:30', weather: 'clear', season: 'summer', ...(level.defaults ?? {}) },
  }
}

/** A level document in the shape the Stage panel writes, for an empty world. */
export function blank(id, world) {
  return withDefaults({ id, world, created: new Date().toISOString(), scenario: null })
}
