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

**The two fighters are the same structure 0x1ae4 apart.** Player one's root is at `0x31e15c`,
player two's at `0x31fc40`, and every field below has a twin at `+0x1ae4`.

| address | what it is | evidence |
|---|---|---|
| `0x31e15c` | **world x** | tracks the stick exactly: −1000 at rest, −3692 after walking one way, +1059 walking back |
| `0x31e160` | **world y — always zero**, even mid-air; see below | zero through a jump *and* through being thrown |
| `0x31e164` | **world z**, the axis a 2D board does not have | barely moves in a walk; **−612 in a few frames** on a sidestep, and back on the opposite one |
| `0x31fc40` | **player two's x**, and `+4`/`+8` his y and z | walks at a constant 14.4 a frame when only he moves, with y pinned at zero |
| `0x31fe04` onwards | the **skeleton**, in world coordinates, as (x, y, z) triples | every bone translates with the body; y is negative — about −1035 at the head — so **up is negative** |
| `0x31e190`, `0x31e198` | **animation pointers** (KSEG, `0x8002xxxx`) | change the instant a move starts, return on idle |
| `0x31e194`, `0x31e1a0` | **frames into the current animation** | +1 per frame, resets to zero when the animation changes |
| `0x31e19c` | the same counter packed twice, `(n<<16)\|n` | — |
| `0x31e1a4` | **state**: 6482 idle, 2114 airborne, 12585 crouching, 135250 walking, 4196418 sidestepping | changes with every phase, returns to 6482 |
| `0x31e1a8`, `0x31e1ac`, `0x31e1e0`, `0x31e1f0` | state flags that move with `0x31e1a4` | square waves, not values |
| `0x21f650` | **global frame counter**, +1 per frame | — |
| `0x31e492` | **health, full at 140** — player two's at `0x31ff76`, one stride away | falls by 7 for a low kick; the twin stays put |
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

**A throw** — left punch and left kick together, which an idle opponent does not break — relocates
the victim a very long way in the floor plane:

| | |
|---|---|
| victim's x | 3743 → 2921 (**−822**) |
| victim's z | −12 → **+867** |

So a throw moves a body about 1200 units across the floor, most of it *sideways*. On a 2D board a
throw is a swap of positions along one line; here it is a relocation in a plane, and the camera
swings round with it.

## Height is not simulated, and that is the most important thing found

The root's y is **zero on every frame** of a standing jump — all 48 of them, with the state word
plainly reporting airborne — and zero on every frame of being thrown, through a flip over the
shoulder and a slam into the floor with a dust cloud.

Height lives in the **skeleton**, not in the fighter's world position. The bones carry their own y
(negative upwards, about −1035 at the head) and the model rises because the animation says so. The
fighter's world position, as the game's own logic holds it, is a **2D point on the floor plane plus
an animation**.

That has a direct consequence for the framework this research feeds. A Street Fighter II character
is a position with a simulated y, a launch velocity and a gravity constant — `jumpVy`, `gravity`,
`airborne` are all real numbers in `src/data/chars/*.json`, and the sim integrates them. A Tekken 3
character is not that. Whatever a 3D character config ends up looking like, height is something the
animation owns, and the state machine owns x, z, and which animation is playing.

**What would still falsify this:** a juggle. Being launched and falling under gravity is the one
case not yet tested — a throw is a scripted arc, and the game could plausibly script it while still
simulating a real juggle. The test is a launcher, and the reason it has not been run is that it
needs a move list: `d/f+2` was tried, and Xiaoyu simply crouched.

## The open questions, with the next technique for each

- ~~Height is not in the fighter structure.~~ **Settled, and it has its own section above:** the
  root's y is zero through a jump and through a throw. Only a juggle could still overturn it.
