// Does "an enemy can take any form" actually hold, and does the world step the way it claims?
//
// The first is Rich's design claim and the reason this is an ECS rather than a class hierarchy, so
// it is the thing to test: the code that hunts you must find a hostile car, a hostile dog and a
// hostile person with ONE query that mentions none of them.
import { describe, expect, it } from 'vitest'
import { addComponent, addEntity, hasComponent, query, removeComponent, getRelationTargets, removeEntity } from 'bitecs'
import { Animal, AttachedTo, Autonomous, DrivenBy, Health, Hostile, Human, MemberOf, Player, SETS, Transform, Vehicle, Velocity, Visual, Walking } from '../src/actors'
import { ActorWorld, STEP_S, face, integrate, mortality, spawnPedestrian, spawnVehicle, walk } from '../src/actorworld'

describe('an enemy can take any form', () => {
  it('one query finds hostiles whatever they are attached to', () => {
    const aw = new ActorWorld()
    const w = aw.world
    const car = spawnVehicle(aw, { x: 10, y: 0 }, { hostile: true })
    const dog = addEntity(w)
    addComponent(w, dog, Transform)
    addComponent(w, dog, Animal)
    addComponent(w, dog, Hostile)
    const thug = spawnPedestrian(aw, { x: 30, y: 0 }, { x: 40, y: 0 }, { hostile: true })
    spawnVehicle(aw, { x: 50, y: 0 })
    spawnPedestrian(aw, { x: 60, y: 0 }, { x: 70, y: 0 })
    const deer = addEntity(w)
    addComponent(w, deer, Transform)
    addComponent(w, deer, Animal)

    const threats = [...query(w, SETS.threats)]
    expect(threats.length).toBe(3)
    // and the query said nothing about cars, dogs or people
    expect(threats).toContain(car)
    expect(threats).toContain(dog)
    expect(threats).toContain(thug)
    expect(threats).not.toContain(deer)
  })

  it('something becomes hostile by GAINING a component, not by being replaced', () => {
    const aw = new ActorWorld()
    const taxi = spawnVehicle(aw, { x: 0, y: 0 }, { asset: 7 })
    expect(query(aw.world, SETS.threats).length).toBe(0)
    addComponent(aw.world, taxi, Hostile)
    Hostile.faction[taxi] = 3
    // the SAME entity: its position, its asset and its health all survive the change
    expect([...query(aw.world, SETS.threats)]).toEqual([taxi])
    expect(Visual.asset[taxi]).toBe(7)
    expect(Health.hp[taxi]).toBe(100)
    expect(Hostile.faction[taxi]).toBe(3)
  })

  it('a traffic vehicle can be handed to a player without becoming a different thing', () => {
    const aw = new ActorWorld()
    const car = spawnVehicle(aw, { x: 5, y: 5 }, { asset: 2 })
    expect(hasComponent(aw.world, car, Autonomous)).toBe(true)
    removeComponent(aw.world, car, Autonomous)
    addComponent(aw.world, car, Player)
    expect(query(aw.world, [Vehicle, Autonomous]).length).toBe(0)
    expect(query(aw.world, [Vehicle, Player]).length).toBe(1)
    expect(Transform.x[car]).toBe(5) // it did not move by changing hands
  })
})

describe('relations say what a field cannot', () => {
  it('a vehicle knows its driver, and loses them when they stop existing', () => {
    const aw = new ActorWorld()
    const w = aw.world
    const car = spawnVehicle(aw, { x: 0, y: 0 })
    const driver = spawnPedestrian(aw, { x: 0, y: 0 }, { x: 1, y: 0 })
    addComponent(w, car, DrivenBy(driver))
    expect([...getRelationTargets(w, car, DrivenBy)]).toEqual([driver])

    // THE POINT OF A RELATION OVER AN ID IN A FIELD: the driver is destroyed and the car is not
    // left steered by a dangling reference to somebody who stopped existing.
    removeEntity(w, driver)
    expect(aw.alive(car)).toBe(true) // an empty car is a thing that sits there
    expect([...getRelationTargets(w, car, DrivenBy)]).toEqual([])
    expect(hasComponent(w, car, Vehicle)).toBe(true) // and it is still a car
  })

  it('a trailer does NOT hang in the air where its truck used to be', () => {
    const aw = new ActorWorld()
    const w = aw.world
    const truck = spawnVehicle(aw, { x: 0, y: 0 })
    const trailer = spawnVehicle(aw, { x: -8, y: 0 })
    addComponent(w, trailer, AttachedTo(truck))
    // `withAutoRemoveSubject`, which is right HERE and wrong for a driver — the flag destroys the
    // subject when the target dies, which I had backwards until the test above said so
    removeEntity(w, truck)
    expect(aw.alive(trailer)).toBe(false)
  })

  it('a faction is an entity, so anything can belong to it', () => {
    const aw = new ActorWorld()
    const w = aw.world
    const mob = addEntity(w)
    const goon = spawnPedestrian(aw, { x: 0, y: 0 }, { x: 1, y: 0 }, { hostile: true })
    const getaway = spawnVehicle(aw, { x: 2, y: 0 }, { hostile: true })
    const guardDog = addEntity(w)
    addComponent(w, guardDog, Transform)
    addComponent(w, guardDog, Animal)
    addComponent(w, guardDog, Hostile)
    for (const e of [goon, getaway, guardDog]) addComponent(w, e, MemberOf(mob))
    // one query, three shapes
    expect(query(w, [MemberOf(mob)]).length).toBe(3)
  })
})

