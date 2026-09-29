# Vehicles, actors and weapons: the asset library's two missing tabs

**Status:** **done**, physics lane, 2026-09-28. All five items of §4 are built and tested — 79
headless assertions across `test/{vehicles,actorspecs,weapons,actors,program}.test.ts`.
**Audience:** was a standalone agent; Rich handed it to the physics lane instead, so the `packages/
engine/**` and `src/actors.ts` coordination in §5 is now internal and only the `src/ui/assets.ts`
boundary needs agreeing.
**Companions:** [`PLAN-EDITOR-IDE.md`](PLAN-EDITOR-IDE.md) (the editor and the physics seams),
[`PLAN-PHYSICS.md`](PLAN-PHYSICS.md) (the engine).

---

## The ask, verbatim

> Under assets, we need a vehicles tab and an actors tab. Vehicles should be a combination of a
> vehicle model, a rig (if we defined it), and vehicle physics dynamics that will impact each game
> type differently, but roll stiffness, grip front/rear/side to side, other things like this - plus
> we want to be able to assign an engine simulator setup and local config for the audio, as well as
> set things like engine power, gearing, braking.
>
> For actors we should have rigged models with their own properties like run and climb speed, fly
> speed if they are magical, and some basic things like health capacity and damage ability for
> combat. We'll need a weapons system too and be able to pull in weapons from the asset library.

— Rich, 2026-09-28

---

## Why this is its own lane

It is one screen and three documents, and none of it collides with what is in flight:

- the **editor/UI lane** is in `apps/corridor/src/{ui,worldedit,editor}` and `tools/assetsvc` —
  you will add tabs to `src/ui/assets.ts`, which that lane owns, so **the file boundary is the
  thing to agree first** (see *Coordination*);
- the **physics lane** owns `packages/engine/src/physics/` and is building the engine these
  numbers feed;
- nobody is working on `enginesim`, which already exists and already has a tuning bench.

---

## What already exists, so nothing is built twice

| you will need | it is already there |
|---|---|
| the asset library UI | `src/ui/assets.ts` — a pane with Catalog / Materials / Service tabs, per-class tabs, search, shared-vs-world scope, a detail pane with a draft-and-save, model import, and a rig editor |
| a rig binding | `AssetItem.rig` = `{ roles: { wheel: ['wheel_fl', …], steer: […] }, convention }`, edited in `rigEditor()` and stored by `tools/assetsvc/catalog.mjs` |
| a 3D preview with role detection | `src/ui/meshview.ts` — `rig()` reports bones, convention and guessed roles; `highlightBone(name)` lights one up |
| the handling model | `packages/engine/src/physics/profiles.ts` — `DriveProfile`, a **flat record of numbers**, and five presets: `stunts`, `taxi`, `street`, `rush`, `sim`. `profile(id, overrides)` and `blendProfiles(a, b, t)` |
| the vehicle controller | `packages/engine/src/physics/vehicle.ts` — `VehicleSpec`, `Vehicle`, and a live `state` (speed, slide, slip, wheelslip, grounded, airborne, damage) |
| an engine simulator | `enginesim` — engine-sim as a Web Audio node, with a tuning bench and an F6 engine tab. **Read its notes before wiring audio**: the `__EMSCRIPTEN__` silence trap and `wasmBinary` being ignored are both real and both cost a day |
| the ECS | `src/actors.ts` (`Vehicle`, `Engine`, `Human`, `Animal`, `Health`, `Hostile`, `Player`, relations, `SETS`), `src/actorworld.ts` (fixed step, systems, `spawnVehicle`, `spawnPedestrian`) |
| the program API | `src/program.ts` — `GameApi`, and `api.physics` (profile, blend, entityProfile, explode, impulse, break, ray, car, onImpact), safe when there is no physics world |
| placement | `src/editor/place.ts` — drag from the palette, move/rotate handles, poses saved to `placements.json` |

**A vehicle is not a new asset.** It is a catalog item (`kind: 'hero-car'` or `'traffic'`) plus a
rig binding plus a dynamics document. Do not build a second catalog.

---

## 1. The vehicle document

Beside the asset, not inside it: `tools/assetsvc` stores it on the item as `vehicle`, the same way
`rig` is stored. One record, and every number in it has a unit.

