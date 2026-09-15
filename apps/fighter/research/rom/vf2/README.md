# Virtua Fighter 2 on Sega Model 2: the other school of 3D fighting

Measured 2026-09-15 with `tools/t3-probe` against romset `vf2` (Version 2.1) in MAME 0.276. The
point of this pass was Rich's fighting-game builder — a thing that lets you pick mechanics from
famous games — so what matters here is not Virtua Fighter's numbers in isolation but **where they
disagree with Tekken's**, because those disagreements are the switches the builder would offer.

## Which Virtua Fighter you can actually have

| | MAME driver | usable |
|---|---|---|
| Virtua Fighter (Model 1) | preliminary | no |
| **Virtua Fighter 2 (Model 2)** | **imperfect / good** | **yes** |
| Virtua Fighter 3, 3tb (Model 3) | preliminary | no |
| Virtua Fighter 4, 4 Evo, 4 Final Tuned (NAOMI 2) | preliminary | no |
| Virtua Fighter 5 (Lindbergh) | preliminary | no |

So VF2 is the only one, and there is no version of this where we measure VF4 Final Tuned or VF5 —
the boards MAME cannot run are exactly the ones the series is most admired for. Same family that
works: Fighting Vipers, Last Bronx and Dead or Alive are all Model 2 **but all preliminary**, so VF2
is alone on its board too.

It runs at **240–290% of real time** headless, slower than System 12's 440% but perfectly workable.

## Getting in

Two quirks, each of which silently produces a plausible-looking but useless run:

- **Two coins per credit.** The attract screen says `CREDIT 0/2`. Three coins buys one play, so the
  second player never joins and you spend the session measuring a CPU opponent. Eight coins is
  cheap insurance.
- **Both start buttons**, as on Tekken. Player one starts, player two joins.

## Where the fight is

Model 2 gives MAME its work RAM as a **share** — `manager.machine.memory.shares[":workram"]`, one
megabyte — and a full scan of it costs about **twenty milliseconds** of host time. That is a
different world from the PlayStation boards, where the live state is four megabytes reached through
the CPU's address space and every search meant dumping to disk. Here the whole search runs inside
the emulator.

| offset in `:workram` | what |
|---|---|
| `0x10f7c` | **player one's x** |
| `0x10f78` | **the gap between the fighters** — it rises by exactly as much as a retreat |
| `0x1099c` | **height**: zero on the floor, a real arc in the air |
| `0x12b2c` (low half) | **health, 16-bit, full at 196** — also mirrored at `0x15b40` high half |

**And these are IEEE floats.** Model 2's i960 has an FPU and its TGP coprocessor is float-native, so
positions are singles: `1065353216` read as an integer is `1.0f`. The PlayStation boards next door
have no FPU and use fixed-point integers throughout. Searching Model 2 as integers finds nothing and
costs you an evening.

## The numbers

Akira, per frame, from a two-player match.

| | x per frame |
|---|---|
| walk forward | **+0.0097** |
| walk backward | **−0.0162** |
| guard, alone | 0 |
| **guard + forward** | **exactly 0.000** over 120 frames |
| **guard + backward** | **exactly 0.000** over 120 frames |
| neutral jump | 0.000 — a jump goes straight up |

### Backing away is faster than going forward

**1.67 times faster.** That is the reverse of both other boards we have measured: Champion Edition
gives Ryu 3 forward against 2 back, and Tekken 3 gives Xiaoyu 14.4 forward against 12.5 back. Both
of those make advancing the cheaper action and retreating the expensive one. Virtua Fighter inverts
it, and on a stage with edges that is a coherent design rather than a quirk: retreat is how you
survive, and the thing that punishes you for retreating is not your opponent's walk speed but the
floor running out.

### Guard is a button, and it roots you

The input map already says it — `P1 Punch`, `P1 Kick`, **`P1 Guard`**, three buttons where Tekken
has four limbs and no guard at all — but the measurement is the interesting part. Holding guard and
pushing the stick moves you **exactly zero units in 120 frames, in either direction**.

That single fact reorganises the whole game:

- In a 2D fighter, and in Tekken, you block by **holding away**, so blocking and retreating are the
  same action and you can do both at once, forever.
- In Virtua Fighter you press a button, and while it is held you are **nailed to the floor**.

Defence stops being free movement and becomes a decision with a position cost. On a stage with an
edge behind you, that is the whole game.

## The ring

The round starts at **x = 7.000** with a **gap of 9.000** — round numbers, so these are the game's
own constants and not an artefact of where somebody was standing.

Walking backwards from there, x falls steadily to **≈ 0.21** and the fighter goes over the edge:
`RING OUT` in red, the round lost outright. So the edge is at **x = 0**, and a fighter starts
**7 units** in front of the one behind him — about **440 frames, seven and a half seconds**, of
uninterrupted retreat.

A ring-out ends the round as surely as a knockout, which means the arena is a *mechanic* and its
size is a tunable number. Nothing in Street Fighter II corresponds to it, and Tekken 3's floors are
mostly unbounded.

## Height: this board *does* simulate it, and Tekken does not

An earlier pass looked at the eight words around x, found no arc, and recorded a hint that both 3D
boards might keep height in the animation. **That hint was wrong, and the caveat on it was the only
reason it did not become a claim.** Searching the whole megabyte — cheap here, twenty milliseconds a
pass — turns up a float at **`0x1099c`** which is the real thing.

    standing   0.000
    airborne   1.166  1.259  …  2.809  …  1.020
    landed     0.000

    airborne frames       72
    apex                  2.809 units, at frame 35 — a symmetric arc
    gravity               -0.00272 units per frame per frame
    forward jump          same arc exactly, plus 3.548 units of travel

