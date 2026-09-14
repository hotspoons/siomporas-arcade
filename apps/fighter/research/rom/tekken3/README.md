# Tekken 3 on Namco System 12: what the board will and will not tell us

First reconnaissance, 2026-09-15. The question behind it is what makes 3D fighting feel different
from 2D, in numbers we could put in a config file the way `src/data/chars/*.json` holds Champion
Edition. This is what one night of driving the board produced: the harness, the memory found so far,
the movement numbers that came out of it, and — as important — a clear list of what did not work.

Everything here was measured by `tools/t3-probe` against romset `tekken3je1` in MAME 0.276.

## Why Tekken 3 and nothing else

Of the 3D fighters MAME knows, most are useless for this:

| board | MAME driver | has the third axis? | usable |
|---|---|---|---|
| Tekken (System 11) | imperfect / good | **no** — 3D rendering on a 2D plane | no point |
| Virtua Fighter (Model 1) | **preliminary** | — | no |
| Virtua Fighter 2 (Model 2) | imperfect / good | no sidestep; the ring is the third axis | ring geometry only |
| Virtua Fighter 3 (Model 3) | **preliminary** | yes | no |
| **Tekken 3 (System 12)** | imperfect / **good** | **yes** — sidestep, juggles, ring-outs | **yes** |

So it is Tekken 3 or nothing, and Soul Calibur and Tekken Tag are the same System 12 hardware — a
harness that works for one works for all three.

## The two hard constraints

**There are no savestates.** `savestate="unsupported"` on every one of these drivers. The 2D harness
next door rests entirely on them: `boot.lua` walks Champion Edition through attract mode into a
fight, saves, and then several hundred probes each load that state, do one thing and read memory.
None of that transfers. Every measurement here has to happen in one run, in order, from a cold boot,
which is why `tools/t3-probe/lua/common.lua` is a *schedule* — a queue of steps keyed to frame
numbers — rather than a library of things a probe can call whenever it likes.

It costs less than it sounds. Headless the board runs at **about 440% of real time**, so the walk
from power-on to a two-player fight with both characters chosen is about 30 seconds of wall clock,
and a full measurement run is two minutes.

**Main RAM is 4MB, not 2.** Namco doubled what a PlayStation has, and *all* of the live game state
is in the half above `0x200000`. The lower half is code and static data and changes about thirteen
bytes a second. It is mirrored again at `0x400000`. An hour went into believing this was a stock PSX
and concluding the emulation was broken, so: **read `0x00200000`–`0x003FFFFF`**.

## Getting into a fight

Three credits, then **both** start buttons. Pressing only the second one starts a game *as* player
two against the machine, which looks almost identical on screen and quietly ruins every measurement,
because the opponent then moves. In versus mode player two is a person who does nothing, and that
stillness is the whole method: anything that moves while player one walks is player one's.

Timings from a cold boot, at 60 frames per second:

| frame | what |
|---|---|
| ~1440 | past the RAM check, attract mode running |
| ~1440–1800 | three coins, spaced 120 frames apart and held 20 (a shorter pulse is not counted) |
| ~1920 | player one start, then player two start 60 frames later |
| ~2070–2400 | both press a punch to take whoever the cursor is on |
| ~2900 | round one, control begins |

## The memory found so far

All addresses are player one's unless stated. Player two's structure exists at a fixed offset which
is **not yet pinned down** — see the open questions.

