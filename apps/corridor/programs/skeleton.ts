// A starting program: everything this world has, discovered, with the rest commented beside it.
//
// Rich, 2026-09-29: *"Need more comprehensive skeleton project with things that depend on map
// specific assets either auto-discovered or example sections commented out or both. Prefer both,
// and if no asset of type traffic exists, no auto-altering of traffic will occur."*
//
// So: BOTH. Every section below asks the world what it has and does nothing when the answer is
// nothing — `api.traffic.ids()` on a world with no painted zones is an empty array, the loop does
// not run, and no traffic is altered. Under each one is a commented example with a real id in it,
// for when you know what you want instead of what happens to be there.
//
// NOTHING HERE THROWS ON AN EMPTY WORLD. That is the property to keep as you edit it: a program is
// written once and dropped onto a dozen maps, and the one that assumes a stage exists is the one
// that breaks on eleven of them.
//
// Copy this into `programs/<your-game>.ts` and cut what you do not need.

import { defineGame, type GameApi } from '@apex/program'

export default defineGame({
  setup(api) {
    /* ---- what this world has ----------------------------------------------------------------
     * Run once. `say` puts a line on screen; the console has the same text with more of it.
     */
    const races = api.races.ids()
    const zones = api.traffic.ids()
    const stunts = api.stunts.ids()
    const placed = api.placements()

    api.say(`${races.length} races · ${zones.length} traffic zones · ${stunts.length} stunts · ${placed.length} placements`)
    api.goal(races.length ? 'Drive into a ring to start a race' : 'Explore')

    /* ---- races -------------------------------------------------------------------------------
     * Every circuit and stage the editor saved. Driving into a marker starts one by itself, so a
     * program only needs this to START one without the marker, or to react to the result.
     */
    for (const id of races) {
      const r = api.races.get(id)
      if (r) console.log(`race ${r.id}: ${r.name} — ${r.kind}, ${r.gates} gates${r.kind === 'circuit' ? `, ${r.laps} laps` : ''}`)
    }

    // Start one immediately instead of waiting for the player to find it:
    // api.races.start('st-01')

    /* ---- traffic ------------------------------------------------------------------------------
     * NOTHING HAPPENS ON A WORLD WITH NO ZONES. The loop below does not run, so no traffic is
     * altered — which is the rule Rich asked for, and it falls out of asking rather than assuming.
     */
    if (!zones.length) {
      console.log('no traffic zones in this world — leaving the traffic alone')
    } else {
      for (const id of zones) console.log(`traffic zone ${id}: ${api.traffic.density(id)}`)
    }

    // Close a road over twenty seconds when something happens:
    // api.traffic.set('the-bridge', 1, { over: 20 })
    // Clear the town for a chase:
    // for (const id of api.traffic.ids()) api.traffic.set(id, 0, { over: 5 })

    /* ---- stunts --------------------------------------------------------------------------------
     * Loops, corkscrews and jumps standing on the road. Hiding one puts the baked road back.
     */
    for (const id of stunts) console.log(`stunt ${id} at ${JSON.stringify(api.stunts.where(id))}`)

    // Keep the loop out of the way until the player has earned it:
    // for (const id of api.stunts.ids()) api.stunts.show(id, false)

    /* ---- placements ----------------------------------------------------------------------------
     * Everything dragged into the world in the Place mode. `placedWith` finds them by the tag the
     * editor writes, which is the asset's own category.
     */
    // const barrels = api.placedWith('prop')
    // for (const e of barrels) api.physics.impulse(e, { x: 0, y: 8, z: 0 })

    /* ---- the shape of a game -------------------------------------------------------------------
     * Uncomment one. Each is complete; none of them needs anything this world does not have.
     */

    // A. FINISH ANY RACE TO WIN.
    // api.each(() => {
    //   const s = api.races.state()
    //   if (s?.phase === 'finished') api.win(`${s.course} in ${s.time.toFixed(1)}s`)
    // })

    // B. RALLY: every stage in order, times added up.
    // const stages = api.races.ids().filter((id) => api.races.get(id)?.kind === 'stage')
    // let at = 0
    // let total = 0
    // if (stages.length) {
    //   api.races.start(stages[0])
    //   api.each(() => {
    //     const s = api.races.state()
    //     if (s?.phase !== 'finished') return
    //     total += s.time + s.penalties
    //     at++
    //     if (at >= stages.length) api.win(`rally complete — ${total.toFixed(1)}s`)
    //     else api.races.start(stages[at])
    //   })
    // }

    // C. RUSH HOUR: the traffic thickens as the clock runs down.
    // api.each((dt) => {
    //   void dt
    //   const f = api.facts()
    //   const busy = Math.min(1, f.time / 180)
    //   for (const id of api.traffic.ids()) api.traffic.set(id, busy)
    // })

    // D. TIME LIMIT.
    // api.after(120, () => api.lose('out of time'))
  },

  update(dt, api) {
    void dt
    void api
    /*
     * Every frame. `api.each` in `setup` does the same thing and reads better beside the code that
     * set it up; this is here for the loop that belongs to the game rather than to one feature.
     */
  },
})

/**
 * A worked example, kept out of `setup` so the skeleton above stays readable.
 *
 * WHAT IT DEMONSTRATES: reacting to a race rather than driving it. The player finds a stage and
 * drives it; finishing inside the target time closes the traffic down as a reward and opens the
 * stunt that was hidden. Nothing here assumes the world HAS a stage, a zone or a fixture.
 */
export function rewardForABrisk(api: GameApi, target = 60): void {
  let given = false
  api.each(() => {
    if (given) return
    const s = api.races.state()
    if (s?.phase !== 'finished') return
    given = true
    const took = s.time + s.penalties
    if (took > target) {
      api.say(`${took.toFixed(1)}s — under ${target}s next time`)
      return
    }
    api.award(100)
    api.say(`${took.toFixed(1)}s — the road is yours`)
    for (const id of api.traffic.ids()) api.traffic.set(id, 0, { over: 8 })
    for (const id of api.stunts.ids()) api.stunts.show(id, true)
  })
}
