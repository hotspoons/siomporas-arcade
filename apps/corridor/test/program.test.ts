// Can a whole game be played without a renderer?
//
// That is the entire point of keeping the program layer free of THREE and the DOM. "Did the win
// condition ever fire" is a question with a real answer only if the run can be stepped, and the
// bugs a program layer actually has are all of this shape: a timer that fires every frame instead
// of once, a zone that never triggers because the player never left it, a goal that cannot be
// reached because the fact it tests is not measured, a throw in somebody's `update` that takes the
// frame loop down with it.
//
// So these tests write small games and play them.
import { describe, expect, it, vi } from 'vitest'
import { addComponent, addEntity, query } from 'bitecs'
import { ActorWorld } from '../src/actorworld'
import { Transform, Vehicle } from '../src/actors'
import {
  GameRun, HIDEABLE, TRANSPORT, defineGame, inZone,
  type GameDef, type ProgramHost, type Transport,
} from '../src/program'

/** A host with no renderer behind it: the player is wherever the test last put them. */
function host(at: { x: number; y: number; z?: number } = { x: 0, y: 0 }) {
  const state = {
    at: { x: at.x, y: at.y, z: at.z ?? 0 },
    speed: 0,
    hidden: new Set<string>(),
    transport: 'drive' as Transport,
    presets: [] as (string | Record<string, number>)[],
    said: [] as string[],
    time: null as string | null,
    weather: null as string | null,
    actors: new ActorWorld(),
  }
  const h: ProgramHost = {
    actors: state.actors,
    hide: (what, hidden) => { if (hidden) state.hidden.add(what); else state.hidden.delete(what) },
    transport: (m) => { state.transport = m },
    preset: (id) => { state.presets.push(id) },
    say: (t) => { state.said.push(t) },
    playerAt: () => state.at,
    playerSpeed: () => state.speed,
    setTime: (t) => { state.time = t },
    setWeather: (w) => { state.weather = w },
  }
  return { h, state }
}

/** Play a game for `seconds` at 50 Hz, the same step the ActorWorld uses. */
async function play(def: GameDef, h: ProgramHost, seconds: number, each?: (t: number, run: GameRun) => void) {
  const run = new GameRun(h, def)
  await run.start()
  const dt = 0.02
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    run.tick(dt)
    each?.(t + dt, run)
  }
  return run
}

describe('inZone', () => {
  it('is inclusive on a circle edge and inside a box', () => {
    expect(inZone({ kind: 'circle', x: 0, y: 0, r: 10 }, 10, 0)).toBe(true)
    expect(inZone({ kind: 'circle', x: 0, y: 0, r: 10 }, 10.01, 0)).toBe(false)
    expect(inZone({ kind: 'box', x0: 0, y0: 0, x1: 10, y1: 4 }, 5, 2)).toBe(true)
    expect(inZone({ kind: 'box', x0: 0, y0: 0, x1: 10, y1: 4 }, 5, 5)).toBe(false)
  })

  it('does not care which corner of a box was given first', () => {
    const a: Parameters<typeof inZone>[0] = { kind: 'box', x0: 10, y0: 4, x1: 0, y1: 0 }
    expect(inZone(a, 5, 2)).toBe(true)
  })
})

describe('the declarative half', () => {
  it('hides and shows the things on the list', async () => {
    const { h, state } = host()
    await play(defineGame({ setup: (api) => { api.hide('street-names'); api.hide('minimap') } }), h, 0.1)
    expect([...state.hidden].sort()).toEqual(['minimap', 'street-names'])
    await play(defineGame({ setup: (api) => api.show('minimap') }), h, 0.1)
    expect([...state.hidden]).toEqual(['street-names'])
  })

  it('offers a closed list of hideables and transports, so a typo cannot silently do nothing', () => {
    expect(Object.keys(HIDEABLE)).toContain('street-names')
    expect(TRANSPORT).toContain('walk-third')
    expect(TRANSPORT).toContain('ufo')
  })

  it('swaps the controller, sets the clock and the weather, and applies a look', async () => {
    const { h, state } = host()
    await play(defineGame({
      setup: (api) => {
        api.transport('parkour')
        api.time('21:30')
        api.weather('rain')
        api.preset('dusk-rain', { over: 8 })
      },
    }), h, 0.1)
    expect(state.transport).toBe('parkour')
    expect(state.time).toBe('21:30')
    expect(state.weather).toBe('rain')
    expect(state.presets).toEqual(['dusk-rain'])
  })
})

