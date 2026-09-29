# Physics: Rapier in the engine, and what it is for

**Status:** the engine module is **built and tested**; corridor wiring **steps 1 and 2 done, step 3
started** (2026-09-29). `?phys=1&car=rapier&profile=stunts` drives the viewer's own car on Rapier, through the
same chase camera, cockpit, HUD and engine sound as before. Steps 3–7 are designed here and not
built.
**Audience:** whoever picks up the physics work next — the main agent, or a person.
**Companion:** [`PLAN-EDITOR-IDE.md`](PLAN-EDITOR-IDE.md), which is the same subject from the
editor's side.

---

## What Rich asked for

> I want to integrate rapier into the corridor world simulator, and make a few profiles for driving
> (1990 stunts/4d racing ported from what we have now, arcade racer like crazy taxi, gta4/5ish
> physics, arcade racer like san fransico rush, then simulator) — no need for tire patch simulation
> or anything but I would like it to feel nice.
>
> I do want to have things like bombs and missiles that can blow up traffic and send things flying.
> Need car wrecks and cars wrecking into buildings and trees and street signs and stop lights and
> all that and make it physically accurate. Will also have rigged characters we'll want to add
> physics to as well and maybe some rag doll stuff. Mesh deformation from the impact for cars would
> be awesome too.

Two sentences of that decide the architecture, and they pull in opposite directions. **"Make it
physically accurate"** wants rigid bodies for everything. **"No tyre patch simulation, but it should
feel nice"** says the *car* is not a simulation — it is five different games wearing the same
equations. The whole design is the seam between those.

---

## 1. What is built, in `packages/engine/src/physics/`

Nine files, 117 passing headless tests, no browser needed. `README.md` in that directory is the
reference; this section is why each piece exists.

| file | why it is a file and not a line somewhere else |
|---|---|
| `rapier.ts` | the only importer of `@dimforge/rapier3d-compat`. Lazy: it is a 4.3 MB chunk (the `-compat` build inlines its wasm as base64), so a game that never turns physics on never downloads it |
| `layers.ts` | who collides with what, as a table. Debris does not collide with debris or with your car; projectiles do not detonate on each other; limbs ignore the walking capsule they came from |
| `world.ts` | fixed step, stall policy, render interpolation, and **`Impact`** — a contact with a *point* and an *impulse*, which Rapier's own events do not carry |
| `profiles.ts` | the five driving characters |
| `vehicle.ts` | a raycast vehicle plus the assist layer that makes those five feel different |
| `terrain.ts` | heightfield tiles built from a height **function**, plus static shapes |
| `destruction.ts` | `Breakables`, `explode`, `Debris` |
| `deform.ts` | dents that accumulate and can be repaired |
| `ragdoll.ts` | limbs and joints from a *pose* |

### The one idea: `yawAssist`

Five profiles are not five controllers. They are one controller and one number.

```
yawAssist 0.0   the tyres decide the yaw rate                      simulator
yawAssist 0.45  the tyres decide, with a hand on the car's shoulder GTA IV/V-ish
yawAssist 0.75  you decide, within what grip allows                 SF Rush
yawAssist 0.85  you decide, and grip is generous about it           Crazy Taxi
yawAssist 1.0   you decide; the tyres only say how much             Stunts 1990
```

`yawGripLimited` is the second half and it is what makes the Stunts port faithful rather than merely
twitchy. In `apps/corridor/src/car.ts` the wheel asks for a yaw rate, the tyres deliver
`clamp(demand, ±grip)`, and **above the limit the car turns LESS** — a slide is never *added* by
cornering. That is why a 1990 car understeers off the outside of a bend instead of spinning, and it
survives as a cap on the imposed yaw rather than as a model of what rubber does.

The `stunts` row's numbers are arithmetic off the existing model's knobs — `CAR_ACCEL` 11 m/s²,
`CAR_BRAKE` 24, `CAR_GRIP_LATERAL` 22 (μ 2.24, and deliberately arcade), `CAR_STEER_RATE` 2.4 rad/s,
`CAR_SLIDE_DECAY` 2 — so it *starts* where the hand-written car is. **The other four have not been
driven by a person.** This box has no GPU. They are reasoned from what each game is known for and
they are meant to go through the F6 loop: Rich drives, pastes JSON, the defaults get edited.

