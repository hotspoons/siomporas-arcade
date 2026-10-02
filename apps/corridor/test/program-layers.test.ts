// Can a program name the traffic somebody painted and the stunts somebody placed?
//
// Rich, 2026-09-29: *"I don't see any of these placed assets like traffic or stunts appearing in
// the program editor. I would have presumed they would show up as placeable references in code so
// we do things like trigger traffic and show and hide stunts."*
//
// The discipline that matters here is the one `physics` already has: EVERY CALL IS SAFE WITHOUT A
// WORLD. A dry run — a test, an editor preview, a program being checked before it is attached —
// has no zones and no fixtures, and a program that closes a bridge must still be a program you can
// step. So half of this file is about the empty case.
import { describe, expect, it, vi } from 'vitest'
import { defineGame, GameRun, type GameApi, type ProgramHost, type WorldLayersHost } from '../src/game/session/program'
import { ActorWorld } from '../src/game/actors/actorworld'

/*
 * `start()` IS ASYNC and the program body runs inside it, behind a guard that swallows throws — so a
 * test that does not await gets its assertions eaten and passes for the wrong reason. Ask for the
 * body's own result instead of asserting inside it, and await the run.
 */
async function run<T>(layers: WorldLayersHost | undefined, body: (api: GameApi) => T): Promise<T> {
  const aw = new ActorWorld()
  // `playerAt` is required — the run reads it on the first tick to establish the distance origin
  const host: ProgramHost = { world: aw.world, actors: aw, layers, playerAt: () => ({ x: 0, y: 0, z: 0 }) }
  let out!: T
  // `setup` is the hook a level's code runs in — `start()` on the run is what calls it
  const def = defineGame({ setup: (api) => { out = body(api) } })
  await new GameRun(host, def).start()
  return out
}

describe('a program can reach the world its editor drew', () => {
  it('lists what is there, and changes it', async () => {
    const set = vi.fn(() => true)
    const show = vi.fn(() => true)
    const layers: WorldLayersHost = {
      trafficIds: () => ['downtown', 'the-bridge'],
      trafficDensity: (id) => (id === 'downtown' ? 0.6 : 0.1),
      setTraffic: set,
      trafficAt: () => 0.42,
      stuntIds: () => ['loop-1'],
      showStunt: show,
      stuntVisible: () => true,
      stuntAt: () => ({ x: 10, y: 20, z: 30 }),
    }
    const got = await run(layers, (api) => ({
      ids: api.traffic.ids(),
      density: api.traffic.density('downtown'),
      at: api.traffic.at(1, 2),
      set: api.traffic.set('the-bridge', 1, { over: 20 }),
      stuntIds: api.stunts.ids(),
      shown: api.stunts.show('loop-1', false),
      visible: api.stunts.visible('loop-1'),
      where: api.stunts.where('loop-1'),
    }))
    expect(got.ids).toEqual(['downtown', 'the-bridge'])
    expect(got.density).toBe(0.6)
    expect(got.at).toBe(0.42)
    expect(got.set).toBe(true)
    expect(got.stuntIds).toEqual(['loop-1'])
    expect(got.shown).toBe(true)
    expect(got.visible).toBe(true)
    expect(got.where).toEqual({ x: 10, y: 20, z: 30 })
    expect(set).toHaveBeenCalledWith('the-bridge', 1, { over: 20 })
    expect(show).toHaveBeenCalledWith('loop-1', false)
  })

  /*
   * THE DENSITY IS CLAMPED ON THE WAY IN. A program that computes one from a fraction and gets the
   * arithmetic slightly wrong should not be able to hand the traffic system a 1.4 — the symptom
   * would be somewhere else entirely, in whatever the spawner does with it.
   */
  it('clamps a density rather than passing nonsense through', async () => {
    const set = vi.fn(() => true)
    await run({ setTraffic: set }, (api) => {
      api.traffic.set('z', 4)
      api.traffic.set('z', -2)
      api.traffic.set('z', Number.NaN)
    })
    expect(set).toHaveBeenNthCalledWith(1, 'z', 1, undefined)
    expect(set).toHaveBeenNthCalledWith(2, 'z', 0, undefined)
    expect(set).toHaveBeenCalledTimes(2) // the NaN never reached the world
  })

  it('is safe with no world at all — the whole point of a dry run', async () => {
    const got = await run(undefined, (api) => ({
      ids: api.traffic.ids(), density: api.traffic.density('nope'), at: api.traffic.at(0, 0),
      set: api.traffic.set('nope', 1), stuntIds: api.stunts.ids(),
      shown: api.stunts.show('nope', true), visible: api.stunts.visible('nope'), where: api.stunts.where('nope'),
    }))
    expect(got).toEqual({ ids: [], density: null, at: 0, set: false, stuntIds: [], shown: false, visible: null, where: null })
  })

  it('is safe with a host that implements only half of it', async () => {
    const got = await run({ trafficIds: () => ['a'] }, (api) => ({
      ids: api.traffic.ids(),
      set: api.traffic.set('a', 0.5), // no setter: says so rather than pretending
      stunts: api.stunts.ids(),
    }))
    expect(got).toEqual({ ids: ['a'], set: false, stunts: [] })
  })
})