describe('zones', () => {
  it('fires on the crossing, not on every frame inside', async () => {
    const { h, state } = host({ x: 100, y: 0 })
    let entered = 0
    let left = 0
    const run = new GameRun(h, defineGame({
      setup: (api) => {
        api.zone('rooftop', { kind: 'circle', x: 0, y: 0, r: 10 })
        api.on('enters', 'rooftop', () => { entered += 1 })
        api.on('leaves', 'rooftop', () => { left += 1 })
      },
    }))
    await run.start()
    for (let i = 0; i < 10; i += 1) run.tick(0.02) // outside
    expect(entered).toBe(0)
    state.at = { x: 0, y: 0, z: 0 }
    for (let i = 0; i < 10; i += 1) run.tick(0.02) // inside, for ten frames
    expect(entered).toBe(1)
    expect(left).toBe(0)
    state.at = { x: 100, y: 0, z: 0 }
    for (let i = 0; i < 10; i += 1) run.tick(0.02)
    expect(entered).toBe(1)
    expect(left).toBe(1)
  })

  it('fires on a crossing the run STARTS inside, which a naive edge test misses', async () => {
    // the player spawning in the goal zone is the first thing anyone tries
    const { h } = host({ x: 0, y: 0 })
    let entered = 0
    await play(defineGame({
      setup: (api) => {
        api.zone('here', { kind: 'circle', x: 0, y: 0, r: 10 })
        api.on('enters', 'here', () => { entered += 1 })
      },
    }), h, 0.1)
    expect(entered).toBe(1)
  })

  it('answers `in` about right now', async () => {
    const { h, state } = host({ x: 100, y: 0 })
    const seen: boolean[] = []
    const run = new GameRun(h, defineGame({
      setup: (api) => {
        api.zone('z', { kind: 'box', x0: -5, y0: -5, x1: 5, y1: 5 })
        api.each(() => seen.push(api.in('z')))
      },
    }))
    await run.start()
    run.tick(0.02)
    state.at = { x: 0, y: 0, z: 0 }
    run.tick(0.02)
    expect(seen).toEqual([false, true])
  })
})

describe('timers', () => {
  it('runs `after` exactly once, at the time it says', async () => {
    const { h } = host()
    const at: number[] = []
    const run = await play(defineGame({ setup: (api) => api.after(1, () => at.push(+api.facts().time.toFixed(2))) }), h, 3)
    expect(at).toEqual([1])
    void run
  })

  it('runs `every` on a period rather than every frame', async () => {
    // fired every frame instead, a "tick the clock forward" callback runs 150 times in three
    // seconds at 50 Hz; that is the difference between a heartbeat and a runaway
    const { h } = host()
    let n = 0
    await play(defineGame({ setup: (api) => api.every(0.5, () => { n += 1 }) }), h, 3.01)
    expect(n).toBe(6)
  })

  it('runs on the run’s own clock, so nothing fires while it is not being ticked', async () => {
    const { h } = host()
    let fired = false
    const run = new GameRun(h, defineGame({ setup: (api) => api.after(1, () => { fired = true }) }))
    await run.start()
    // a whole second of wall-clock time, and no ticks
    await new Promise((r) => setTimeout(r, 30))
    expect(fired).toBe(false)
    for (let i = 0; i < 60; i += 1) run.tick(0.02)
    expect(fired).toBe(true)
  })
})

describe('when', () => {
  it('fires once per crossing, not once per frame the condition holds', async () => {
    const { h, state } = host()
    let n = 0
    const run = new GameRun(h, defineGame({ setup: (api) => api.when((f) => f.speed > 20, () => { n += 1 }) }))
    await run.start()
    state.speed = 30
    for (let i = 0; i < 20; i += 1) run.tick(0.02)
    expect(n).toBe(1)
    state.speed = 0
    for (let i = 0; i < 5; i += 1) run.tick(0.02)
    state.speed = 30
    for (let i = 0; i < 5; i += 1) run.tick(0.02)
    expect(n).toBe(2)
  })

  it('does not fire for a condition that is already true at setup', async () => {
    // otherwise `when(f => f.score >= 0)` fires on the first frame of every level
    const { h } = host()
    let n = 0
    await play(defineGame({ setup: (api) => api.when((f) => f.score >= 0, () => { n += 1 }) }), h, 1)
    expect(n).toBe(0)
  })
})