### Where it is not physically accurate, stated plainly

Because "make it physically accurate" deserves an honest answer about where the cheats are.

- **`lift`** on an explosion redirects part of a radial impulse straight up regardless of geometry.
  A pure radial blast on a car standing on the road pushes it sideways along the road, and it
  *slides*. Cars are supposed to leave the ground. Every game cheats exactly here.
- **falloff is linear, not inverse-square.** Inverse-square is infinite at the centre and negligible
  at half the radius, so a grenade is a teleport or nothing and the radius stops being a thing a
  designer can place.
- **`yawAssist` above 0** is not physics at all, and that is the point of the axis.
- **damage is `impulse / (mass × 40)`**, a scale chosen so a 1400 kg car stopping dead from 10 m/s
  is a bad crash and not a write-off. It is a feel number.
- **dents do not change the collider.** The physics shape stays the box it started as.

Everything else — the suspension, the contacts, the way a body tumbles when a wing clips a post, the
way a ragdoll folds — is Rapier doing real rigid-body dynamics at 120 Hz.

### Traps that were found the hard way

All seven are written up in `packages/engine/src/physics/README.md` and at the code that deals with
them. The four that cost real time, because **every one of them fails silently**:

1. **`addForce` is persistent, not per-step.** 142 N of aero drag applied once per step at 120 Hz
   became 17 kN/s. Symptom: a car accelerates to 13 m/s at full throttle and then slows to a stop,
   still at full throttle. Looks exactly like a gearbox bug.
2. **Nothing may be written from inside a query callback.** Rapier holds a Rust borrow; an
   `applyImpulse` in there throws inside wasm and *the query swallows the exception*. An explosion
   sitting on top of three cars reported "0 bodies moved", with every ingredient testing fine in
   isolation.
3. **Rapier's raycast vehicle traction-limits only the SIDE force.** Bullet's `updateFriction`
   scales the side impulse when the friction budget is exceeded and lets the forward impulse
   through. Out of the box there is no wheelspin and ice is exactly as fast as tarmac — measured
   identical to thirteen decimal places. `vehicle.ts` spends the friction circle itself.
4. **A collider is invisible to queries until `world.step` has run.**

---

## 2. Wiring it into the corridor

Not done. This is the design, in the order it should be built.

### 2.1 `apps/corridor/src/physics.ts` — one owner

A single module that owns the `PhysicsWorld` and binds it to the site:

```ts
const phys = new PhysicsWorld({ hz: T.PHYS_HZ, solverIterations: T.PHYS_ITERS })
const terrain = new Terrain(phys, site.groundAt, { tile: 64, cells: 64, radius: T.PHYS_RADIUS })
```

`site.groundAt` is already the one height function the strip, the grass, the furniture and the car
all stand on ("One surface, one height function", `apps/corridor/README.md`). Handing `Terrain` the
*function* rather than the mesh is what makes the physics ground and the drawn ground the same
surface by construction, with no second sampling to drift.

### 2.2 The car: both models, side by side, on a knob

`T.PHYS_CAR = 0` keeps `car.ts` exactly as it is. `1` swaps in `Vehicle` with
`profile(T.PHYS_PROFILE)`. **Both stay**, at least until the Stunts profile has been driven back to
back with the model it was ported from, because that comparison is the only real test of the port
and a screenshot cannot make it.

The seams are already the right shape: `car.ts` exposes `pos`, `yaw`, `forward`, `right`, `speed`,
`slide`, `slip`, `event` — and `Vehicle.state` speaks the same vocabulary on purpose, so the chase
camera, the cockpit, the HUD, `enginesound.syncFromCar` and the minimap do not have to know which
one is running. Expect one adapter of about forty lines, not a rewrite.

The surface hook closes the last gap:

```ts
vehicle.setSurface((x, _y, z) => (site.edgeDistance(x, z) > T.CAR_GRASS_EDGE ? 0 : 1))
```

Note `edgeDistance` returns a **number**; `edgeInfo` returns the record. Reading `.d` off the number
silently reports zero problems.

### 2.3 Static world: what gets a collider, and when

