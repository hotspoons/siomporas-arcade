// Can a program name the world's points and painted zones, and spawn something at one?
//
// Rich, 2026-10-10: *"nor no assets we can reference from the library in case we want to spawn
// something at a point for a given condition."* Three things have to hold for that sentence to be a
// program: a point can be looked up by id in site metres, a world name can be the condition
// (`on('enters', 'z-01')` with no `zone()` first), and a spawn at the point reaches the host with
// the point's numbers. And — the discipline every part of this API keeps — all of it is inert,
// never a throw, in a dry run with no world behind it.
import { describe, expect, it, vi } from 'vitest'
import { defineGame, GameRun, POINT_RADIUS_M, type GameApi, type ProgramHost, type WorldPoint } from '../src/game/session/program'
import { ActorWorld } from '../src/game/actors/actorworld'

const POINTS: WorldPoint[] = [
  { id: 'p-03', name: 'The yard', kind: 'spot', x: 100, y: 50, z: 12, yaw_deg: 90 },
  { id: 'finish', name: 'Finish', kind: 'finish', x: -40, y: 0, z: null, yaw_deg: 0, note: 'well driven' },
]
/** a square traffic zone, 0…20 both ways */
const SQUARE: [number, number][] = [[0, 0], [20, 0], [20, 20], [0, 20]]

function world(extra: Partial<ProgramHost> = {}) {
  const aw = new ActorWorld()
  const player = { x: -200, y: -200, z: 0 }
  const host: ProgramHost = {
    actors: aw,
    hide: () => {},
    transport: () => {},
    preset: () => {},
    say: () => {},
    playerAt: () => ({ ...player }),
    playerSpeed: () => 0,
    points: () => POINTS,
    layers: { trafficPolygon: (id) => (id === 'z-01' ? SQUARE : null) },
    ...extra,
  }
  return { host, player }
}

async function start(host: ProgramHost, setup: (api: GameApi) => void): Promise<GameRun> {
  const run = new GameRun(host, defineGame({ setup }))
  expect(await run.start()).toBe(true)
  return run
}

describe('the world\'s named places, by id', () => {
  it('looks a point up in site metres, and lists them all', async () => {
    const { host } = world()
    let got: unknown
    await start(host, (api) => { got = { one: api.point('p-03'), none: api.point('nope'), all: api.points().map((p) => p.id) } })
    expect(got).toEqual({ one: POINTS[0], none: null, all: ['p-03', 'finish'] })
  })

  it('drops a point whose numbers are not numbers rather than handing them to a program', async () => {
    const { host } = world({ points: () => [{ id: 'bad', name: '', kind: 'spot', x: NaN, y: 0, z: null, yaw_deg: 0 }, POINTS[1]] })
    let ids: string[] = []
    await start(host, (api) => { ids = api.points().map((p) => p.id) })
    expect(ids).toEqual(['finish'])
  })

  it('is empty, not broken, with no world behind the run', async () => {
    const { host } = world({ points: undefined, layers: undefined })
    let got: unknown
    const run = await start(host, (api) => {
      got = { p: api.point('p-03'), all: api.points(), inZ: api.in('z-01'), spawned: api.models.spawn('water-tower-01', { x: 0, y: 0 }) }
      api.on('enters', 'z-01', () => api.win())
    })
    run.tick(0.1)
    expect(got).toEqual({ p: null, all: [], inZ: false, spawned: null })
    expect(run.error).toBeNull()
  })
})

describe('a world name is a zone without declaring one', () => {
  it('fires `enters` and `leaves` on a painted traffic zone\'s outline', async () => {
    const { host, player } = world()
    const seen: string[] = []
    const run = await start(host, (api) => {
      api.on('enters', 'z-01', () => seen.push('in'))
      api.on('leaves', 'z-01', () => seen.push('out'))
    })
    run.tick(0.1)
    expect(seen).toEqual([])
    Object.assign(player, { x: 10, y: 10 })
    run.tick(0.1)
    expect(seen).toEqual(['in'])
    // the outline, not its bounding circle: (19, 1) is inside the square and (25, 10) is not
    Object.assign(player, { x: 19, y: 1 })
    run.tick(0.1)
    Object.assign(player, { x: 25, y: 10 })
    run.tick(0.1)
    expect(seen).toEqual(['in', 'out'])
  })

  it('treats a point as a ring of POINT_RADIUS_M around it', async () => {
    const { host, player } = world()
    let arrived = 0
    const run = await start(host, (api) => { api.on('enters', 'p-03', () => arrived++) })
    Object.assign(player, { x: 100 + POINT_RADIUS_M + 1, y: 50 })
    run.tick(0.1)
    expect(arrived).toBe(0)
    Object.assign(player, { x: 100 + POINT_RADIUS_M - 1, y: 50 })
    run.tick(0.1)
    expect(arrived).toBe(1)
  })

  it('answers `in()` for a world name, from the next tick', async () => {
    const { host, player } = world()
    let api!: GameApi
    const run = await start(host, (a) => { api = a })
    Object.assign(player, { x: 5, y: 5 })
    expect(api.in('z-01')).toBe(false) // first asked: watched from now on
    run.tick(0.1)
    expect(api.in('z-01')).toBe(true)
    expect(api.in('no-such-zone')).toBe(false)
  })

  it('lets a declared zone of the same name win, which is how a point gets a bigger ring', async () => {
    const { host, player } = world()
    let arrived = 0
    const run = await start(host, (api) => {
      const at = api.point('p-03')!
      api.zone('p-03', { kind: 'circle', x: at.x, y: at.y, r: 60 })
      api.on('enters', 'p-03', () => arrived++)
    })
    Object.assign(player, { x: 140, y: 50 }) // 40 m off: outside the point's own ring, inside 60
    run.tick(0.1)
    expect(arrived).toBe(1)
  })
})

describe('spawn something at a point for a given condition', () => {
  /*
   * The sentence Rich asked for, as the program the editor's Library row inserts: when the player
   * enters a painted zone, put a library asset at a named point. The host sees the point's own
   * numbers, and the id it answers is what `remove` takes back.
   */
  it('spawns at the point when the player enters the zone, and despawns', async () => {
    const spawn = vi.fn(() => 'm-1')
    const remove = vi.fn(() => true)
    const { host, player } = world({ models: { spawn, remove } })
    let made: string | null = null
    const run = await start(host, (api) => {
      api.on('enters', 'z-01', () => {
        const at = api.point('p-03') ?? api.player()
        if (at) made = api.models.spawn('water-tower-01', at)
      })
      api.on('leaves', 'z-01', () => { if (made) api.models.remove(made) })
    })
    run.tick(0.1)
    expect(spawn).not.toHaveBeenCalled()
    Object.assign(player, { x: 10, y: 10 })
    run.tick(0.1)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith('water-tower-01', expect.objectContaining({ x: 100, y: 50, z: 12, yaw_deg: 90 }))
    expect(made).toBe('m-1')
    Object.assign(player, { x: 50, y: 50 })
    run.tick(0.1)
    expect(remove).toHaveBeenCalledWith('m-1')
    expect(run.error).toBeNull()
  })
})