describe('facts', () => {
  it('measures distance travelled along the path, not the straight line home', async () => {
    const { h, state } = host({ x: 0, y: 0 })
    const run = new GameRun(h, defineGame({}))
    await run.start()
    for (const p of [[10, 0], [10, 10], [0, 10], [0, 0]]) {
      state.at = { x: p[0], y: p[1], z: 0 }
      run.tick(0.02)
    }
    expect(run.facts().distance_m).toBeCloseTo(40, 6)
  })

  it('counts the zones the player is in', async () => {
    const { h } = host({ x: 0, y: 0 })
    const run = await play(defineGame({
      setup: (api) => {
        api.zone('a', { kind: 'circle', x: 0, y: 0, r: 5 })
        api.zone('b', { kind: 'circle', x: 0, y: 0, r: 50 })
        api.zone('c', { kind: 'circle', x: 500, y: 0, r: 5 })
      },
    }), h, 0.1)
    expect(run.facts().in_zones).toBe(2)
  })
})

describe('a whole game', () => {
  it('plays a goal to a win', async () => {
    // the shape of every level anyone has described: go somewhere, get points, finish
    const { h, state } = host({ x: 200, y: 0 })
    const game = defineGame({
      setup: (api) => {
        api.goal('Reach the rooftop before the rain')
        api.hide('street-names')
        api.transport('parkour')
        api.zone('rooftop', { kind: 'circle', x: 0, y: 0, r: 8 })
        api.on('enters', 'rooftop', () => {
          api.award(50)
          api.say('made it')
          api.win('Rooftop reached')
        })
        api.after(30, () => api.lose('Too slow'))
      },
    })
    const run = new GameRun(h, game)
    await run.start()
    expect(run.goalText).toBe('Reach the rooftop before the rain')
    for (let i = 0; i < 100; i += 1) run.tick(0.02)
    expect(run.outcome).toBeNull()
    state.at = { x: 0, y: 0, z: 0 }
    run.tick(0.02)
    expect(run.outcome).toBe('win')
    expect(run.score).toBe(50)
    expect(state.said).toContain('Rooftop reached')
    // and the losing timer must not fire after the win
    for (let i = 0; i < 3000; i += 1) run.tick(0.02)
    expect(run.outcome).toBe('win')
  })

  it('plays the same goal to a loss on the timer', async () => {
    const { h } = host({ x: 200, y: 0 })
    const run = await play(defineGame({
      setup: (api) => {
        api.zone('rooftop', { kind: 'circle', x: 0, y: 0, r: 8 })
        api.on('enters', 'rooftop', () => api.win())
        api.after(5, () => api.lose('Too slow'))
      },
    }), h, 6)
    expect(run.outcome).toBe('lose')
  })

  it('tells the program when the run ends, and which way', async () => {
    const { h } = host()
    const ends: string[] = []
    const run = new GameRun(h, defineGame({ setup: (api) => api.on('ends', (o) => ends.push(o)) }))
    await run.start()
    run.tick(0.02)
    run.stop()
    expect(ends).toEqual(['abandoned'])
  })

  it('reaches the ECS for what the declarative surface cannot say', async () => {
    // "define new exploration techniques" — only code can do this, so the world is handed over
    const { h } = host()
    const run = await play(defineGame({
      setup: (api) => {
        const w = api.world
        for (let i = 0; i < 5; i += 1) {
          const e = addEntity(w)
          addComponent(w, e, Transform)
          addComponent(w, e, Vehicle)
          Transform.x[e] = i * 10
        }
      },
      update: (_dt, api) => {
        for (const e of query(api.world, [Vehicle])) Transform.x[e] += 1
      },
    }), h, 0.1)
    expect(query(h.actors.world, [Vehicle]).length).toBe(5)
    expect(Transform.x[query(h.actors.world, [Vehicle])[0]]).toBeCloseTo(5, 5)
    void run
  })
})