**The gravity is a single distinct value.** Taking the second difference across all 72 frames gives
exactly one number, −0.0027, not a spread — so the board is integrating a constant acceleration
rather than playing a curve somebody drew. That is real physics, of the kind `src/sim/Fighter.ts`
already runs for Champion Edition, and it means a Virtua Fighter character has the same three
constants an SF2 character has: a launch speed, a gravity, and an airborne count.

Two things to be careful about before quoting this:

- The value is **0.000 while grounded and 1.166 on its first airborne frame** — it does not rise
  from zero. So it is not simply the height of the feet; more likely a body origin that is only
  written while airborne, with zero acting as "on the floor". The *dynamics* are readable either
  way, but the offset is not yet understood.
- ~~The fighter stayed on the ground for 14 frames after the input, exactly as long as the button
  was held.~~ Checked with holds of 4, 8, 14 and 30 frames, and it is not an artefact — but it is
  not one number either. See below: there are **two jumps**.

**So the two 3D boards disagree about height**, which is worth more than either answer alone:
Tekken 3's world position has no height at all — the root's y is zero through a jump *and* through
being thrown over somebody's shoulder — and the model rises because the animation says so. Virtua
Fighter 2 integrates an arc. For a builder, that is another switch, and for the photogrammetry work
it decides whether a rigged character's root needs a height channel or the animation owns it.

## There are two jumps, and one gravity

Holding "up" briefly and holding it a while produce different arcs, and the board decides which
somewhere around the twelfth frame of the hold:

| how long "up" is held | leaves the ground on frame | airborne | apex |
|---|---|---|---|
| 3 frames | 10 | **32** | **1.439** |
| 6 frames | 10 | 32 | 1.439 |
| 16 frames | 14 | **72** | **2.809** |
| 30 frames | 14 | 72 | 2.809 |

A hop that is up and down in half a second, and a committed jump more than twice as high that leaves
you in the air for 72 frames — a very long time to be unable to guard, on a stage you can be knocked
off. Which one you get is decided by the stick, not by a separate button.

**And the gravity is the same in both.** Across all five jumps measured, the second difference is
−0.00272 with a spread of **exactly 0.00000**. One acceleration constant for the whole game, two
launch speeds. That is precisely the shape `src/data/system.json` already uses — a system-wide
`gravity` with per-character launch — so this part of Virtua Fighter would drop into the existing
simulation without inventing anything.

Street Fighter II has one fixed jump arc and no way to vary it. Tekken 3's neutral jump is a single
48-frame affair. A variable-commitment jump is therefore a genuine third option for the builder, and
on a stage with edges it is the interesting one: the big jump is how you cross distance and also how
you get yourself killed.

## Health, damage, and the fact that guarding is free

**Health is a 16-bit integer, full at 196**, at `0x12b2c`. It took three attempts to find, and the
failures are the instructive part:

1. Punching from out of range, which measures nothing but things that count downwards.
2. Landing the punches but taking the second sample **after the round had reset** — health goes back
   to full, so "fell twice" became impossible by construction.
3. Demanding it fall *twice* at all. The health bar shows the second bout of punches missed
   entirely, so the real answer fell once and then held, and the stricter-sounding filter threw it
   out.

And the thing that finally worked: **scanning 16-bit halves**. A 32-bit pass never finds this,
because the half-word beside health belongs to something busy, so the enclosing word never looks
still. Cross-checked against the picture — the green bar fell from 171 pixels to 150, a ratio of
0.877, and exactly two half-words in a megabyte fell by 0.878.

With that instrument:

| | |
|---|---|
| full health | **196** |
| Akira's standing punch | **12** — about sixteen of them to a knockout |
| the same punch into a held guard | **0** |

**There is no chip damage.** Blocking costs nothing in health, which makes the ring the only thing
that punishes turtling — and closes the loop on the guard button being a full stop. You can hold
guard all day and take no damage; what you cannot do is move, and behind you is the edge.

Compare Champion Edition, where health is 144, Ryu's fierce is 19, and a *blocked special* still
takes a slice off you. Two games, two answers, and the difference is a single switch in a builder.

## What was not found

Frame data — startup, active and recovery — which is now within reach: health is the instrument it
needs, and `tools/t3-probe/lua/vf-damage.lua` already lands a punch on a chosen frame and reads the
result. Also throws, the stagger and recovery systems, and how the camera is driven.

## For the builder: the switches these two boards disagree on

| | Street Fighter II | Tekken 3 | Virtua Fighter 2 |
|---|---|---|---|
| buttons | 6, strengths | 4, limbs | **3, and one is Guard** |
| how you block | hold away | hold away | **press and hold a button** |
| can you move while blocking | yes, backwards | yes, backwards | **no — rooted** |
| faster direction | forward | forward | **backward** |
| third axis | none | **sidestep, 612 units in a burst** | none |
| losing the round | health, or the clock | health, or the clock | health, the clock, **or the floor** |
| arena | walls that stop you | mostly unbounded | **7 units to the edge** |
| maths | fixed point | fixed point | **IEEE floats** |
| full health | 144 | not yet found | **196** |
| chip damage on block | yes, on specials | not yet measured | **none at all** |
| jump height | simulated, one fixed arc | **animation** — world y is always 0 | **simulated, two arcs**: hop 32f/1.44, jump 72f/2.81, one gravity |

Those seven rows are, roughly, the menu. A builder that let you choose "guard button + rooted
blocking + ring-out + backward-biased movement" would produce something that feels like Virtua
Fighter without containing a line of Sega's code, and the same for the other columns.
