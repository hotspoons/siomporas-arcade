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
URL and the lobby does not draw a cabinet for it. `UNLISTED` in `apps/arcade/src/catalog.ts` is
that second list; moving the entry into `GAMES` is what puts it in the row, and that is the moment
it needs a cabinet's worth of art.

Arriving at `/crown` with nothing else opens the **select screen**. Arriving with a pair —
`/crown?p1=kestrel&p2=zangief` — skips it and starts that fight, and the game writes the pair back
into the address bar as it changes, so any matchup on screen is a link you can send to someone.

The reference sprites and the stage are cut from Street Fighter II sheets by `scripts/sf2-rip.mjs`
(row maps in `scripts/sf2-rip.manifest.json`) into `public/assets/crown/`. They are placeholders
while the site is private, to be replaced by our own art — see `ART.md` for that pipeline — at
which point the history gets scrubbed.

## Play it

**It runs with no artwork at all**, and wears whatever sprites exist under `public/assets/crown/`.

```bash
npm install
just dev fighter          # or: npm run dev -w apps/fighter    → http://localhost:5184
```

`?p1=zangief&p2=blanka` on the address picks the pairing. Three fighters so far — Ryu, Zangief,
Blanka — and one stage, Guile's airbase.

| | |
|---|---|
| `A` `D` | walk — hold back to block |
| `W` `S` | jump, crouch |
| `F` `G` `H` | light / medium / heavy punch |
| `C` `V` `B` | light / medium / heavy kick |
| `N` `M` | all three punches / all three kicks (the lariat) |
| forward + medium or heavy, up close | throw |
| `236` + P | fireball · `623` + P uppercut · `214` + K hurricane kick (Ryu) |
| `360` + P | Spinning Piledriver · `PPP` lariat (Zangief) |
| hold back, forward + P | Rolling Attack · mash P Electric Thunder · hold down, up + K Vertical Roll (Blanka) |
| `F1` | **hitboxes and frame data** |
| `F2` | training dummy |
| `1` `2` `3` `4` | opponent: guard / easy / hard / second player |
| `F3` | **which school of defence is in force** — see below |
| `Space` · `Numpad0` | guard, in the school that has a guard button |
| `Enter` | character select |
| `5` `6` `7` `8` | pick P1 from the first four of the roster |
| `-` `=` · `9` `0` | walk P1 · P2 along the whole roster |
| `R` `P` | reset, pause |

On the select screen the movement keys walk the grid, any attack button locks your choice in, and
the last cell is random. With one player the machine rolls its own pick once you have committed;
press `4` first and the second cursor becomes the arrow keys and the numpad.

A gamepad works: face buttons and the two right shoulders are the six buttons, the left shoulders
are the three-punch and three-kick macros, d-pad or left stick moves.

**Press F3.** The three arcade boards in `research/BUILDER.md` give three different answers to the
most basic question a fighting game asks, and this cycles between them mid-fight:

| | how you defend |
|---|---|
| `hold-away` | **Street Fighter** — hold back, so blocking and retreating are the same action. Chip on blocked specials. |
| `auto-standing` | **Tekken** — standing still guards highs and mids by itself. You press nothing. |
| `guard-button` | **Virtua Fighter** — `Space` guards, costs no health, and **roots you to the floor**. |

`?defence=guard-button` in the URL picks one on arrival. The height rules do not change between them
— a low must always be guarded low — so switching school changes what *counts* as guarding, not what
guarding stops. The machine translates its own intent, so it guards with the button when that is what
guarding means.

**Press F1.** With no sprite loaded the placeholder art is a drawing of the frame data — the
attacking limb is drawn *from the move's own hitbox*, so it reaches out through startup, locks at
full extension exactly while the move is active, and pulls back through recovery. With sprites
loaded F1 still puts the real boxes and the frame counter over the top.

Check it still works after a change:

```bash
npm test                             # sim tests, no browser needed
node scripts/fighter-smoke.mjs       # boots it in a real browser, screenshots to shots/
```