describe('a program that throws', () => {
  it('stops the program and says so, rather than taking the frame loop with it', async () => {
    const { h, state } = host()
    const run = new GameRun(h, defineGame({
      update: () => { throw new Error('rage_meter is not defined') },
    }))
    await run.start()
    expect(() => run.tick(0.02)).not.toThrow()
    expect(run.error).toContain('rage_meter')
    expect(state.said.join(' ')).toContain('rage_meter')
    // and it stays stopped rather than throwing sixty times a second
    const before = state.said.length
    for (let i = 0; i < 50; i += 1) run.tick(0.02)
    expect(state.said.length).toBe(before)
  })

  it('reports a setup that throws instead of starting the level', async () => {
    const { h } = host()
    const run = new GameRun(h, defineGame({ setup: () => { throw new Error('no such preset') } }))
    expect(await run.start()).toBe(false)
    expect(run.error).toContain('no such preset')
  })

  it('survives a throwing condition, a throwing timer and a throwing zone handler', async () => {
    for (const def of [
      defineGame({ setup: (api) => api.when(() => { throw new Error('bad fact') }, () => {}) }),
      defineGame({ setup: (api) => api.after(0.1, () => { throw new Error('bad timer') }) }),
      defineGame({
        setup: (api) => {
          api.zone('z', { kind: 'circle', x: 0, y: 0, r: 10 })
          api.on('enters', 'z', () => { throw new Error('bad zone') })
        },
      }),
    ]) {
      const { h } = host({ x: 0, y: 0 })
      const run = await play(def, h, 0.5)
      expect(run.error).toBeTruthy()
    }
  })

  it('runs teardown when the level is torn down', async () => {
    const { h } = host()
    const teardown = vi.fn()
    const run = new GameRun(h, defineGame({ teardown }))
    await run.start()
    run.stop()
    expect(teardown).toHaveBeenCalledOnce()
  })
})

/*
 * THINGS THE EDITOR PLACED, AS ENTITIES A PROGRAM CAN DRIVE.
 *
 * Rich, 2026-09-28: "Anything placed in the map should be accessible from the code editor as an
 * instance that can be controlled in the ECS system". The interesting half is the write-back: a
 * program moves the ENTITY, and the scene has to follow — without that, `Transform.x[e] = 100`
 * looks like it worked and the water tower never moves.
 */
describe('what the editor placed', () => {
  const placedHost = () => {
    const { h, state } = host()
    const things = [
      { id: 'p-01', asset: 'watertower-01', x: 10, y: 20, z: null, yaw_deg: 90, scale: 1, tags: ['utility'] },
      { id: 'p-02', asset: 'barn-01', x: -5, y: 0, z: null, yaw_deg: 0, scale: 2, tags: ['barn', 'farm'] },
      { id: 'p-03', asset: 'barn-01', x: 40, y: 40, z: 12, yaw_deg: 180, scale: 1, tags: ['farm'] },
    ]
    const moved: { id: string; to: { x: number; y: number; yaw_deg: number; scale: number } }[] = []
    h.placements = () => things
    h.movePlacement = (id, to) => { moved.push({ id, to }) }
    return { h, state, things, moved }
  }

  it('an id is an entity, and it starts where the document says', async () => {
    const { h } = placedHost()
    let e: number | null = null
    await play(defineGame({ setup: (api) => { e = api.placed('p-01') } }), h, 0.1)
    expect(e).not.toBe(null)
    expect(Transform.x[e!]).toBe(10)
    expect(Transform.y[e!]).toBe(20)
    expect(Transform.yaw[e!]).toBeCloseTo(Math.PI / 2, 5)
  })

  it('asking twice gives the SAME entity', async () => {
    // `api.placed(...)` in an `each` runs sixty times a second; a new entity each time is a leak
    // that fills the world in under a minute
    const { h } = placedHost()
    const seen = new Set<number>()
    await play(defineGame({ setup: (api) => { api.each(() => { seen.add(api.placed('p-01')!) }) } }), h, 1)
    expect(seen.size).toBe(1)
  })

  it('an id that is not there is null, not a throw', async () => {
    const { h } = placedHost()
    let e: number | null = -1
    await play(defineGame({ setup: (api) => { e = api.placed('nope') } }), h, 0.1)
    expect(e).toBe(null)
  })

  it('a tag finds every one that carries it', async () => {
    const { h } = placedHost()
    let farm: number[] = []
    let barn: number[] = []
    await play(defineGame({ setup: (api) => { farm = api.placedWith('farm'); barn = api.placedWith('barn') } }), h, 0.1)
    expect(farm.length).toBe(2)
    expect(barn.length).toBe(1)
  })

  it('MOVING THE ENTITY MOVES THE THING — that is the whole point', async () => {
    const { h, moved } = placedHost()
    await play(defineGame({
      setup: (api) => {
        const e = api.placed('p-01')!
        api.after(0.1, () => { Transform.x[e] = 100; Transform.yaw[e] = Math.PI })
      },
    }), h, 0.5)
    expect(moved.length).toBeGreaterThan(0)
    expect(moved[0].id).toBe('p-01')
    expect(moved[0].to.x).toBe(100)
    expect(moved[0].to.yaw_deg).toBeCloseTo(180, 3)
  })

  it('and something that did not move is not told to', async () => {
    // this runs every tick over every placement a program has touched; telling the viewer to put
    // an object exactly where it already is rebuilds a matrix per frame per prop for nothing
    const { h, moved } = placedHost()
    await play(defineGame({ setup: (api) => { api.placed('p-01'); api.placed('p-02') } }), h, 1)
    expect(moved).toEqual([])
  })

  it('a host with no placements answers null rather than breaking', async () => {
    // a dry run has no world behind it, and a program written against one must still load
    const { h } = host()
    let e: number | null = -1
    let all: unknown[] = [1]
    await play(defineGame({ setup: (api) => { e = api.placed('p-01'); all = api.placements() } }), h, 0.1)
    expect(e).toBe(null)
    expect(all).toEqual([])
  })
})