| what | shape | source | breakable |
|---|---|---|---|
| ground and road | heightfield tiles | `site.groundAt` | no |
| trees | cylinder, trunk radius from canopy height | `site.treesNear` | no — a mature trunk ends your run |
| signs, blades, stop signs | thin box on a post | `furniture.ts` / street-spice | **yes**, low threshold |
| signal masts | box + arm | `signals-ecs.ts` | yes, high threshold |
| buildings | box per massing, or convex hull | `buildings.ts` | no |
| barriers, kerbs | box | `furniture.ts` | no |
| power poles | cylinder | `power.ts` | yes, very high |

**Only within `PHYS_RADIUS` of the player.** The same streaming discipline as the trees and the
grass, for the same reason, and `Terrain` already does it for the ground; the props need an
equivalent register keyed by the same tile grid.

### 2.4 The instancing problem, which is the real work

Every sign, pole and light in the corridor is one instance in an `InstancedMesh`. A broken one has
to leave that buffer and become its own mesh. `Breakables` reports the break with whatever `tag` the
caller attached — an instance index, an ECS entity, a catalog id — and deliberately does not touch
the renderer.

The renderer side has one rule it must not break: **never mix a ranged upload with a full rewrite,
and never clear update ranges by hand.** `addUpdateRange` makes the *next* upload partial. The
cheapest correct move for a broken instance is to scale its matrix to zero and write that one range,
then draw the loose body as a standalone mesh.

### 2.5 Traffic: kinematic until it is hit

This is the design decision that decides whether a busy road is affordable.

A hundred IDM cars as dynamic rigid bodies is a hundred vehicle controllers, four hundred wheel rays
and a solver island per queue. It is not affordable and it is not even *desirable* — traffic that is
following a lane model should follow it exactly, not fight a suspension.

