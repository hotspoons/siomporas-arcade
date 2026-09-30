// A wreck is a leader; a blind driver has none.
//
// Rich, 2026-09-30: "the traffic AI doesn't know to stop or slow down so cars start piling up".
// The drivers only looked at DRIVEN cars, and a wreck has no driver — so the car that had just
// been knocked loose was invisible to the one behind it. And then: "I wish we could have the
// cars keep piling up in a game mode where all of the drivers are blind".
import { describe, expect, it } from 'vitest'
import { addComponent, removeComponent } from 'bitecs'
import { OnRoad, Vehicle } from '../src/actors'
import { ActorWorld, STEP_S, spawnVehicle } from '../src/actorworld'
import { Driver, SpeedLimit, driveSystem, makeDriver, rng } from '../src/traffic'

function lane(blind = false) {
  const aw = new ActorWorld()
  const w = aw.world
  const rand = rng(3)
  const put = (s: number) => {
    const e = spawnVehicle(aw, { x: 0, y: s, yaw: 0 })
    addComponent(w, e, OnRoad)
    OnRoad.chain[e] = 1
    OnRoad.s[e] = s
    OnRoad.lane[e] = 0
    OnRoad.dir[e] = 0
    Vehicle.lengthM[e] = 4.4
    makeDriver(w, e, rand)
    SpeedLimit.v[e] = 15
    Vehicle.speed[e] = 12
    return e
  }
  const wreck = put(100)
  const behind = put(30)
  // knocked loose: no driver, going nowhere — exactly what `TrafficLayer.wake` leaves behind
  removeComponent(w, wreck, Driver)
  Vehicle.speed[wreck] = 0
  aw.add('drive', driveSystem({ heads: [], blind: () => blind }))
  return { aw, wreck, behind }
}

describe('a wreck in the lane', () => {
  it('stops the driver behind it', () => {
    const { aw, wreck, behind } = lane()
    for (let i = 0; i < 20 / STEP_S; i++) aw.tick(STEP_S)
    expect(OnRoad.s[wreck]).toBe(100)
    expect(OnRoad.s[behind]).toBeLessThan(100 - 4.4)
    expect(Vehicle.speed[behind]).toBeLessThan(0.2)
  })

  it('is driven straight into by a blind one', () => {
    const { aw, wreck, behind } = lane(true)
    for (let i = 0; i < 20 / STEP_S; i++) aw.tick(STEP_S)
    expect(OnRoad.s[behind]).toBeGreaterThan(OnRoad.s[wreck])
    expect(Vehicle.speed[behind]).toBeGreaterThan(10)
  })
})
