# A fighting game builder's menu, measured from three arcade boards

Written for whoever builds the mechanics-picker — the thing that lets you choose "Street Fighter's
defence with Virtua Fighter's throws" and get something that feels like a real game.

Everything below was measured by driving the original boards headlessly in MAME and reading their
memory, not taken from a wiki. `tools/sf2-probe` does the 2D one, `tools/t3-probe` the two 3D ones,
and the per-board notes in `research/rom/` carry the addresses, the methods and the mistakes.

| | Street Fighter II: CE | Tekken 3 | Virtua Fighter 2 | Street Fighter III: 3rd Strike |
|---|---|---|---|---|
| board | CPS1 | Namco System 12 | Sega Model 2 | CPS3 |
| our config today | `system.json` + `chars/*.json` | — | — | — |

## 1. Defence — the switch that changes the most

This is the one to expose first, because everything else bends around it.

| | how you defend | can you move while doing it | does it cost you |
|---|---|---|---|
| **Street Fighter II** | hold away from the opponent | **yes** — blocking *is* retreating | a blocked special still chips you (`chipFraction: 0.25`) |
| **Tekken 3** | **nothing at all** — standing still guards highs and mids | yes, you are simply standing | nothing |
| **Virtua Fighter 2** | **hold the Guard button** | **no — rooted, exactly 0.000 units in 120 frames** | nothing in health |
| **3rd Strike** | hold away to block — **or tap *toward* to parry** | yes for a block; a parry is an instant | a parry costs a precise input, and **pays a free counter-attack** |

3rd Strike is the one that adds a genuinely different *kind* of answer. The other three are all
states you hold; the parry is a **moment you have to be right about**, and the measured difference
is not the damage — a block stops that too — but what happens next:

| after a fierce is… | can the defender hit back? |
|---|---|
| **blocked** | **no**, three times out of three |
| **parried** | **yes** — a jab lands for 4, three times out of three |

Three genuinely different answers to the most basic question a fighting game asks, and each one
implies a different game:

- **Street Fighter** fuses defence and retreat, so the corner is the pressure: you block your way
  backwards until there is nowhere left.
- **Tekken** gives defence away free for doing nothing, so pressure has to come from **mixing highs
  with lows** rather than from making blocking expensive. Standing guard does not cover the legs.
- **Virtua Fighter** charges you *movement* for a guard that costs no health — and that guard is
  half-height too. You are safe and stuck, which is why the throw matters so much.

## 2. The damage economy

Normalised, because the health totals differ and the percentages are what a player feels.

| | full health | a jab | a heavy | a throw |
|---|---|---|---|---|
| Street Fighter II | **144** | 4 — 2.8% | 19 — 13.2% | 32 — **22.2%** |
| Tekken 3 | **140** | — | — | — |
| Virtua Fighter 2 | **196** | 12 — 6.1% | 30 — 15.3% | 40 — **20.4%** |
| 3rd Strike | **160** | 4 — 2.5% | 21 — 13.1% | — |

Two agreements, and both look like constants of the genre rather than coincidences.

**A throw is worth about a fifth of a health bar** in both games where one could be measured — 22.2%
and 20.4%, five years and two hardware generations apart.

**The Street Fighter line holds its damage curve for a decade.** Champion Edition: a jab is 2.8% of
a life and a fierce 13.2%. Third Strike, eight years and two hardware generations later: 2.5% and
13.1%. The health totals changed, the hardware changed completely, and the *fractions* did not.

Tekken's row is thin because only one attack was ever landed on it — see §7.

## 3. Speed

| | fastest attack, frames to contact | a normal, start to finish |
|---|---|---|
| Street Fighter II | **3** (jab) | 12–35 |
| Virtua Fighter 2 | **8** | 19–40 |
| Tekken 3 | 14 (its one measurable attack) | 40–67 *(animation length, an upper bound)* |
| 3rd Strike | **6** (jab, input-to-contact) | 21–66 |

3rd Strike deserves its own line here, because the comparison with its own ancestor is the sharpest
in the table: **Champion Edition's whole normal set starts up between 3 and 6 frames; 3rd Strike's
lights land in 6–7 and its heavies in 13–18.** The game remembered for reactions is built out of
attacks you have roughly twice as long to see coming — which is exactly what makes a parry, a
mechanic that demands you be right at one moment, a reasonable thing to ask of a player.

**Virtua Fighter's quickest attack is slower than Street Fighter's slowest normal.** That single
comparison is most of why the two feel unalike: in one you are reacting inside a third of a second,
in the other you are committing for half a second and living with it.

## 4. Movement

