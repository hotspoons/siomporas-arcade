# Street Fighter III: 3rd Strike on CPS3 — and the parry, measured

Measured 2026-09-15 by `tools/t3-probe` against romset **`sfiii3n`** in MAME 0.276. This is the
game most people would name as the finest 2D fighter made, on the strength of one mechanic the other
boards in this research cannot express at all.

## The friendliest board in the whole exercise

| | |
|---|---|
| MAME driver | **`status="good"`, `emulation="good"`** |
| savestates | **supported** — the only board here that has them |
| headless speed | **~2400% of real time** — twenty-four times faster than the 3D boards |
| work RAM | `:mainram`, a **512KB MAME share**, so every search runs in-process |
| ROM set | **`sfiii3n`, the "NO CD" build: 70MB and no disk image at all** |

That last line is worth its own sentence. The ordinary `sfiii3` set is a 0.1MB cart plus a ~700MB
CD image; the NO CD revisions carry the whole game in 41 ROM files. If you want 3rd Strike in a
harness, take `sfiii3n`.

A run that takes three minutes on Virtua Fighter 2 takes about eight seconds here.

## Six buttons, named by strength

    P1 Jab Punch    P1 Strong Punch    P1 Fierce Punch
    P1 Short Kick   P1 Forward Kick    P1 Roundhouse Kick

This is the lineage's whole idea and it is our own config's vocabulary: the 2D family names attacks
by **how hard they are**, Tekken by **which limb**, Virtua Fighter by **punch/kick/guard**. Three
philosophies, visible in the input map before a single measurement.

## Memory

| address in `:mainram` | what |
|---|---|
| `0x28654` | **player one's health**, full at **160** |
| `0x2866c` | **player two's health** |
| `0x68e78` | **player one's busy word** — 0 when he has his body back |
| `0x69310` | player two's, one struct (**+0x498**) away |

## Damage — Alex, against an opponent doing nothing

| move | damage | of 160 |
|---|---|---|
| jab | 4 | 2.5% |
| strong | 14 | 8.8% |
| fierce | **21** | 13.1% |
| short | 5 | 3.1% |
| forward | 15 | 9.4% |
| roundhouse | **22** | 13.8% |
| crouching fierce | 18 | 11.3% |
| crouching short | 4 | 2.5% |

**The lineage holds its shape for a decade.** Champion Edition gives Ryu a 4-damage jab and a
19-damage fierce out of 144 health — 2.8% and 13.2%. Third Strike gives Alex 4 and 21 out of 160 —
2.5% and 13.1%. Different hardware, eight years apart, and the damage as a *fraction of a life bar*
is the same to within a rounding error.

Note also that **an opponent standing still is simply hit**. Defence on this board is a held
direction, as in Champion Edition, and not the free automatic guard Tekken gives you.

## The parry

Tap **toward** the attack as it arrives rather than away from it.

    def=none    fierce did 21 damage
    def=block   fierce did  0 damage
    def=parry   fierce did  0 damage      (twice, against two controls)

Tapping toward cannot be a block — blocking is holding *away* — so the zero is a parry.

### But zero damage is not the point

A block does that too. The reason this mechanic is admired is what happens **next**, and the
cleanest way to measure it is not a frame count but a question no one can misread: *after the
defence, can the defender hit back?*

Player one throws a fierce. Player two blocks it or parries it, then immediately jabs.

| defence | did the counter-jab land? |
|---|---|
| **block** | **no** — three times out of three, nothing of player one's ever fell |
| **parry** | **yes** — player one's health went 160 → 156, exactly a jab, three times out of three |

**A parry buys a free punish; a block does not.** That is the whole mechanic in one line, and it is
the thing a builder would want to offer: a defence that costs a precise input instead of a held
direction, and pays a counter-attack instead of a stalemate.

### The frame numbers, with a caveat

From the busy words, relative to the attack input:

| | defender free on frame | attacker free on frame |
|---|---|---|
| block | 16 | 54 |
| parry | **13** | 56 |

So a parry frees the defender three frames sooner and leaves the attacker busy two frames longer — a
five-frame swing. **Treat the absolute numbers with suspicion**: a busy word runs past the point a
player can actually act, exactly as Tekken 3's animation lengths do, and a blocked fierce reading
−38 is not credible as frame advantage. The *relative* difference is the trustworthy part, and the
punish test above is what the difference means in practice.

## Getting in

Boot, then mash: coins from frame 600, both start buttons from 1000, and a **jab** to confirm a
character from 1400. A live two-player match by about frame 2100.

## Frame data

| move | input to the blow landing | total | damage |
|---|---|---|---|
| jab | **6** | — | 4 |
| crouching jab | 6 | 21 | 4 |
| short | 7 | 29 | 5 |
| crouching short | 7 | 21 | 4 |
| strong | 6 | 35 | 14 |
| forward | 7 | 36 | 15 |
| crouching roundhouse | 13 | 54 | 19 |
| crouching fierce | 15 | 58 | 18 |
| fierce | 16 | 54 | 21 |
| roundhouse | **18** | **66** | 22 |