- ~~Health: not found after five attempts.~~ **Found: `0x31e492`, full at 140**, with player two's
  one stride away at `0x31ff76`. The section below is kept because the *reason* it took seven
  attempts is a mechanic, and a more important one than the address.

  The four search techniques were all sound — they are the same ones that found health on Virtua
  Fighter 2 within an hour, including the two that matter: **scan 16-bit halves** (health can sit
  beside a per-frame counter, so no 32-bit word containing it ever looks still) and **accept a value
  that falls once and holds** (demanding two falls throws the answer away when the second bout
  misses). Neither found anything here, and a fifth pass using the fighter struct's own stride to
  pair a falling number with its motionless twin found only colour data.

  Then the health bars were measured **in pixels**, in the screenshots, which is what should have
  happened first: **210 pixels wide, unchanged, in every snapshot of every health run.** No damage
  was ever dealt. Every one of those searches was looking for a number that had not moved.

  Two specific traps behind that:

  - **The bar geometry at `0x25fdec`–`0x25fe5c` is not a damage signal.** It was used as the oracle
    for "a hit has landed" and it moves — it went 460 → 499 → 474 in a run where both bars stayed
    visibly full. It tracks something else, probably the camera or an animation.
  - **Point-blank is a gap of about 1600 units, not a small number.** The fighters' bodies are wide,
    and a probe that walks forward until `|p2.x − p1.x|` drops below a few hundred will walk into
    the opponent and push for nine hundred frames without ever getting there.

  ### And the reason nothing ever landed: **standing still is a guard**

  One run replicated, frame for frame, the only sequence that had ever visibly produced a spark on
  the opponent's face — and the bars still did not move. The spark was the clue and I read it as a
  hit. It was a **block**.

  **On this board a character who is standing still guards automatically** against highs and mids.
  He holds nothing and presses nothing; neutral *is* a guard. Every punch thrown at the idle second
  player in seven runs was blocked, and six searches went looking for damage that was never done.

  A low attack is what gets through:

  | thrown at an opponent doing nothing at all | damage |
  |---|---|
  | `rp` right punch | **0** — blocked by simply standing there |
  | `lp` left punch | **0** |
  | `rk` right kick | **0** |
  | **`d+rk` low kick** | **7** |

  (Xiaoyu's `d+lk`, `d+rp` and `df+rp` also did nothing, which may mean they are not lows in her
  moveset rather than that they were blocked. Only `d+rk` is confirmed to get through.)

  That makes three genuinely different answers to the most basic question a fighting game asks:

  | | how you defend |
  |---|---|
  | Street Fighter II | hold away — and standing still gets you hit |
  | Virtua Fighter 2 | **hold the Guard button** — which roots you to the floor, and standing still gets you hit |
  | Tekken 3 | **do nothing at all** — neutral blocks highs and mids by itself |

  Tekken's answer is the most forgiving of the three and it changes what the game is about: defence
  is free and automatic, so the pressure has to come from mixing highs with lows rather than from
  making blocking expensive. Virtua Fighter charges you movement for the same protection and covers
  only half of you. Street Fighter makes you commit the stick.

  The **write-watchpoint** was never needed in the end, but remains the better tool if a value ever
  genuinely hides: `-debug -debugger none` exposes `wpset`/`bpset` through the Lua device debugger.
  `wpset` with `nil` for the condition and action **segfaults MAME**; pass strings.
- ~~Player two's structure base.~~ **Settled: `0x31fc40`, a stride of `+0x1ae4`.** Found by making
  only him walk and keeping the one word in 128KB that moved at a constant 14.4 a frame *and* had a
  zero in the next word — the root's signature, since the fighter stands on the floor. The twenty
  other words that walked with him were skeleton bones, whose next word is their height above it.
- **Frame data** — startup, active, recovery — is now unblocked and not yet done. All three
  instruments exist: the animation pointer, the per-animation frame counter at `0x31e194`, and now
  health. Virtua Fighter 2 shows what it looks like once you have them — a single phase word there
  gives startup, active and recovery directly and a whole move list falls out of one run — and
  Tekken 3 probably has the same word. Nothing has looked for it yet.
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