```jsonc
{
  "vehicle": {
    "spec": {                     // the chassis, in metres and kilograms
      "mass": 1420,               // kg, dry
      "wheelbase": 2.65,          // m
      "track": 1.55,              // m
      "cgHeight": 0.52,           // m above the ground — the number that decides rollover
      "wheelRadius": 0.32,        // m
      "drive": "rwd"              // rwd | fwd | awd. NOT interpolatable; see `lerp: 'step'`
    },
    "profile": {                  // a DriveProfile id plus overrides, never a copy of all forty
      "base": "street",
      "overrides": { "gripRear": 1.08, "rollStiffness": 0.62 }
    },
    "engine": {                   // what the sim and the drivetrain are told
      "power_kw": 205,
      "redline_rpm": 7200,
      "idle_rpm": 850,
      "gears": [3.42, 2.05, 1.42, 1.0, 0.82, 0.68],
      "final_drive": 3.7,
      "brake_torque_nm": 2400,
      "brake_bias": 0.62          // 0…1, front
    },
    "audio": {                    // enginesim, per vehicle
      "setup": "inline-6-na",     // which enginesim configuration
      "gain": 0.8,
      "lowpass_hz": 9000,
      "cabin_mix": 0.35           // how much of it is heard from inside
    },
    "wheels": {                   // which bones to spin, from the rig binding
      "from_rig": true,           // use `rig.roles.wheel` in FL, FR, RL, RR order
      "steer_max_deg": 34
    }
  }
}
```

**Three rules that will save you a week:**

1. **A profile reference, not a profile copy.** `{ base, overrides }` is how a car says "street,
   but grippier" and keeps tracking the base when somebody improves `street`. A flattened copy is
   forty numbers that silently stop tracking.
2. **The rig is the binding, the vehicle document is the behaviour.** Which bone is the near-side
   front wheel is a fact about the MODEL; how hard it grips is a fact about the CAR. Two assets can
   share a model and handle differently.
3. **Every field needs a unit in its name or its comment**, because the next person to read it is
   an agent.

### The tab

A `Vehicles` tab beside Catalog. It is the catalog list **filtered to vehicle classes** — same
list, same search, same shared-vs-world scope, same detail pane — with a `Dynamics` group added:

- the model and its rig, with a warning when `rig.roles.wheel` has fewer than four entries,
  because that is a car whose wheels will not turn and nothing else says so;
- a profile picker (the five presets, plus **blend**, which `blendProfiles(a, b, t)` exists for —
  let somebody see what lives between Rush and the simulator rather than making them pick a side);
- the overrides, **generated by walking `DriveProfile`'s keys**, not typed out. The type is flat
  precisely so this is a loop; forty hand-written fields is forty chances to name one wrong;
- engine, gearing, braking as numbers with units;
- the enginesim setup picker and its audio mix, with a **listen** button — audio you cannot hear
  while tuning is audio nobody tunes.

---

## 2. The actor document

Same shape, same place, on items whose class is `pedestrian`, `animal` or a new `character`:

```jsonc
{
  "actor": {
    "move": {
      "walk_ms": 1.4,             // m/s
      "run_ms": 5.2,
      "climb_ms": 1.1,            // m/s up a ladder or a wall, 0 = cannot climb
      "fly_ms": 0,                // 0 = cannot fly. Magical things say otherwise
      "jump_ms": 4.0,             // m/s initial vertical
      "turn_deg_s": 540
    },
    "body": {
      "health": 100,
      "armour": 0,
      "mass": 78,                 // kg, for ragdoll and for what happens when a car hits it
      "ragdoll": true
    },
    "combat": {
      "damage": 12,               // per hit, unarmed
      "attack_s": 0.7,            // seconds between attacks
      "reach_m": 1.6,
      "weapons": ["pistol-9mm", "crowbar"]   // ids in the asset library
    },
    "rig": { "from_asset": true } // the roles come from the asset's rig binding
  }
}
```

`Health` already exists in `src/actors.ts` (`hp`, `max`) and `mortality` already removes the dead
once, at the end of a step. **Extend the ECS rather than inventing a parallel one** — and note that
`actors.ts` is shared ground with the physics lane, who intend to add a `Physical` component. Agree
before you touch it.

---

## 3. Weapons

A weapon is an asset — a model in the catalog, class `weapon` — plus a document:

```jsonc
{
  "weapon": {
    "kind": "ballistic",          // ballistic | melee | thrown | beam
    "damage": 34,
    "rate_per_s": 7.5,
    "magazine": 15,
    "reload_s": 1.8,
    "muzzle_ms": 380,             // m/s, projectile speed. 0 = hitscan
    "spread_deg": 1.2,
    "recoil": 0.35,               // 0…1
    "range_m": 120,
    "impulse": 900,               // N·s into the physics world on hit — the seam with the engine
    "attach": "hand_r",           // which bone role it hangs off
    "audio": { "fire": "…", "reload": "…" }
  }
}
```

**Pull weapons from the library, do not duplicate them.** `combat.weapons` holds ids; the editor
offers a picker over `kind === 'weapon'` assets. The program API gets a small namespace —
`api.arm(entity, 'pistol-9mm')`, `api.fire(entity, dir)` — and follows the rules in
`PLAN-EDITOR-IDE.md §4: entities not handles, site metres, nothing throws, steppable headlessly.

---

## 4. Order

1. ~~**The vehicle document and the Vehicles tab**~~ — **done**. `apps/corridor/src/vehicles.ts`
   (document, defaults, validation, arithmetic), `src/ui/vehicles.ts` (the Dynamics group and the
   roster tab), the `vehicle` field in `tools/assetsvc/catalog.mjs`, and `test/vehicles.test.ts`.
   The editor lane added an `extensions` seam to `AssetCatalog` for it, so the list, the search,
   the scope and the save bar are still theirs and there is one of each.
2. ~~**The engine and audio block**~~ — **done**. `src/ui/enginelisten.ts` is a one-at-a-time dyno:
   the setup field is a picker over the engine scripts the build ships, and Listen starts an
   `AudioContext` inside the click (which is the gesture autoplay needs), free-revs the engine with
   `setFree({ dyno: true })`, and stops itself after twenty seconds. The gain and low-pass sliders
   are wired into the running bench, so tuning them is something you hear.
3. ~~**The actor document and the Actors tab**~~ — **done**, `src/actorspecs.ts` and
   `src/ui/actors.ts`. NOTE THE FILE NAME: `actors.ts` is the ECS and `actorspecs.ts` is not it —
   see that file's header for why the two must not be confused.
4. ~~**Weapons**~~ — **done**. `src/weapons.ts`, `src/ui/weapons.ts`, and four calls on `GameApi`
   rather than two: `arm`, `armed`, `fire`, `hurt`, behind a `CombatHost` seam that is safe when the
   app has no combat at all. `api.arm` takes an ASSET ID, so a program names a weapon in the library
   rather than restating one.
5. ~~**The ECS components and the spawn path**~~ — **done**; `actors.ts` is the physics lane's own
   file so there was nobody to agree with. `Physical` (handle, mode, mass, layer) with the four
   modes that decide whether a busy road is affordable, `Armed` (weapon index, ammo, cooldown), the
   `cooldowns` system, `setPhysical`, `spawnActor` and `arm` in `actorworld.ts`.

---

## 5. Coordination

`/workspaces/apex-conduit` is a shared tree with three lanes in it. **Name paths when you stage;
never `git add -A`** — somebody has already swept another lane's files that way.

- **Yours:** a new `src/ui/vehicles.ts` and `src/ui/actors.ts`, a new `src/weapons.ts`, the
  document schemas in `tools/assetsvc/catalog.mjs`, and `probes/corridor-vehicles.mjs`.
- **Ask first:** `src/ui/assets.ts` (the editor lane's; you need two `Tab` entries and a filtered
  list — propose the smallest possible seam), `src/actors.ts` and `src/actorworld.ts` (shared with
  the physics lane), `packages/engine/**` (theirs, entirely).
- **Mailbox:** `/tmp/messages/`, NOT `/tmp/corridor-mail/` — that one is from an older round and
  nobody reads it. The lanes are `splats`, `viewer`, `worldeditor` and `physics`, each with an
  `inbox/` and an `outbox/`; `PROTOCOL.md` there is the rule. The seam proposal for `assets.ts` is
  `physics/outbox/003-assets-seam-for-vehicles-tab.md`.

Verify with headless probes, not screenshots: `probes/corridor-*.mjs` are the pattern, and the
house rule is that a probe must be shown able to FAIL before it is trusted. Assert the mechanism —
"the wheels turn" is `rig.roles.wheel.length === 4` and a spin in the preview, not a vibe.

---

## 8. What §2 turned out to mean

**The `Vehicles tab` is a roster, not a second catalog.** The pane already has per-class tabs over
the same list, so reproducing the list, the search and the shared-versus-world scope would be a
second route to one place and the two would drift the first time somebody added a class. What the
tab gives instead is the across-the-fleet view no per-item pane can: which cars have no dynamics at
all, which have numbers that do not validate, `N ready · N with no dynamics · N with problems`.

**Health is a `Uint16Array`.** `toSpawnOpts` clamps to 65,535, because a 70,000 hp boss silently
becoming a 4,464 hp one is exactly the class of quiet failure this codebase keeps finding.

**A density check has to scale isometrically or it libels every animal.** The first cut multiplied a
human's fixed cross-section by the height, which called a perfectly ordinary 0.4 kg, 0.25 m bird
"lighter than air" — a bird is not a short human. Scaling all three dimensions with height puts
bird, dog, deer and person between 210 and 1600 kg/m³ of loose box, while a vehicle's mass typed
into a person still lands above 20,000. The band is wide on purpose: this is a check for a MISTAKE,
and a warning that fires on real animals is a warning people learn to ignore.

**`armour` refuses a share, it does not subtract.** Subtraction makes a heavily armoured thing
invulnerable to small hits and then wildly vulnerable one point later, which is a cliff nobody
tuning it can see.

---

## 7. What §1 turned out to mean, once it was built

Three things the brief could not have known, all of which came out of writing the arithmetic down.

**`rollStiffness` is not a thing.** The brief's own override example names it; the real
`DriveProfile` keys are `antiRollPerKg` and `rollResist`. `validateVehicle` reports an unknown
override key as an ERROR rather than ignoring it, and the tab's override fields are generated by
walking the profile type, so neither can go stale.

**`drive` belongs on the chassis, not on the profile.** The engine's `DriveProfile` carries one,
which is right for five presets describing cars nobody has modelled. But a Mustang is rear-wheel
drive in an arcade racer and in a simulator alike, so the chassis wins and `toDriveProfile`
overrides the profile's.

**The gearing now decides the top speed, and the ride height decides the geometry.** `power_kw`,
`gears` and `final_drive` were going to be decoration beside a `topSpeed` somebody typed. Instead:
tractive force is `torque × gear × final ÷ radius` and top speed is redline in top gear, both exact,
so doubling the final drive halves the top speed and a test says so. Torque is estimated from power
when the document does not state it, and `peakTorque` returns `{ nm, estimated }` so the UI can say
which it is.

That left `cgHeight`, which the brief flags as one of the three numbers people get wrong. It is
worse than it looks: the first implementation pinned the axle mounts to the bottom of the chassis box
and let the spring's rest length position the body, which put a 1.35 m car's floor 0.66 m above the
road and dragged the centre of gravity out of the shell entirely. A hero-car asking for a 0.52 m CG
settled at 0.67 m. The fix is that the body is positioned by its **ride height** and the axle mounts
are then placed to put the wheels on the road — and the sag has a closed form, because Bullet's
suspension force is `stiffness × compression × mass`, so at rest `δ = g / (4 × stiffness)` and **the
mass cancels**. A bus and a hatchback on the same springs sag identically, which is wrong about real
cars and is what the engine does. The test builds a car from a document, settles it, measures the CG
back out and holds it to ±0.02 m of what was asked for.

---

## 6. Things that will bite

- A CSS `display` rule beats the `hidden` attribute. It has cost three bugs in this codebase.
- `Transform` is a `Float32Array`: 90° written and read back is 90.000001, so compare poses with a
  tolerance or everything looks like it moved.
- Monaco's `editor.api.js` registers no editor contributions; if you touch the code editor, read
  `src/ui/codeeditor.ts` first.
- enginesim's wasm has a silence trap (`__EMSCRIPTEN__`) and ignores `wasmBinary`.
- `metres_per_tile`, `cgHeight` and `mass` are the three numbers people get wrong and nothing
  visibly fails until much later. Default them per class and say in the UI that they are defaults.