## The screen, and the units

The 2D game is simulated and drawn in **the 1991 machine's pixels**: a 384×224 screen, scaled up by
a whole number and letterboxed. Every hitbox, walk speed, jump arc and stage width in the config
files is in those pixels, at 60 Hz, and health is 144 points because that is how long a life bar
was — one point of damage is one pixel of bar. The camera follows the midpoint between the fighters,
stops at the stage walls, and never zooms; the two can never be further apart than the screen is
wide. Doing it in the original units is what lets numbers pulled from the original — by hand, from
the wiki, or out of the ROM — go straight into a file without conversion.

## The config layer

A character is a file. `src/data/chars/<id>.json` holds everything the fighter *is* — health, walk
speeds, jump, hurtboxes, pushbox, dizzy resistance, the throw, every normal with its frame data and
hitbox, and every special with its motion, button group and per-strength overrides. `src/data/
system.json` holds what is true for everyone: hitstun, blockstun and hitstop by strength, pushback,
knockdown, dizzy, chip, meter, round length. `src/sim/Character.ts` reads them into the `Move`
shape the state machine runs on; nothing character-specific lives in TypeScript.

The goal is that a new fighter — for this game or for a different one built on the same code — is a
JSON file and a sprite atlas, and that the numbers for the three we have come from the machine
itself (see `../../tools/sf2-probe` and `research/`). A scripting layer for interactions that the
tables cannot express is the next step *if* one turns out to be needed; so far none has.

Per-strength variants: a special lists its base numbers once and `strengths: { lp: {...}, hp: {...} }`
overrides only what differs. Each strength becomes its own move — `hadouken-lp`, `-mp`, `-hp` — so
the rest of the sim never knows a special has versions.

Specials are matched **in the order the file lists them**, and that is load-bearing: `6,6,2,3,6`
contains both a dragon punch and a quarter circle, so a character who lists the dragon punch first
uppercuts when walking forward into a fireball. That is the 1991 behaviour and there is a test for it.

The sprite side of the contract is `public/assets/crown/chars/<id>/frames.json`: an atlas, frames
with an anchor at the feet, and animations named by the same vocabulary the moves use (`stand-hp`,
`shoryuken`, `hit-high`, …). `src/view/Sprites.ts` lays a move's animation over its frame data — the
frames before the peak spread across startup, the peak held for every active frame, the rest over
recovery — so the extended fist is on screen exactly while the hitbox is, whatever the sheet's frame
count. A fighter with no atlas is drawn as boxes; nothing waits for art.

## Status

| | |
|---|---|
| Motion input parser | **done** — `src/sim/Motion.ts`: motions, charges, 360, double taps |
| Config-driven characters | **done** — `src/data/`, `src/sim/Character.ts`; Ryu, Zangief, Blanka |
| Frame data and the state machine | **done** — `src/sim/Fighter.ts`: normals, close normals, chains, 2-in-1 cancels, input buffer through hitstop |
| Hit detection, guarding, rounds | **done** — `src/sim/Match.ts` |
| Throws and command throws | **done** — forward + medium/heavy up close; the piledriver, whiffing and all |
| Specials | **done** — projectiles, rising strikes, travelling and multi-hit strikes, bounce off guard, projectile-invulnerable spins, charge and mash and three-button inputs |
| Dizzy | **done** — stun points per hit, decay, a helpless spell |
| Pixel-scale renderer, sprites, parallax stage | **done** — `src/view/Render.ts`, `src/view/Sprites.ts` |
| A CPU to play against | **done** — `src/sim/Cpu.ts`, reads its own character's specials |
| Numbers from the ROM | in progress — `tools/sf2-probe` |
| Super, EX, meter spending | designed, not built |
| Character select screen | **done** — `src/app/Select.ts`, `src/view/SelectScreen.ts` |
| More stages | not built |
| 2.5D and 3D | designed, not built |
| Tag | pencilled in, see the bottom of this file |

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
