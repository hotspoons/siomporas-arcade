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

## Not done

Frame data proper — startup, active and recovery per move — which wants the same treatment Virtua
Fighter 2 got and is cheap here at twenty-four times real time. Also EX moves and super meter, the
mechanic that most distinguishes this game's economy from Champion Edition's, and the red parry.