/*
 * PHYSICS, INCLUDING WHEN THERE IS NONE.
 *
 * `api.physics` is the seam the editor and the engine meet at (PLAN-EDITOR-IDE.md §4). The rule
 * that makes it safe is that a dry run has no physics world — `program.ts` holds no wasm on
 * purpose — so every call has to do nothing rather than throw. A program written against physics
 * must still LOAD and STEP where there is none, or the toolkit that checks levels cannot check
 * the levels that matter.
 */
describe('physics, through the host', () => {
  const physHost = () => {
    const { h } = host()
    const log: string[] = []
    h.physics = {
      setProfile: (id, o) => log.push(`profile ${id} ${JSON.stringify(o ?? {})}`),
      blendProfile: (id, t) => log.push(`blend ${id} ${t}`),
      setEntityProfile: (e, id) => log.push(`entity ${e} ${id}`),
      explode: (at, o) => { log.push(`explode ${at.x},${at.y} r${o.radius}`); return 3 },
      impulse: (e, v) => log.push(`impulse ${e} ${v.x}`),
      break: (what) => { log.push(`break ${what}`); return 2 },
      ray: () => ({ entity: 7, point: { x: 1, y: 2, z: 3 }, normal: { x: 0, y: 0, z: 1 } }),
      car: () => ({ speed: 22, slide: 0.4, slip: 0.1, wheelslip: 0, grounded: 4, airborne: false, damage: 0.2 }),
      onImpact: (fn) => log.push(`onImpact ${typeof fn}`),
    }
    return { h, log }
  }

  it('a program with no physics behind it still runs', async () => {
    const { h } = host()
    let saw: unknown[] = []
    const run = await play(defineGame({
      setup: (api) => {
        saw = [api.physics.available(), api.physics.car(), api.physics.explode({ x: 0, y: 0, z: 0 }, { radius: 5, impulse: 1 }), api.physics.break('x')]
        api.physics.profile('street')
        api.physics.impulse(1, { x: 0, y: 0, z: 1 })
      },
    }), h, 0.2)
    expect(run.error).toBe(null)
    expect(saw).toEqual([false, null, 0, 0])
  })

  it('and with one, every call reaches it', async () => {
    const { h, log } = physHost()
    let car: unknown = null
    let hit: unknown = null
    await play(defineGame({
      setup: (api) => {
        api.physics.profile('street', { gripRear: 1.1 })
        api.physics.blend('sim', 0.5)
        api.physics.entityProfile(4, 'rush')
        api.physics.explode({ x: 10, y: 20, z: 0 }, { radius: 8, impulse: 900 })
        api.physics.impulse(4, { x: 0, y: 0, z: 5 })
        api.physics.break('sign-01')
        api.physics.onImpact(() => {})
        car = api.physics.car()
        hit = api.physics.ray({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }, 10)
      },
    }), h, 0.2)
    expect(log).toEqual([
      'profile street {"gripRear":1.1}',
      'blend sim 0.5',
      'entity 4 rush',
      'explode 10,20 r8',
      'impulse 4 0',
      'break sign-01',
      'onImpact function',
    ])
    expect((car as { speed: number }).speed).toBe(22)
    expect((hit as { entity: number }).entity).toBe(7)
  })

  it('a NaN never reaches the engine', async () => {
    // `explode` with a radius of NaN is a query over the whole world, and a program is code from
    // a person or an agent
    const { h, log } = physHost()
    let n = -1
    await play(defineGame({
      setup: (api) => {
        n = api.physics.explode({ x: 0, y: NaN, z: 0 }, { radius: 5, impulse: 1 })
        api.physics.explode({ x: 0, y: 0, z: 0 }, { radius: Number.NaN, impulse: 1 })
        api.physics.impulse(1, { x: Infinity, y: 0, z: 0 })
        api.physics.ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, NaN)
      },
    }), h, 0.2)
    expect(n).toBe(0)
    expect(log).toEqual([])
  })

  it('a throw inside an impact handler stops the program, not the frame loop', async () => {
    const { h } = physHost()
    let handler: ((e: { a: number; b: number; point: { x: number; y: number; z: number }; impulse: number }) => void) | null = null
    h.physics!.onImpact = (fn) => { handler = fn }
    const run = await play(defineGame({ setup: (api) => api.physics.onImpact(() => { throw new Error('boom') }) }), h, 0.2)
    expect(run.error).toBe(null)
    handler!({ a: 1, b: 2, point: { x: 0, y: 0, z: 0 }, impulse: 10 })
    expect(run.error).toMatch(/boom/)
  })
})