**Read the first column as an upper bound on startup, not as startup.** It is frames from the button
press to the health beginning to fall, so it carries input latency and any travel with it. The
Champion Edition tables in `system.json` are true startup, read from that game's own frame counters,
and the two are not like-for-like. A phase word was looked for here — the trick that gave Virtua
Fighter 2 real startup/active/recovery in one run — and CPS3 does not appear to have one: a scan for
a word taking a distinct small value in each of the three phases returned two candidates, and
tracing both frame by frame showed neither is a clean enumeration.

Even as an upper bound the shape is clear, and it is the interesting part:

**3rd Strike is a markedly slower game than Champion Edition.** Ryu's jab there is 3 frames of
startup and his fierce 6. Alex's jab here takes 6 frames to land and his fierce **16**. Whatever the
input latency is, it is the same for every row, so the *spread* is real: the light attacks sit at
6–7 and the heavy ones at 13–18, where Champion Edition's whole normal set fits between 3 and 6.
The game that is remembered for reactions is built out of attacks you have twice as long to see.

## Health drains; it does not drop

Watching the fierce land frame by frame:

    f+15   160
    f+16   159   <- the blow lands
    f+17   158
    …
    f+36   139   <- and stops, 21 down

**One point per frame, for twenty-one frames.** So the word at `0x2866c` is the health *bar* as it
animates rather than a logical hit point total, and two things follow. Damage totals are still
exactly right, because the drain settles on the true value. But the "contact frame" is the frame the
drain *starts*, which is an upper bound on the real moment of contact, and any probe that samples
health a few frames after a hit will read a number that is still falling.

It also means a KO is not instantaneous on this board, which is a mechanic in itself: a blow that
takes you to zero takes twenty frames to do it.

## The super meter

| address in `:mainram` | what |
|---|---|
| `0x286a4` (high half) | **the gauge**, 0 at the start of a round |
| `0x286a8` (low half) | **stocks held** |

The gauge fills to **exactly 128**, and at 128 it does not stop — it **awards a stock and resets to
zero** to start filling the next one. That is a different shape of economy from Champion Edition's,
where the meter fills bars that sit there.

What fills it, measured one action at a time from a fresh reading:

| | gauge |
|---|---|
| a fierce that whiffs | **+3** |
| a fierce that is blocked | **+9** |
| a fierce that lands | **+17** |
| a jab that lands | **+2** |

Two things follow, and both are switches a builder would want.

**Meter gain scales with the attack.** A jab is worth 2 and a fierce 17 — more than eight times as
much — where Super Turbo's meter, as `system.json` records it, pays a flat rate per hit whatever you
hit with. So in this game your meter is built by committing to big attacks, not by touching the
opponent often.

**And it pays you for being defended against.** A blocked fierce still gives 9, more than half of
what landing it gives, and even a whiff gives 3. Attacking is never wasted here, which is a very
different pressure from a game where a blocked attack gives you nothing.

For scale: a full stock is about **eight landed fierces**, or forty-three whiffed ones.

The ratio between landing and being blocked — 17:9, near enough 2:1 — is almost exactly Super
Turbo's 6:3. Eight years apart, the *relative* value of a hit over a blocked hit did not move, even
though everything about the units did.

## What an EX move costs

| | |
|---|---|
| gauge before | 60 |
| gauge after an **EX** fireball | **20** |
| **cost** | **40 of 128** |
| the same motion with one button | gains 1, costs nothing |

So a full gauge is a choice: **one super stock, or about three EX moves**. That is the shape of this
economy — a currency you can spend continuously in small amounts or bank for one large payoff —
against Champion Edition, where the meter is only ever saved and only ever spent whole.

Chip, incidentally, came free with the measurement, because player one was holding away and blocking
throughout: **a blocked fireball chips 1, a blocked EX fireball chips 2.** So this game keeps
Champion Edition's rule that specials chip through a guard, where both 3D boards abandoned it.

### Two traps, and neither was the input

Finding this took four runs and three of them were spent on wrong conclusions worth recording.

**A game that cannot afford an EX gives you the ordinary special instead**, silently. With 18 units
of gauge the "EX" and the plain version were identical in every respect — same damage, same gain —
and that looks exactly like an input that did not register. Build the gauge before concluding
anything. Blocked fierces are worth 9 each and harm nobody; fireballs are worth about 1.

**And a character who does not have the move you are asking for looks exactly like a broken
harness.** A quarter circle was fed to Alex at two speeds, with the direction held and released, and
never produced a special — so the motion primitive was written off as not working. It works: the
same call makes **Ryu throw a fireball across the screen on the first attempt**. Alex is a charge and
grapple character. Test a new board with a fireball character before believing the input is at
fault.

`M.motion` and `M.qcf` in `lua/common.lua` are the primitive, and the comment above them says this.

## Not done

The red parry, and true startup figures if anyone finds the phase word this scan could not.
