# physics — Rapier in the shared engine

What every game in this repo uses to make things fall over, crash, come apart and be thrown.

```ts
import { loadRapier } from '@apex/engine/physics/rapier'
import { PhysicsWorld } from '@apex/engine/physics/world'
import { Vehicle } from '@apex/engine/physics/vehicle'
import { profile } from '@apex/engine/physics/profiles'

await loadRapier()                                  // once, lazily: it is a 4.3 MB chunk
const phys = new PhysicsWorld({ hz: 120 })
const terrain = new Terrain(phys, site.groundAt)    // heightfield tiles that follow the car
const car = new Vehicle(phys, { massKg: 1400 }, profile('street'))
car.place(x, y, z, yaw)

// per frame
terrain.update(car.body.translation().x, car.body.translation().z)
car.control({ throttle, brake, steer, handbrake })
phys.step(realSeconds)                              // fixed steps, interpolation alpha in phys.alpha
```

| file | what it is |
|---|---|
| `rapier.ts` | the only file allowed to import `@dimforge/rapier3d-compat`. Lazy, cached, one copy |
| `layers.ts` | who collides with what, as one table. Every "it falls through the floor" starts here |
| `world.ts` | the world: fixed step, stall policy, render interpolation, and `Impact` — a contact with a **point** and an **impulse**, which Rapier's own events do not give you |
| `profiles.ts` | the five driving characters: `stunts`, `taxi`, `street`, `rush`, `sim` |
| `vehicle.ts` | a raycast vehicle plus the assist layer that makes those five feel different |
| `terrain.ts` | heightfield tiles built from a height **function**, and the static shapes that stand on them |
| `destruction.ts` | `Breakables` (fixed until hit hard enough), `explode`, `Debris` (a budgeted pool) |
| `deform.ts` | dents: impact-driven vertex displacement that accumulates and can be repaired |
| `ragdoll.ts` | limbs and joints from a pose, for the moment an animated character stops being animated |

## The one idea

**`yawAssist`** in `profiles.ts` is the arcade↔simulator axis, and everything else follows from it.
0 means the tyres decide how fast the car rotates; 1 means the wheel does and the tyres only say how
much. The Stunts port is `yawAssist: 1, yawGripLimited: 1` — ask for more than grip allows and you
turn *less*, which is the 1990 model exactly. Read the header of `profiles.ts` before changing a
number in it.

## Traps, all of which fail silently

These are written up at the code that deals with them; they are collected here because each one cost
real time and none of them produces an error message.

1. **A collider is invisible to queries until `world.step` has run.** Queries go through the broad
   phase; the broad phase is updated inside the step. Build colliders, ray-cast, get `null`.
2. **Nothing may be written from inside a query callback.** Rapier holds a borrow on the body set;
   `applyImpulse` or `setBodyType` in there throws inside wasm and *the query swallows it*. An
   explosion sitting on three cars reported "0 moved" with no error anywhere. Collect, then apply.
3. **`addForce` is persistent, not per-step.** It keeps applying until something resets it. 142 N of
   aero drag applied once per step at 120 Hz became 17 kN of drag per second — a car that
   accelerated to 13 m/s at full throttle and then slowed to a stop, still at full throttle. Use
   impulses (`force × dt`).
4. **Rapier's vehicle only traction-limits the SIDE force.** The forward force is `engineForce × dt`
   and passes through whatever `frictionSlip` says, so out of the box there is no wheelspin and ice
   is exactly as fast as tarmac — measured identical to thirteen decimal places. `vehicle.ts` spends
   the friction budget itself.
5. **The heightfield's fast index runs along Z.** `heights[xIndex * n + zIndex]`. The other way round
   builds the terrain transposed, which on a straight road is smooth, plausible and at the wrong
   height.
6. **`DynamicRayCastVehicleController.setIndexForwardAxis` is a setter, not a method.** Rapier
   declares `set setIndexForwardAxis(axis)`, so you assign to it. Calling it is a TypeError; leaving
   it out is a car that drives sideways.
7. **three.js shares `BufferGeometry` between meshes.** Denting one car dents every car built from
   the same geometry. `Deformable` clones on construction.
8. **Naming Rapier's types outside this directory gets you the WRONG COPY.** There are two in the
   repo — 0.21 here, 0.12 at the root via `@types/three` — so an
   `import('@dimforge/rapier3d-compat').Collider` written in an app resolves to the root's and is a
   different type from the one this engine hands back. tsc catches it ("types have separate
   declarations of a private property"), which is the good outcome; the bad one is the same mistake
   at runtime, passing handles between two wasm heaps. Use `ReturnType<typeof someEngineFunction>`,
   or have this module export the type.

## Tests

`test/physics.test.ts` — layers, the world, impacts, the profiles, and the vehicle actually driving.
`test/physics-world.test.ts` — terrain layout, breakables, explosions, debris budget, dents, ragdolls.

Both run headlessly in Node (`npx vitest run --project engine`), because the `-compat` build needs no
browser. Most assertions have a negative twin — the car accelerates on throttle *and does not without
it*; the sign breaks at 28 m/s *and does not at 2 m/s* — because a physics test that only ever checks
`> 0` passes just as happily once the thing under test has stopped running.
