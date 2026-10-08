// The test rig drives a path on its own (game/session/testrig.ts). A toy car that integrates the
// rig's own input is enough to show it follows a bend, keeps its lane, reads the traffic's
// direction, fires on its cadence, and puts a stuck car back on the road.
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { TestRig, type RigHost } from '../src/game/session/testrig'
import type { CarInput, DrivableCar } from '../src/game/vehicle/car'

/** a bicycle model: yaw turns with steer, speed follows the pedals */
function toyCar(): DrivableCar & { step(input: CarInput, dt: number): void } {
  const car = {
    pos: new THREE.Vector3(),
    forward: new THREE.Vector3(1, 0, 0),
    right: new THREE.Vector3(0, 0, 1),
    yaw: 0,
    speed: 0,
    slide: 0,
    onGrass: false,
    event: 'none' as DrivableCar['event'],
    mesh: new THREE.Group(),
    lampLevel: 0,
    place(x: number, z: number, yaw: number) {
      car.pos.set(x, 0, z)
      car.yaw = yaw
      car.speed = 0
      car.forward.set(Math.cos(yaw), 0, Math.sin(yaw))
    },
    recover() {},
    tick() {},
    setLights() {},
    setCockpit() {},
    lamps: () => ({ each: [], on: 0 }),
    streaks: () => [],
    floodLamps: () => [],
    step(input: CarInput, dt: number) {
      car.speed = Math.max(0, car.speed + (input.throttle * 6 - input.brake * 10 - 0.3) * dt)
      car.yaw += input.steer * 0.9 * Math.min(1, car.speed / 8) * dt
      car.forward.set(Math.cos(car.yaw), 0, Math.sin(car.yaw))
      car.pos.addScaledVector(car.forward, car.speed * dt)
    },
  }
  return car
}

/** a path: 600 m east, then a 300 m-radius quarter turn to the south */
function bendPath(): [number, number][] {
  const pts: [number, number][] = []
  for (let x = 0; x <= 600; x += 10) pts.push([x, 0])
  for (let a = 1; a <= 30; a++) {
    const t = (a / 30) * (Math.PI / 2)
    pts.push([600 + 300 * Math.sin(t), 300 - 300 * Math.cos(t)])
  }
  return pts
}

function host(car: ReturnType<typeof toyCar>, over: Partial<RigHost> = {}): RigHost & { fired: THREE.Vector3[] } {
  const fired: THREE.Vector3[] = []
  return {
    fired,
    path: () => bendPath(),
    car: () => car,
    ensureDriving: () => {},
    trafficNear: () => [],
    targetAhead: () => null,
    fire: (dir) => { fired.push(dir ?? car.forward.clone()); return true },
    ...over,
  }
}

function run(rig: TestRig, car: ReturnType<typeof toyCar>, seconds: number, dt = 1 / 60): number {
  const input: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false }
  let maxOff = 0
  for (let t = 0; t < seconds; t += dt) {
    rig.drive(car, input, dt)
    rig.tickFire(dt)
    car.step(input, dt)
    maxOff = Math.max(maxOff, rig.stats().maxOff)
  }
  return maxOff
}

describe('the test rig', () => {
  it('follows the bend in its lane at the speed asked', () => {
    const car = toyCar()
    const rig = new TestRig(host(car))
    expect(rig.start({ speed: 20, fireEvery: 0, lane: 3 })).toBe(true)
    // placed in the lane: 3 m right of travel (east → right is south, +z)
    expect(car.pos.z).toBeCloseTo(3, 5)
    run(rig, car, 50)
    const st = rig.stats()
    expect(st.distance).toBeGreaterThan(700) // round the bend
    expect(st.maxOff).toBeLessThan(2.5) // and in its lane the whole way
    expect(st.resets).toBe(0)
    expect(st.speed).toBeGreaterThan(8)
    expect(st.speed).toBeLessThanOrEqual(20.5)
  })

  it('drives the path backwards when the traffic beside it does', () => {
    const car = toyCar()
    // every car on the road faces west (yaw π), 8 m off the line; one far-off car faces east
    const traffic = [100, 200, 300].map((x) => ({ x, z: 8, yaw: Math.PI }))
    traffic.push({ x: 300, z: 200, yaw: 0 })
    const rig = new TestRig(host(car, { trafficNear: () => traffic }))
    car.place(300, 0, 0)
    rig.start({ speed: 15, fireEvery: 0 })
    expect(rig.stats().reversed).toBe(true)
    // facing west now, from where it was
    expect(Math.cos(car.yaw)).toBeLessThan(-0.99)
    expect(car.pos.x).toBeCloseTo(300, 0)
  })

  it('fires on its cadence at the car ahead, and down the nose with nobody there', () => {
    const car = toyCar()
    let ahead: THREE.Vector3 | null = new THREE.Vector3(60, 0, 5)
    const h = host(car, { targetAhead: () => ahead })
    const rig = new TestRig(h)
    rig.start({ speed: 20, fireEvery: 0.5 })
    run(rig, car, 2.05)
    expect(h.fired.length).toBe(4)
    // aimed off the nose toward the target, which sits to the right (+z) of the line
    expect(h.fired[0].z).toBeGreaterThan(0.01)
    ahead = null
    run(rig, car, 1.1) // a hair over two cadences: sixty steps of 1/60 fall a rounding short of 1 s
    expect(h.fired.length).toBe(6)
    expect(rig.stats().fired).toBe(6)
  })

  it('puts a car that stopped moving back on the road, a little further along', () => {
    const car = toyCar()
    const rig = new TestRig(host(car))
    rig.start({ speed: 20, fireEvery: 0 })
    // a car that will not move however hard the pedal is pressed
    car.step = () => {}
    const input: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false }
    for (let t = 0; t < 6; t += 1 / 60) rig.drive(car, input, 1 / 60)
    expect(rig.stats().resets).toBeGreaterThanOrEqual(1)
    expect(car.pos.x).toBeGreaterThan(5)
  })

  it('does nothing without a path', () => {
    const car = toyCar()
    const rig = new TestRig(host(car, { path: () => null }))
    expect(rig.start()).toBe(false)
    expect(rig.on).toBe(false)
  })
})