/*
 * COMBAT, through the host — the same rule as physics, one layer up.
 *
 * `api.arm` names a weapon in the asset library rather than describing one, so a program and the
 * library cannot drift. And a dry run has no combat host at all, so every call has to do nothing
 * rather than throw: a program that arms somebody must still be a program you can step in a test.
 */
describe('combat, through the host', () => {
  function armed() {
    const { h } = host()
    const held = new Map<number, string>()
    const shots: { entity: number; dir: unknown }[] = []
    h.combat = {
      arm: (e, id) => { if (id !== 'pistol-9mm') return false; held.set(e, id); return true },
      armed: (e) => held.get(e) ?? null,
      fire: (e, dir) => { shots.push({ entity: e, dir }); return { entity: 7, point: { x: 1, y: 0, z: 2 }, damage: 24 } },
      damage: () => 76,
    }
    return { h, held, shots }
  }

  it('a program with no combat behind it still runs', async () => {
    const { h } = host()
    let saw: unknown[] = []
    await play({
      setup: (api) => {
        saw = [api.arm(1, 'pistol-9mm'), api.armed(1), api.fire(1, { x: 1, y: 0, z: 0 }), api.hurt(1, 10)]
      },
    }, h, 0.2)
    expect(saw).toEqual([false, null, null, 0])
  })

  it('arms from the library by id, and refuses one that is not there', async () => {
    const { h, held } = armed()
    let saw: unknown[] = []
    await play({ setup: (api) => { saw = [api.arm(3, 'pistol-9mm'), api.arm(3, 'raygun'), api.armed(3)] } }, h, 0.2)
    expect(saw).toEqual([true, false, 'pistol-9mm'])
    expect(held.get(3)).toBe('pistol-9mm')
  })

  it('refuses an empty or non-string weapon id rather than passing it on', async () => {
    const { h, shots } = armed()
    let saw: unknown[] = []
    await play({
      setup: (api) => {
        saw = [api.arm(1, ''), api.arm(1, null as unknown as string), api.arm(1, 5 as unknown as string)]
      },
    }, h, 0.2)
    expect(saw).toEqual([false, false, false])
    expect(shots).toEqual([])
  })

  it('fires in a direction, and does nothing at all given a direction that is not one', async () => {
    const { h, shots } = armed()
    let hit: unknown = null
    let bad: unknown = 'unset'
    await play({
      setup: (api) => {
        hit = api.fire(4, { x: 0, y: 0, z: 1 })
        bad = api.fire(4, { x: NaN, y: 0, z: 1 })
      },
    }, h, 0.2)
    expect(hit).toEqual({ entity: 7, point: { x: 1, y: 0, z: 2 }, damage: 24 })
    expect(bad).toBeNull()
    expect(shots).toHaveLength(1) // the bad one never reached the host
  })

  it('hurts something and hands back what it has left', async () => {
    const { h } = armed()
    let left: unknown = null
    let nan: unknown = null
    await play({ setup: (api) => { left = api.hurt(2, 24); nan = api.hurt(2, NaN) } }, h, 0.2)
    expect(left).toBe(76)
    expect(nan).toBe(0)
  })
})