| | forward | backward | which is faster |
|---|---|---|---|
| Street Fighter II | 3 px/frame | 2 | forward |
| Tekken 3 | 14.4 units/frame | 12.5 | forward |
| Virtua Fighter 2 | 0.0097 | **0.0162** | **backward, by 1.67×** |

Virtua Fighter inverts it, and on a stage with edges that is coherent rather than quirky: retreat is
how you survive, and what punishes you for retreating is not your opponent's walk speed but the
floor running out.

## 5. Jumping

| | |
|---|---|
| Street Fighter II | one fixed arc. `gravity: 0.312`, `prejumpFrames: 4` |
| Tekken 3 | 48 frames airborne, and **no simulated height at all** — world y is zero through a jump *and* through being thrown over a shoulder. The animation owns it. |
| Virtua Fighter 2 | **two arcs**, chosen by how long "up" is held: a hop (32 frames, apex 1.44) and a committed jump (72 frames, apex 2.81). **One gravity**, −0.00272, spread of exactly 0.00000 across every jump measured. |

Tekken's answer has a direct consequence for the 3D character work: if height belongs to the
animation, a rigged character's root does not need a height channel.

## 6. The third axis, and the arena

| | |
|---|---|
| Street Fighter II | none. Walls stop you; `stageHalf: 384` |
| **Tekken 3** | **a sidestep: 612 units off the line in a burst of ~124 a frame.** For scale that is what 43 frames of walking buys along x, delivered in a handful — and paid for with a long recovery in which you have gone nowhere useful |
| Virtua Fighter 2 | none — its third axis is the **ring**: 7 units to the edge from the starting mark, about 7½ seconds of retreat, and going over it loses the round outright |

Ways to lose a round: health and the clock in all three; **the floor** only in Virtua Fighter.

## 7. Virtua Fighter's triangle, which is the most complete thing here

Because its guard is free, rooted and half-height, the whole game sits in one shape — all measured:

| doing this | is beaten by | for |
|---|---|---|
| standing guard | a **throw** | 40 — a fifth of your life |
| standing guard | a **low** (`d+K`) | 12 |
| crouching guard | a **mid** (`f+K`) | 30 |
| crouching | *nothing can throw you* | — |
| either guard | a high | 0 |

And **the throw cannot be escaped by mashing** — four single-trial runs, two of them controls, and it
landed every time. So crouching is not *an* answer to the throw, it is *the* answer, and the price
of crouching is a mid worth thirty. The biggest reward in the game answers the laziest defence; the
thing that punishes the counter to it is the second biggest. That is a design worth copying whole.

## 8. What a config would need to express all three

Today `system.json` is Champion Edition's rulebook with the field names of one game. To carry the
others it wants a few switches rather than a rewrite:

```jsonc
{
  "defence": {
    "mode": "hold-away" | "auto-standing" | "guard-button",
    "movesWhileGuarding": true,          // false on Virtua Fighter: rooted
    "chipFraction": 0.25,                // 0 on both 3D boards
    "heights": ["high", "mid", "low"]    // whether a standing guard covers everything
  },
  "jump": {
    "mode": "fixed" | "by-hold" | "animation",
    "arcs": [ { "airborne": 32, "apex": 1.44 }, { "airborne": 72, "apex": 2.81 } ],
    "gravity": -0.00272
  },
  "arena": { "thirdAxis": "none" | "sidestep", "ringOut": false, "halfWidth": 384 },
  "throw": { "damageFraction": 0.21, "escapable": false, "whiffsOnCrouch": true }
}
```

`src/sim/Fighter.ts` already integrates a launch speed and a gravity, already runs
startup/active/recovery, and already has a `blocking` concept — so "hold-away" and "guard-button"
are a branch in one place, and `by-hold` jumps are a second entry in a table the sim already reads.

## 9. Where to measure next

3rd Strike is in, and it turned out to be the **easiest** board of the four rather than the hardest:
the `sfiii3n` "NO CD" set is 70MB with no disk image, MAME rates it `good`, work RAM is a 512KB
share, savestates are supported, and it runs at about **2400% of real time** — a run that costs
three minutes on Virtua Fighter 2 costs eight seconds here. Anything else wanted from this game is
cheap.

What is still missing, in the order I would do it:

1. **EX moves and super meter**, which is what most separates 3rd Strike's economy from Champion
   Edition's and which no column here describes at all.
2. **True startup figures**, for every board except Champion Edition. Only that one has real
   startup/active/recovery, read from the game's own counters; Virtua Fighter 2 has a phase word and
   so has real numbers too, but Tekken 3 and CPS3 both give upper bounds because no phase word was
   found on either.
3. **Tekken 3's phase word**, if it has one. Its frame-data column is animation lengths because none
   was found, and that is the weakest row in the table.
4. **Virtua Fighter's stagger system**, the last unmeasured piece of its triangle.
