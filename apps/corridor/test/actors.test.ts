// Does "an enemy can take any form" actually hold, and does the world step the way it claims?
//
// The first is the design claim Rich made and the reason this is an ECS rather than a class
// hierarchy, so it is the thing to test: the code that hunts you must find a hostile car, a
// hostile dog and a hostile person with ONE query that mentions none of them.
import { describe, expect, it } from 'vitest'
import { Animal, Autonomous, Doomed, Health, Hostile, Human, Player, SETS, Transform, Vehicle, Velocity, Visual, Walking } from '../src/actors'
import { ActorWorld, STEP_S, face, integrate, mortality, spawnPedestrian, spawnVehicle, walk } from '../src/actorworld'

describe('an enemy can take any form', () => {
  it('one query finds hostiles whatever they are attached to', () => {
    const aw = new ActorWorld()
    const w = aw.world
    // a hostile driver in a car, a hostile dog, a hostile person on foot, and three innocents
    const car = spawnVehicle(aw, { x: 10, y: 0 }, { hostile: true })
    const dog = w.spawn(Transform({ x: 20, y: 0 }), Animal({ species: 'dog' }), Hostile())
    const thug = spawnPedestrian(aw, { x: 30, y: 0 }, { x: 40, y: 0 }, { hostile: true })
    spawnVehicle(aw, { x: 50, y: 0 })
    spawnPedestrian(aw, { x: 60, y: 0 }, { x: 70, y: 0 })
    w.spawn(Transform({ x: 80, y: 0 }), Animal({ species: 'deer' }))

    const threats = w.query(...SETS.threats)
    expect(threats.length).toBe(3)
    // and the query said nothing about cars, dogs or people
    const ids = new Set(threats.map((e) => e.id()))
    expect(ids.has(car.id())).toBe(true)
    expect(ids.has(dog.id())).toBe(true)
    expect(ids.has(thug.id())).toBe(true)
  })

  it('something becomes hostile by GAINING a trait, not by being replaced', () => {
    const aw = new ActorWorld()
    const taxi = spawnVehicle(aw, { x: 0, y: 0 }, { asset: 'traffic-taxi' })
    expect(aw.world.query(...SETS.threats).length).toBe(0)
    taxi.add(Hostile({ faction: 'mob', aggression: 2 }))
    // the SAME entity: its position, its asset and its health all survive the change
    expect(aw.world.query(...SETS.threats)[0].id()).toBe(taxi.id())
    expect(taxi.get(Visual)!.asset).toBe('traffic-taxi')
    expect(taxi.get(Hostile)!.faction).toBe('mob')
  })

  it('a traffic vehicle can be handed to a player without becoming a different thing', () => {
    const aw = new ActorWorld()
    const car = spawnVehicle(aw, { x: 5, y: 5 }, { asset: 'rx7-fd' })
    expect(car.has(Autonomous)).toBe(true)
    car.remove(Autonomous)
    car.add(Player)
    expect(aw.world.query(Vehicle, Autonomous).length).toBe(0)
    expect(aw.world.query(Vehicle, Player).length).toBe(1)
    expect(car.get(Transform)!.x).toBe(5) // it did not move by changing hands
  })
})

describe('the world steps', () => {
  it('runs a whole number of fixed steps and carries the remainder', () => {
    const aw = new ActorWorld().add('integrate', integrate)
    const e = aw.world.spawn(Transform, Velocity({ x: 10 }))
    // 25 ms buys one 20 ms step; the 5 ms left over is carried, not dropped
    expect(aw.tick(0.025)).toBe(1)
    expect(e.get(Transform)!.x).toBeCloseTo(10 * STEP_S, 6)
    // 15 ms more makes 20: a second step, with nothing lost to rounding
    expect(aw.tick(0.015)).toBe(1)
    expect(e.get(Transform)!.x).toBeCloseTo(10 * STEP_S * 2, 6)
  })

  it('a long stall does not become a burst', () => {
    const aw = new ActorWorld().add('integrate', integrate)
    const e = aw.world.spawn(Transform, Velocity({ x: 10 }))
    // ten seconds of stall: five steps, not five hundred
    expect(aw.tick(10)).toBe(5)
    expect(e.get(Transform)!.x).toBeCloseTo(10 * STEP_S * 5, 6)
  })

  it('walkers arrive and stop', () => {
    const aw = new ActorWorld().add('walk', walk).add('integrate', integrate).add('face', face)
    const p = spawnPedestrian(aw, { x: 0, y: 0 }, { x: 10, y: 0 })
    for (let i = 0; i < 500; i++) aw.tick(STEP_S)
    const t = p.get(Transform)!
    expect(t.x).toBeGreaterThan(9)
    expect(t.x).toBeLessThanOrEqual(10.5)
    expect(p.get(Velocity)!.x).toBe(0) // stopped, not circling
    expect(t.yaw).toBeCloseTo(Math.PI / 2, 1) // facing east, the way it went
  })

  it('the dead are removed once, at the end of a step', () => {
    const aw = new ActorWorld().add('mortality', mortality)
    const e = aw.world.spawn(Transform, Health({ hp: 0 }))
    expect(aw.world.query(Transform).length).toBe(1)
    aw.tick(STEP_S)
    expect(aw.world.query(Transform).length).toBe(0)
    expect(e.isAlive()).toBe(false)
  })

  it('a level change leaves no ghosts', () => {
    const aw = new ActorWorld().add('integrate', integrate)
    for (let i = 0; i < 50; i++) spawnVehicle(aw, { x: i, y: 0 })
    expect(aw.world.query(Vehicle).length).toBe(50)
    aw.clear()
    expect(aw.world.query(Transform).length).toBe(0)
    expect(aw.world.query(Vehicle).length).toBe(0)
  })

  it('reports what each system cost, so a slow one can be named', () => {
    const aw = new ActorWorld().add('integrate', integrate).add('walk', walk)
    for (let i = 0; i < 200; i++) spawnPedestrian(aw, { x: i, y: 0 }, { x: 0, y: 0 })
    aw.tick(STEP_S)
    expect(Object.keys(aw.stats.systems).sort()).toEqual(['integrate', 'walk'])
    expect(aw.stats.actors).toBe(200)
  })
})