So: **a traffic car is a kinematic body carrying its collider, driven by IDM and MOBIL exactly as
`PLAN-TRAFFIC-AND-RAGE.md` describes. It becomes dynamic at the moment something hits it hard
enough**, and from then on it is wreckage: the ECS drops `Autonomous`, the physics takes over, and
the entity is the same entity throughout (which is what `actors.ts` designed for — "a traffic
vehicle the player takes over should become that one WITHOUT changing entity").

`Breakables` already does this exact transition for a sign — `setBodyType` in place, same handle,
same collider. A traffic car is the same move with a bigger mass and a `Vehicle` optionally attached
afterwards. Budget: cap the number of *wrecked* cars, oldest-out, the same rule `Debris` uses.

That also gives the rage simulator its whole mechanic for free. A missile is a projectile body; it
detonates as an `explode` with `lift` and `breakAt`; the cars it throws were kinematic a frame
earlier and are wreckage now.

### 2.6 The F6 panel and presets

A `physics` tab, generated from the profile's own keys rather than hand-written — `DriveProfile` is
a flat record of numbers precisely so the panel, the preset library and the level document can all
walk it. Scope: **`world`**, so a level may carry a handling profile, and the tuning panel sits on
top of it exactly as the three-layer resolve in `presets.ts` already defines.

A preset that pins physics knobs is a level saying "in this game cars handle like this", which is
correct. A preset that pins `PHYS_HZ` or `PHYS_RADIUS` is a level saying "your laptop must be this
fast", which is why those two are `machine` scope.

### 2.7 Order of work

1. ~~`physics.ts`, `Terrain` from `site.groundAt`, nothing else.~~ **Done — see §2.8.**
2. `Vehicle` behind `PHYS_CAR`, the camera/HUD adapter, the F6 tab. **Rich drives all five.**
3. ~~Static props within the radius; `Breakables` on signs and blades; the instance-swap in the
   renderer.~~ — **done**, §2.10 and §2.11. Merged fence and wall runs are the one gap.
4. Deformation on the player's car.
5. Traffic bodies, kinematic; the wake-to-physics transition.
6. Missiles, the blast, the rage simulator.
7. Ragdolls, once there is a rig to hang them on.

### 2.8 Step 1, as built and measured

`apps/corridor/src/physics.ts` owns a `PhysicsWorld` and a `Terrain` bound to `site.groundAt`. It is
built after `buildSite`, freed when the site changes, updated once a frame from the car's position
(not the camera's — the chase camera sits eight metres behind, which at the edge of the radius is
the difference between ground and a hole), and exposed on `window.corridor.physics` and the dev
bridge. A `physics` tab in the F6 panel carries eleven knobs.

**`?phys=1`, not the knob.** `PHYS_ENABLED` is read once, when the site is built, so it needs to be
set *before* a load — and the F6 panel cannot do that: measured, `tune.set` moves the live value and
**persists nothing**, so setting the knob and reloading comes back to the default with the physics
never started. `?phys=1` is the switch, the same shape as `relief`, `season` and `level`.

**`probes/corridor-physground.mjs`** is the acceptance test, and it is the one that matters: does the
ground the physics thinks is there agree with the ground you can see? On `bowie-racetrack-rd`, 123
samples along a 160 m transect of the spine, on the crown and 3 m either side:

| | |
|---|---|
| median \|dz\| between `groundUnder` and `groundAt` | **0.0001 m** |
| worst | 0.180 m, at one sample of 123 |
| relief across the transect | 1.5 m |
| heightfield tiles | 39 |
| tile build cost | **565 ms for 39 tiles — ~14.5 ms each** |

Two things to take from that.

**The surfaces agree.** A tenth of a millimetre at the median is the two of them being the same
function, which is the whole point of handing `Terrain` `groundAt` rather than a mesh. The one 0.18 m
sample is the heightfield interpolating linearly across a 1 m cell where the real surface has an
edge; that is what a 1 m sampling costs and it is the knob `PHYS_TILE_CELLS`.

**A tile costs about 14.5 ms to build**, which at `PHYS_TILE_BUDGET 1` is a dropped frame every time
one is built. Crossing 64 m tiles at 30 m/s that is a few dropped frames every couple of seconds.
It is the one cost this file can hitch a frame with, it is measured rather than guessed, and the
trade is `PHYS_TILE_CELLS`: halving it to 32 quarters the work and doubles the resolution a wheel
feels to 2 m. Worth driving both before choosing.

**The probe was proved able to fail.** Transposing the heightfield index in `terrain.ts` — the exact
silent bug §1 warns about — took the median from 0.0001 m to 1.137 m and put 108 of 123 samples over
tolerance. The control assertion (comparing against a sample shifted 12 m, which must *dis*agree)
also earns its place: it is what stops the whole probe passing vacuously over flat ground.

### 2.9 Step 2 so far: the car drives on the real road

`physics.spawnCar({ x, z, yaw }, profileId)` puts a `Vehicle` on the baked ground with the surface
hook already attached — because "what is pavement" is the site's question, and a caller who had to
remember to wire `edgeDistance` would eventually not. The hook is a RAMP over a metre either side of
the edge rather than a step, because two wheels on tarmac and two on grass is the interesting case
and a hard step makes the car snatch at a line it cannot see.

`probes/corridor-physcar.mjs` drives all five at full throttle for six seconds along the spine at
`bowie-racetrack-rd`, on the real heightfield:

| profile | metres in 6 s | m/s at the end | sank | sideways |
|---|---|---|---|---|
| taxi | 185.3 | — | 0 | 0.0 |
| rush | 172.8 | 47.5 | 0 | 0.3 |
| stunts | 166.0 | — | 0 | 0.0 |
| street | 117.0 | 33.4 | 0 | 0.0 |
| sim | 100.3 | 30.3 | 0 | 0.0 |

Nothing sank below the drawn ground, nothing drove sideways, and the spread is 85 m — so the profile
really is reaching the tyres rather than five cars sharing one set of numbers.

**The check that was wrong, and is the reason to keep proving a probe can fail.** The surface hook
was asserted as "it gets less far off the pavement". It does: 62.7 m against 117.0 m. But with the
hook **disabled entirely** it still only managed 102.1 m, because the verge is rougher ground and
costs speed whatever the grip is — so the probe passed with the thing it was testing switched off.
The honest measure is `state.wheelslip`, the share of the demanded drive the tyres refused, which
moves if and only if the grip changed: **0.62 off the pavement against 0.06 on it**, and 0 both ways
with the hook disabled. That assertion was then re-checked in both directions.

### The swap, and how close the port is

`src/rapiercar.ts` is the adapter, and it came out at about a hundred lines because **nothing else
changed**. `DrivableCar` in `car.ts` is the interface the chase camera, the cockpit, the HUD, the
minimap, the headlight beams and `enginesound.syncFromCar` all talk to, and neither of them can tell
which model is underneath. `?phys=1&car=rapier&profile=stunts` picks; `PHYS_CAR` and `PHYS_PROFILE`
are the knobs, and the URL beats them because both are read once, when drive mode is entered.

**It wraps `Car` rather than rebuilding the body.** There is a `Car` inside `RapierCar` whose `tick`
is never called: it is the MESH — the silhouette, the glasshouse, the lamps, the beams, the dash and
the wheels, forty lines of geometry apiece — and this poses it every frame from the rigid body. The
alternative was extracting six hundred lines into a third file, which would also have broken
`probes/corridor-carpose.mjs`, which reads two specific lines out of `car.ts` **by name** and
evaluates them against a ground normal. The only change to `car.ts` is a public `poseParts(steer,
spin)` for the wheels and the steering wheel, split out of `updateMesh` without moving those lines.

**The quaternion is used whole.** `Car.updateMesh` builds its orientation from yaw, then a pitch
about local Z and a roll about local X — an Euler chain that cannot express a car on its roof, which
is fine for a model that can never be on one. A Rapier body can, so `RapierCar` writes
`mesh.quaternion` straight from the body. `yaw` is still derived from the FLATTENED forward vector,
because a car mid-barrel-roll still has a heading and `atan2` of the raw forward swings wildly as
the nose goes over.

**The order of teardown is load-bearing.** A `RapierCar` holds bodies that belong to the physics
world, so the car is freed before the world; the other way round hands wasm-freed handles to
`vehicle.free()`.

`probes/corridor-carswap.mjs` drives both through the viewer's own Tab key and controls. Same spot,
same three seconds at full throttle, on `bowie-racetrack-rd`:

| | metres | m/s at the end | mesh gap | worst yaw step |
|---|---|---|---|---|
| `car.ts`, kinematic | 44.84 | 27.9 | 0 | 0 |
| Rapier, `stunts` profile | 38.95 | 25.4 | 0 | 0.0000 |

**Within 13%** of the model it was ported from, from a standing start, which is a good deal closer
than the port had any right to be before anybody tuned it. The mesh never drifted from the model's
own position, the heading never jumped, and every field the viewer reads was present and finite on
both — which is the actual claim this probe exists to check, the distances being a smoke test.

### 2.10 Step 3 so far: trunks you can hit

`site.treesNear` is a grid lookup over the tree records in world metres, so the trunks stream around
the player the way the ground does: nearest first, a ceiling on how many may stand at once
(`PHYS_TREE_BUDGET`, 300), and the same hysteresis on the way out so driving past one does not
rebuild it every frame. A cylinder rather than a capsule — a capsule's rounded base lets a car ride
up the foot of a tree, which reads as the tree being made of jelly.

**They are not registered as breakable.** Hitting a mature trunk at speed should end your run. The
`Breakables` register exists and is wired; it is empty until signs and blades go in.

Measured on `bowie-racetrack-rd`: 38 trunks standing beside the road at spine 1800, and a car driven
at one at full throttle stopped **2.48 m** from its centre. With `PHYS_TREES` off the same car passed
straight through it (closest approach 0.12 m), which is how that check was shown to be live.

**One thing the probe got wrong first, worth keeping.** It looked for trees at the spine's
third-point — which on Bowie is open ground with nothing within 120 m — and concluded "no tree
colliders were built" from a site containing **15,927 trees**. A check that picks its own test
location has to check that the location can answer the question. It now walks the road until it
finds a stretch with trunks beside it, and reports "no trees anywhere near this road" as its own
state rather than as a failure.

### 2.11 Step 3: everything else you can hit, and signs that come off

`worldbodies.ts` walks the built scene ONCE and writes down every prop — where it is, how big, what
it is made of and what it weighs — and `physics.ts` streams colliders out of that list by proximity,
the way the ground and the trunks already do. On `crofton-triangle` that is **10,210 records**: 1,092
furniture instances, 120 power poles, 2,015 fence posts and 7,506 buildings.

**Buildings come from the manifest, not the scene.** `buildings.ts` merges all 7,506 footprints into
one geometry, so there is nothing per-building to read back. The manifest carries `rect` — a minimum
rotated rectangle with a `yaw_deg` — which gives an ORIENTED box per house. A diagonal terrace's
axis-aligned extent is half as big again as the house, and a car would stop in the garden.

**Mass comes from the geometry** (`@apex/engine/physics/massprops`): the tetrahedron decomposition
for volume, centre of mass and the full inertia tensor, checked against a box, an offset box and a
sphere where the analytic answers are known. The two things geometry cannot tell you are the MATERIAL
and the SOLIDITY — a drawn post is a solid box and a real one is a tube — and both are one value per
CLASS of prop, with the arithmetic written down so the next person re-derives rather than guesses:

> a stop sign's geometry is a 0.035 m post merged with an octagonal back plate, so its envelope is
> about 0.82 × 2.4 × 0.12 m = 0.244 m³. A real 30-inch STOP assembly is a ~2.5 kg plate on a ~14 kg
> post: 18 kg. 18 ÷ (0.244 × 7850) = 0.0094.

Measured end to end: an **18 kg** stop sign, detaching at **722 N·s**, driven into at **17.6 m/s** —
it comes off, becomes a dynamic body, and its instance leaves the buffer for a standalone mesh that
follows it. A power pole under the same hit does not.

**Three things this found that were wrong.**

*Merged batches are not props.* `barrier:fence` catalogued as 7 records, the largest weighing
**228,000 tonnes** — because `furniture.ts` merges whole runs into chunk geometries, and a bounding
box around one is a wall across a neighbourhood. Anything whose footprint is bigger than a prop can
be is now skipped and counted. **The consequence is that merged fences and walls are not collidable
yet**, which is the honest gap: doing them needs the runs broken back into segments, which is the
renderer's data rather than its geometry.

*Two fudge factors multiplied.* `estimateMass` halved the bounding box AND applied `solidity`, so a
solidity calibrated against a measured envelope produced exactly half the intended mass. The only way
to notice is that the answer is precisely 2× wrong. `solidity` is now the only factor.

*A sign was two colliders.* The post-and-backplate assembly and the printed face are separate
instanced batches occupying the same space, so every sign had two colliders and two entries in the
breakables register — and knocking one over left the other standing in mid-air.

---

## 3. What is deliberately left for later

- **Joint limits on ragdolls.** Spherical joints have none, so a knee can fold the wrong way.
  Limited joints are per-axis generic joints, which need a rest frame per joint, which needs the rig
  in a known bind pose. That is real work and it should happen after somebody has watched a ragdoll
  fall over.
- **Soft-body crumple.** Rapier 0.21 ships soft bodies with plastic flow
  (`SoftEdgePlasticFlow`, `SoftBodyCellModel.NeoHookean`), which is genuinely the right way to
  crumple a car: a tetrahedral lattice that yields past a strain threshold and stays yielded. It is
  also a lattice per car solved every step, on a device already drawing a city. The honest split:
  `deform.ts` for every car on the street, a soft body for the one car in a set-piece, if a
  set-piece ever wants one.
- **Convex decomposition of building shells.** `ColliderDesc.convexDecomposition` exists. Boxes are
  right until somebody drives into a colonnade.
- **Voxel colliders** (`ColliderDesc.voxels`, new in 0.21) are the obvious route to genuinely
  destructible masonry, and are worth a look before anything bespoke is written.
- **Determinism across machines.** Rapier is deterministic for a given build and a given order of
  operations. Nothing here depends on that yet; multiplayer would.

---

## 4. How to check any of this without a GPU

Everything in the module runs in Node. `npx vitest run --project engine` is 117 assertions in under
a second, and most of them have a negative twin — the car accelerates on throttle *and does not
without it*, the sign falls at 28 m/s *and does not at 2 m/s*, an empty world reports *no* impacts
before the interesting one arrives. A physics test that only ever checks `> 0` passes just as
happily once the thing under test has stopped running, which is how three of the four silent traps
above were found: by an assertion that was supposed to be boring and was not.