| address | what it is | evidence |
|---|---|---|
| `0x31e15c` | **world x** | tracks the stick exactly: −1000 at rest, −3692 after walking one way, +1059 walking back |
| `0x31e160` | **always zero** — not height; see below | zero throughout a confirmed airborne state |
| `0x31e164` | **world z**, the axis a 2D board does not have | barely moves in a walk; **−612 in a few frames** on a sidestep, and back on the opposite one |
| `0x31e190`, `0x31e198` | **animation pointers** (KSEG, `0x8002xxxx`) | change the instant a move starts, return on idle |
| `0x31e194`, `0x31e1a0` | **frames into the current animation** | +1 per frame, resets to zero when the animation changes |
| `0x31e19c` | the same counter packed twice, `(n<<16)\|n` | — |
| `0x31e1a4` | **state**: 6482 idle, 2114 airborne, 12585 crouching, 135250 walking, 4196418 sidestepping | changes with every phase, returns to 6482 |
| `0x31e1a8`, `0x31e1ac`, `0x31e1e0`, `0x31e1f0` | state flags that move with `0x31e1a4` | square waves, not values |
| `0x21f650` | **global frame counter**, +1 per frame | — |
| `0x25fdec`–`0x25fe5c` | **the health bar's geometry**, quads 0x10 apart | all shrank by 17 units together when punches landed |
| `0x21fe00`, `0x21f614` | copies of x, one frame behind | same values, same movements |

## What the board actually does — the numbers

Xiaoyu, measured per frame from a live fight.

| | units per frame |
|---|---|
| walk forward | **14.4** |
| walk backward | **−12.5** |

Forward is faster than back, as it is in Champion Edition — the same asymmetry, on a board five
years later.

**The sidestep** is the headline, because it is the thing 2D has no equivalent for:

| | |
|---|---|
| distance off the line | **612 units** |
| delivered in | a burst of about **−124 units per frame** |
| incidental x drift | 188 units |
| total frames the step occupies | 135 |

For scale: 612 units of z is what **43 frames of walking** would buy you along x, and the step
delivers it in a handful. That is the trade the third axis offers — a large, fast displacement
perpendicular to everything the opponent is doing, paid for with a long recovery during which you
have moved almost nowhere useful.

**The jump** lasts about **48 frames** airborne, counted off the animation counter at `0x31e194`.

## The open questions, with the next technique for each

- **Height is not in the fighter structure.** `0x31e160` reads zero through an entire jump while the
  state word plainly says airborne, and no word in `0x31e100`–`0x31e340` traces an arc. The
  hypothesis worth testing: on this board a jump's height is **animation-driven** — the model's root
  rises because the animation says so — and world y is only simulated when a body is launched. The
  test is a juggle: get hit by a launcher and watch whether `0x31e160` comes alive.
- **Health.** The bar's *geometry* was found and it plainly tracks damage, but the logical value has
  not been. Differential search fails here: this RAM is mostly per-frame scratch, so "a word that
  fell twice" returns forty candidates and every one oscillates when watched live. The right tool is
  a **write-watchpoint on the bar geometry**, walking backwards to whatever writes it —
  `-debug -debugger none` does expose `wpset`/`bpset` through the Lua device debugger, which the 2D
  harness never needed.
- **Player two's structure base.** A stride of `+0x1ae4` fits twelve matrix pairs and nothing else;
  the words that follow player two cluster around `0x31fdf0`, which would put the stride at
  `+0x1c94`. Unresolved, and cheap to settle by watching a guessed address while only he moves.
- **Frame data** — startup, active, recovery — is now within reach and was not attempted: the
  animation pointer and the per-animation frame counter are exactly the two instruments the Champion
  Edition harness used, and the missing third is a damage signal, which is the watchpoint job above.
- **Ring-outs, walls and floor breaks**, and **how the camera is driven**, are untouched. Two
  addresses near `0x3ff7d0` trace a small arc during a jump and are the obvious camera candidates.

## What this cost, so the next person budgets it

Roughly twenty MAME runs at two minutes each. The expensive mistakes, all avoidable:

1. Believing main RAM was 2MB, because the first 2MB reads as valid MIPS code and changes almost
   nothing (~5 runs).
2. Pressing only player two's start button, which yields a real fight against a moving CPU that
   looks exactly like the versus match you wanted (~3 runs).
3. Walking *into* the opponent to measure a walk: the bodies collide and the coordinate flattens
   halfway through the sample, so it fails a monotonic test and drops out (~2 runs).
4. Testing for health without first testing for *stillness*. Almost everything in this RAM changes
   every frame, so "fell twice" is not evidence of anything (~4 runs).
