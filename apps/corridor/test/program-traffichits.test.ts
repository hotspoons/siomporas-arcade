// A level hears what its guns did to the traffic, and can hit a car itself.
//
// Rich, 2026-10-08: cash should fly at the car for every gun and missile hit — "$20 for making a
// car swerve to $200 for blowing it into the sky" — on top of the knock, not instead of it. The
// knock is the app's; the program's part is to hear each hit and what it did, find the cars, hit one
// itself, and say how hard the weapons are. These hold that seam: every call reaches the host, a
// bad number is refused at the boundary, a dry run answers harmlessly, and everything a program
// changed is undone when it stops.
import { describe, expect, it } from 'vitest'
import { ActorWorld } from '../src/game/actors/actorworld'
import { GameRun, defineGame, type GameDef, type ProgramHost, type TrafficHitInfo, type WeaponTuning } from '../src/game/session/program'

const DEFAULTS: Required<WeaponTuning> = { gunImpulse: 7, gunDamage: 0.12, missileImpulse: 30, missileRadius: 11, missileLift: 1.1, missileDamage: 0.9 }

function host() {
  const log: string[] = []
  const listeners = new Set<(e: TrafficHitInfo) => void>()
  let override: WeaponTuning = {}
  const h: ProgramHost = {
    actors: new ActorWorld(),
    hide: () => {},
    transport: () => {},
    preset: () => {},
    say: () => {},
    playerAt: () => ({ x: 0, y: 0, z: 0 }),
    playerSpeed: () => 0,
    physics: {
      weapons: (set) => {
        override = set === null ? {} : { ...override, ...set }
        log.push(`weapons ${JSON.stringify(set)}`)
        return { ...DEFAULTS, ...override }
      },
    },
    layers: {
      trafficCars: (near, radius, max) => {
        log.push(`cars ${near ? `${near.x},${near.y}` : 'player'} r${radius} max${max}`)
        return [{ entity: 12, x: 5, y: 40, z: 0, heading_deg: 0, speed: 20, loose: false }]
      },
      trafficHit: (e, hit) => {
        log.push(`hit ${e} f${hit.force}`)
        return hit.force >= 24 ? 'loose' : 'swerve'
      },
      onTrafficHit: (fn) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    },
  }
  const emit = (e: TrafficHitInfo) => { for (const fn of listeners) fn(e) }
  return { h, log, listeners, emit, weapons: () => ({ ...DEFAULTS, ...override }) }
}

async function play(def: GameDef, h: ProgramHost, seconds = 0.1): Promise<GameRun> {
  const run = new GameRun(h, def)
  await run.start()
  for (let t = 0; t < seconds; t += 1 / 60) run.tick(1 / 60)
  return run
}

describe('traffic hits, through the host', () => {
  it('a program hears every hit with what it did, and stops hearing when it stops', async () => {
    const { h, listeners, emit } = host()
    const heard: string[] = []
    const run = await play(defineGame({
      setup: (api) => api.traffic.onHit((e) => heard.push(`${e.weapon}:${e.effect}:$${e.effect === 'launched' ? 200 : e.effect === 'loose' ? 100 : 20}`)),
    }), h)
    expect(listeners.size).toBe(1)
    emit({ entity: 3, effect: 'swerve', force: 7, weapon: 'gun', at: { x: 0, y: 10, z: 0 } })
    emit({ entity: 3, effect: 'launched', force: 30, weapon: 'missile', at: { x: 0, y: 10, z: 0 } })
    expect(heard).toEqual(['gun:swerve:$20', 'missile:launched:$200'])
    run.stop()
    expect(listeners.size).toBe(0)
  })

  it('a listener that throws stops the program, not the frame loop', async () => {
    const { h, emit } = host()
    const run = await play(defineGame({ setup: (api) => api.traffic.onHit(() => { throw new Error('boom') }) }), h)
    expect(() => emit({ entity: 1, effect: 'swerve', force: 1, weapon: 'gun', at: { x: 0, y: 0, z: 0 } })).not.toThrow()
    expect(run.error).toBe('boom')
  })

  it('cars and hit reach the host; bad numbers are refused at the boundary', async () => {
    const { h, log } = host()
    let got: unknown[] = []
    await play(defineGame({
      setup: (api) => {
        const cars = api.traffic.cars()
        got = [
          cars.map((c) => c.entity),
          api.traffic.hit(12, { force: 7 }),
          api.traffic.hit(12, { force: 40, damage: 0.5 }),
          api.traffic.hit(12, { force: Number.NaN }),
          api.traffic.hit(12, { force: 5, dir: { x: 0, y: Number.POSITIVE_INFINITY, z: 0 } }),
        ]
        api.traffic.cars({ near: { x: 100, y: 200 }, radius: 50, max: 3 })
      },
    }), h)
    expect(got).toEqual([[12], 'swerve', 'loose', null, null])
    expect(log).toEqual(['cars player r300 max50', 'hit 12 f7', 'hit 12 f40', 'cars 100,200 r50 max3'])
  })

  it('a level sets its weapons, and the defaults come back when it stops', async () => {
    const { h, log, weapons } = host()
    let inForce: Required<WeaponTuning> | null = null
    const run = await play(defineGame({
      setup: (api) => {
        inForce = api.physics.weapons({ gunImpulse: 12, missileImpulse: 45, gunDamage: Number.NaN })
      },
    }), h)
    expect(inForce).toEqual({ ...DEFAULTS, gunImpulse: 12, missileImpulse: 45 })
    expect(log[0]).toBe('weapons {"gunImpulse":12,"missileImpulse":45}') // the NaN never reached it
    run.stop()
    expect(weapons()).toEqual(DEFAULTS)
    expect(log.at(-1)).toBe('weapons null')
  })

  it('a dry run with no traffic and no physics answers harmlessly', async () => {
    const h: ProgramHost = { actors: new ActorWorld(), hide: () => {}, transport: () => {}, preset: () => {}, say: () => {}, playerAt: () => null, playerSpeed: () => 0 }
    let got: unknown[] = []
    const run = await play(defineGame({
      setup: (api) => {
        api.traffic.onHit(() => {})
        got = [api.traffic.cars(), api.traffic.hit(1, { force: 50 }), api.physics.weapons({ gunImpulse: 3 }).gunImpulse]
      },
    }), h)
    expect(run.error).toBe(null)
    expect(got).toEqual([[], null, 0])
    expect(() => run.stop()).not.toThrow()
  })
})