describe('the world steps', () => {
  it('runs a whole number of fixed steps and carries the remainder', () => {
    const aw = new ActorWorld().add('integrate', integrate)
    const e = spawnVehicle(aw, { x: 0, y: 0 })
    Velocity.x[e] = 10
    expect(aw.tick(0.025)).toBe(1) // 25 ms buys one 20 ms step
    expect(Transform.x[e]).toBeCloseTo(10 * STEP_S, 5)
    expect(aw.tick(0.015)).toBe(1) // the carried 5 ms plus 15 makes the next one
    expect(Transform.x[e]).toBeCloseTo(10 * STEP_S * 2, 5)
  })

  it('a long stall does not become a burst', () => {
    const aw = new ActorWorld().add('integrate', integrate)
    const e = spawnVehicle(aw, { x: 0, y: 0 })
    Velocity.x[e] = 10
    expect(aw.tick(10)).toBe(5) // ten seconds of stall: five steps, not five hundred
    expect(Transform.x[e]).toBeCloseTo(10 * STEP_S * 5, 5)
  })

  it('walkers arrive and stop', () => {
    const aw = new ActorWorld().add('walk', walk).add('integrate', integrate).add('face', face)
    const p = spawnPedestrian(aw, { x: 0, y: 0 }, { x: 10, y: 0 })
    for (let i = 0; i < 500; i++) aw.tick(STEP_S)
    expect(Transform.x[p]).toBeGreaterThan(9)
    expect(Transform.x[p]).toBeLessThanOrEqual(10.5)
    expect(Velocity.x[p]).toBe(0) // stopped, not circling
    expect(Transform.yaw[p]).toBeCloseTo(Math.PI / 2, 1) // facing the way it went
  })

  it('the dead are removed once, at the end of a step', () => {
    const aw = new ActorWorld().add('mortality', mortality)
    const e = spawnVehicle(aw, { x: 0, y: 0 })
    Health.hp[e] = 0
    expect(query(aw.world, [Transform]).length).toBe(1)
    aw.tick(STEP_S)
    expect(query(aw.world, [Transform]).length).toBe(0)
    expect(aw.alive(e)).toBe(false)
  })

  it('a level change leaves no ghosts', () => {
    const aw = new ActorWorld().add('integrate', integrate)
    for (let i = 0; i < 50; i++) spawnVehicle(aw, { x: i, y: 0 })
    expect(query(aw.world, [Vehicle]).length).toBe(50)
    aw.clear()
    expect(query(aw.world, [Transform]).length).toBe(0)
    expect(query(aw.world, [Vehicle]).length).toBe(0)
  })

  it('reports what each system cost, so a slow one can be named', () => {
    const aw = new ActorWorld().add('integrate', integrate).add('walk', walk)
    for (let i = 0; i < 200; i++) spawnPedestrian(aw, { x: i, y: 0 }, { x: 0, y: 0 })
    aw.tick(STEP_S)
    expect(Object.keys(aw.stats.systems).sort()).toEqual(['integrate', 'walk'])
    expect(aw.stats.actors).toBe(200)
  })

  it('carries thousands of actors inside a frame', () => {
    const aw = new ActorWorld().add('integrate', integrate).add('face', face)
    for (let i = 0; i < 10000; i++) {
      const e = spawnVehicle(aw, { x: i % 500, y: Math.floor(i / 500) })
      Velocity.x[e] = 12
    }
    // WARM FIRST. The first query over a new set of components builds it, and that one-off cost
    // landed in the measurement: 10.4 ms for a step that costs 0.03 ms afterwards. A benchmark
    // that includes a cache miss it will never pay again is measuring the wrong thing.
    aw.tick(STEP_S)
    expect(aw.stats.actors).toBe(10000)
    /*
     * THE BEST OF FIVE, not one.
     *
     * The measured figure is ~0.03 ms and the budget is 8, so this is not a close call — and it
     * still failed in a full run while the other suites had the machine. A single sample of a
     * wall-clock measurement on a shared box measures the scheduler as much as the code: one
     * preemption inside the step and the number is whatever the rest of the test run was doing.
     * The claim is "this can be done in a frame", and the fastest of a handful of attempts is the
     * honest way to ask that of a machine that is also doing something else.
     */
    let best = Infinity
    for (let i = 0; i < 5; i += 1) {
      aw.tick(STEP_S)
      best = Math.min(best, aw.stats.lastMs)
    }
    // generous, because a CI box is not a GPU box — the measured figure is ~0.03 ms
    expect(best).toBeLessThan(8)
  })
})
