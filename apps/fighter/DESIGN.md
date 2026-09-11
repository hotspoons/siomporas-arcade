# CONCRETE CROWN — how it plays

Twelve fighters ([ROSTER.md](ROSTER.md)), three dimensions, and a 2D layer that is not a
compromise. The art pipeline is in [ART.md](ART.md).

The one-line pitch: **the 2D game is the real game, and the 3D is what happens when someone gets
knocked through a wall.** Not a 3D fighter with a 2D mode bolted on — those are always bad at the
2D. A plane-locked six-button fighter that occasionally, and for a reason, opens out.

---


## Where it runs

Two places, from one build. `just dev fighter` serves it standalone on :5184, which is where the
tuning happens. The arcade mounts the same game through `src/app/module.ts` at
[arcade.siomporas.com/crown](https://arcade.siomporas.com/crown) — **unlisted**: it resolves as a
URL and the lobby does not draw a cabinet for it, because the stand-in renderer is not something to
put on a lit sign. `UNLISTED` in `apps/arcade/src/catalog.ts` is that second list; moving the entry
into `GAMES` is what puts it in the row, and that is the moment it needs a cabinet's worth of art.

## Play it

**It runs, with no artwork at all.**

```bash
npm install
just dev fighter          # or: npm run dev -w apps/fighter    → http://localhost:5184
```

Two fighters made of boxes, against a CPU. Everything in the "Status" table below marked done is in
there and playable.

| | |
|---|---|
| `A` `D` | walk — hold back to block |
| `W` `S` | jump, crouch |
| `F` `G` `H` | light / medium / heavy punch |
| `C` `V` `B` | light / medium / heavy kick |
| `236` + punch | fireball |
| `623` + punch | uppercut — invincible frames 1–6, and horrible if it whiffs |
| `F1` | **hitboxes and frame data** |
| `F2` | training dummy |
| `1` `2` `3` `4` | opponent: guard / easy / hard / second player |
| `R` `P` | reset, pause |

A gamepad works: face buttons and the two right shoulders are the six buttons, d-pad or left stick
moves.

**Press F1.** The placeholder art is not a stand-in for real art, it is a drawing of the frame data
— the attacking limb is drawn *from the move's own hitbox*, so it reaches out through startup, locks
at full extension exactly while the move is active, and pulls back through recovery. A move that
looks wrong is wrong. F1 puts the real boxes and the frame counter over the top of it.

Check it still works after a change:

```bash
npm test                             # 210 tests, no browser needed
node scripts/fighter-smoke.mjs       # boots it in a real browser, screenshots to shots/
```

## Status

| | |
|---|---|
| Motion input parser | **done** — `src/sim/Motion.ts`, 40 tests |
| Art pipeline | **done** — templates, cutter, anchors, [60 prompts](PROMPTS.md) |
| Frame data and the state machine | **done** — `src/sim/Moves.ts`, `src/sim/Fighter.ts` |
| Hit detection, guarding, rounds | **done** — `src/sim/Match.ts`, 26 tests |
| Fireball, uppercut, combos, meter | **done** |
| A CPU to play against | **done** — `src/sim/Cpu.ts`, crude on purpose |
| Placeholder renderer | **done** — `src/view/Render.ts` |
| Throws, chains, super, EX | designed, not built |
| Sprites instead of boxes | waiting on art |
| 2.5D and 3D | designed, not built |
| Tag | pencilled in, see the bottom of this file |

Order of work from here: **generate Kestrel and Bollard's art and swap the boxes for sprites** —
the anchors in `frames.json` exist precisely so that is a renderer change and nothing else. Then
throws and chains, then a third character, then the dimension shift. Nothing about the 3D layer
should be started until two characters play well in 2D.

Two fighters are defined so far — Kestrel and Bollard — and they differ only in numbers: health,
walk speed, jump arc, reach and damage. That is deliberate, and it is why a roster of twelve was
ever affordable in 1991. The other ten need a row in `CHARACTERS` and nothing else to be playable.

---

## The three planes

The fight always has a **plane** — a line through the arena the fighters are locked to. What changes
is how much freedom you have off it and where the camera is.

### 2D — the default, and where the game lives

Both fighters on one line. The camera is side-on and orthographic. This is Street Fighter II and it
is not apologised for: walk speeds, the jump arc you cannot change once committed, six buttons,
motion inputs, blocking by holding back. Ranges are exact because there is only one axis, which is
what makes footsies work at all.

**Rounds are won here.** A player who never leaves this plane is not playing a worse version of the
game.

### 2.5D — plane-locked, but the world is not flat

Same rules, same lock, same reachable positions. The difference is presentational and the fighters
and stage are 3D models: the camera swings, drifts and pushes in, props pass in front of the fight,
the background is a place rather than a backdrop.

The rules do not change. **Anything you could do in 2D you can do here, frame for frame.** That is
the contract, and breaking it is how this sort of thing usually goes wrong.

### 3D — the break

The plane lock releases, sidestep becomes real movement, and the camera goes over the shoulder.
Mechanics change here, on purpose, because a modern pad has two sticks and a 3D arena is not a line:

- **Left stick** moves in the plane; **8-way dash** replaces the walk.
- **Right stick** orbits.
- Motion inputs still work, and they are still relative to your opponent — but **directional specials
  become stick-relative**, so a fireball goes where you are aiming.
- **Sidestep and sidestep-cancel** are the new defensive layer, and they are what you have instead
  of the exact spacing 2D gives you.
- **Guard is a button**, not a direction, because holding away from a rotating opponent is nonsense.

Damage and health carry across untouched. The health bar does not care what dimension you are in.

### Getting between them

Four ways in, one way back. All of them are **earned or scripted, never a menu**:

1. **Stage break.** Scripted. A hard enough knockdown against a wall at low health puts both
   fighters through it and into 3D in the next area. Once a round, once a stage.
2. **Crown Break.** Spend the full super meter on a specific counter-hit and the arena opens for a
   fixed twelve seconds. This is the one players will build a game plan around.
3. **Stage design.** A few stages are 3D from the bell and stay that way. They are the minority.
4. **Round transition.** Round 2 in a different plane from round 1, announced before the bell.

**Back to 2D** happens one way: the twelve seconds run out, or a knockdown lands. The plane
re-locks on the axis between the fighters at that instant, and both are snapped to it. If the game
has one unfair-feeling moment it will be this one, and the fix will be generous invulnerability on
the snap rather than cleverness about the axis.

### The rule that makes it not fall apart

**Character state is dimension-independent.** Health, meter, hitstun, the move you are in and how
many frames into it — none of it changes when the plane does. A shift mid-combo does not drop the
combo; the same move continues in the new camera. The sprite and the model are in the same pose at
the moment of the swap, because `poses.json` was solved from the sprites
([tools/photogrammetry](../../tools/photogrammetry/README.md)). That is the whole reason for the
pose-lifting step, and it is what makes the transition read as one continuous fight.

---

## Controls

Six buttons, because the moveset is built on six and four is a different genre.

|  | Light | Medium | Heavy |
|---|---|---|---|
| **Punch** | LP | MP | HP |
| **Kick** | LK | MK | HK |

A modern pad has exactly six comfortable attack inputs and they map without compromise:

| Pad | Action |
|---|---|
| ⓧ / A | LK |
| Ⓐ / B | MK |
| □ / X | LP |
| △ / Y | MP |
| R1 / RB | HP |
| R2 / RT | HK |
| L1 / LB | Throw (LP+LK macro) |
| L2 / LT | 3D only — sidestep |
| D-pad / left stick | movement |
| Right stick | 3D only — camera |

Keyboard defaults go through the engine's existing rebinding
([`packages/engine/src/input/bindings.ts`](../../packages/engine/src/input/bindings.ts)) like every
other game in the arcade. Macros for LP+LK and all three punches are bindable, and there is no
advantage the pad has that the keyboard does not.

## Motion notation

Numpad, always relative to your facing:

```
7 8 9        4 back · 6 forward · 5 neutral
4 5 6        236 quarter circle forward     623 dragon punch
1 2 3        214 quarter circle back        [4]6 hold back then forward
```

`[4]` means hold. `41236` is a half circle. `360` is a full rotation.

### What the parser gives you

`src/sim/Motion.ts` is built and tested. It answers "did the player just do this motion?" from a
ring buffer of raw input, and it knows nothing about characters or moves.

```ts
if (history.pressed(Button.HP) && matchMotion(history, QCF, facing)) fire(kiteLine)
```

Three things in it are worth knowing, because they are decisions rather than implementation:

**Matching is loose, and that is the point.** Nobody inputs `2,3,6` on three consecutive frames.
The matcher scans backwards for each step and allows any junk between them, as long as the whole
motion fits in a window. Strict matching is "correct" and feels broken.

**Order of checking is the priority order.** `6,6,2,3,6` — walking forward into a fireball —
contains both a dragon punch and a quarter circle. Check DP first and the walking player gets the
uppercut. This is the 1991 behaviour and it is deliberate; there is a test asserting it.

**Down-back charges both.** Holding `1` charges a back charge and a down charge at once, which is
why charge characters block low for free. Meridian and Arclight are built on it.

Leniency lives in one exported constant and the numbers are the argument to have, not the code:

```ts
LENIENCY = { window: 15, buffer: 8, charge: 45, chargeRelease: 12, doubleTap: 12 }
```

Fifteen frames for a quarter circle is period-accurate and strict. Modern games run nearer
twenty-five. Start strict, watch someone who is not you play, then loosen.

Still to add: **negative edge** (SF2 fired specials on button *release*, which is why buffering a
held button worked) — `history.released()` is there and nothing uses it yet.

## Moves

Per character:

- **Normals** — six standing, six crouching, six jumping. Eighteen. The sprite sheets provide the
  key poses for a representative subset and the rest are variations on them; this is the one place
  the art budget bites and where the digitised generation cheated too.
- **Command normals** — one or two. `6+HP` and the like.
- **Specials** — two, from the roster, each with three strengths. Nine of the twelve characters get
  a third at some point.
- **Super** — one, at full meter.

### Frame data

Every move is `startup / active / recovery`, and the numbers are the game. The model:

```
state: startup -> active -> recovery -> neutral
       hitstop freezes both fighters on contact
       hitstun / blockstun are the defender's version
       advantage = defender's stun - attacker's remaining recovery
```

Cancels, in the order they unlock:

- **Chain** — light into light, on hit or block. Free. This is what makes the game approachable.
- **Special cancel** — a normal into a special, on hit or block, within a window.
- **Super cancel** — a special into a super, on hit only.
- **Dash cancel** — costs meter, 3D only, the combo extender the open arena needs.

**Links** — one move recovering fully before the next starts, with no cancel — exist and are not
required for anything. Every character has a chain route to the same damage at 80%. The hard
combos are for the people who want them, not a tax on everyone else.

### Throws

`LP+LK` when close. Throws beat blocking, lose to jumping and to being hit first, and are
**breakable** on a seven-frame window. No throw loops.

Bollard, Kombinat and Ossuary have **command throws** — motion inputs, unbreakable, considerably
more damage, and slower. That is the grappler's whole argument.

### Meter

One bar, four segments, built by dealing damage, taking damage, and whiffing specials at a
quarter rate. Spend on:

| | Cost | |
|---|---|---|
| EX special | 1 | stronger, faster, more hits |
| Guard cancel | 2 | push out of blockstun; loses the round if you have no plan |
| Super | 4 | |
| **Crown Break** | 4 | open the arena into 3D for twelve seconds |

Super and Crown Break costing the same is the interesting decision of the game and should stay that
way through balancing.

## Rounds

Best of three, ninety-nine seconds, the shorter health bar wins on time. No round-to-round health
carry. A **perfect** is worth saying something about and nothing mechanical.

## Tag teams — pencilled in, not designed

Two or three per side, one in at a time, tag on a button with a recovery cost. The ceiling is
assists and tag combos, which is where "Temu Capcom vs Marvel" earns the name.

**What it needs from the code now**, so that adding it later is not a rewrite:

- A fighter's state is a **value that can be parked and restored**, not something tangled into the
  scene. Park a character mid-recovery, bring them back, and they resume.
- **Two or three fighters per side must be loadable at once.** Sprite atlases sized for six on
  screen, not two.
- **Health and meter belong to the team**, not the character. Make them team-level from day one even
  with a team size of one, because retrofitting that is miserable.
- The plane lock is **per side, not per fighter**.

Nothing else. Do not build assists now.

## Gore

Thresher is built out of the ugliest end of the genre, and that generation's calling card was
dismemberment. This game has a **blood and damage toggle, off by default**, and it is shader and
particle work — sweat, dust, swelling, split lips, blood on the floor that accumulates over a round.

**No dismemberment, and no gore frames in the art pipeline.** Do not generate them. A KO is a KO.
The toggle exists because a fight should look like it hurt, not because anyone needs to see a
character come apart.

## What is not in this game

Worth writing down so it stops being relitigated: no juggle-until-they-die infinites, no unblockable
setups you cannot see coming, no character locked behind anything, no input the pad cannot do as
well as a stick, and no 2D mode that is secretly the 3D game with a locked camera.
