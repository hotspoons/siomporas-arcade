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
