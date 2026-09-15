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

## What was not found

**Height.** A neutral jump plainly happens — the picture shows Akira well off the ground — and no
float in the eight words around x traces an arc. This is the same result Tekken 3 gave, where the
whole structure and then the whole of RAM were searched and the root's y stayed zero through a jump
*and* a throw. Here only eight words were checked, so it is a hint rather than a finding: worth
recording that both 3D boards look like they keep height in the animation, and worth a proper search
before anybody believes it twice.

Also untouched: frame data, throws, the stagger and recovery systems, and how the camera is driven.

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

Those seven rows are, roughly, the menu. A builder that let you choose "guard button + rooted
blocking + ring-out + backward-biased movement" would produce something that feels like Virtua
Fighter without containing a line of Sega's code, and the same for the other columns.
