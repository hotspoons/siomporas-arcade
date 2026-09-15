# A fighting game builder's menu, measured from three arcade boards

Written for whoever builds the mechanics-picker — the thing that lets you choose "Street Fighter's
defence with Virtua Fighter's throws" and get something that feels like a real game.

Everything below was measured by driving the original boards headlessly in MAME and reading their
memory, not taken from a wiki. `tools/sf2-probe` does the 2D one, `tools/t3-probe` the two 3D ones,
and the per-board notes in `research/rom/` carry the addresses, the methods and the mistakes.

| | Street Fighter II: Champion Edition | Tekken 3 | Virtua Fighter 2 |
|---|---|---|---|
| board | CPS1 | Namco System 12 | Sega Model 2 |
| our config today | `src/data/system.json` + `chars/*.json` | — | — |

## 1. Defence — the switch that changes the most

This is the one to expose first, because everything else bends around it.

| | how you defend | can you move while doing it | does it cost you |
|---|---|---|---|
| **Street Fighter II** | hold away from the opponent | **yes** — blocking *is* retreating | a blocked special still chips you (`chipFraction: 0.25`) |
| **Tekken 3** | **nothing at all** — standing still guards highs and mids | yes, you are simply standing | nothing |
| **Virtua Fighter 2** | **hold the Guard button** | **no — rooted, exactly 0.000 units in 120 frames** | nothing in health |

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

The striking agreement: **a throw is worth about a fifth of a health bar in both games that we can
measure one in**, 22.2% and 20.4%, five years and two hardware generations apart. That looks like a
constant of the genre rather than a coincidence, and it is a good default for a builder.

Tekken's row is thin because only one attack was ever landed on it — see §7.

## 3. Speed

| | fastest attack, frames to contact | a normal, start to finish |
|---|---|---|
| Street Fighter II | **3** (jab) | 12–35 |
| Virtua Fighter 2 | **8** | 19–40 |
| Tekken 3 | 14 (its one measurable attack) | 40–67 *(animation length, an upper bound)* |

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

## 9. The gap worth filling next

**Street Fighter III: 3rd Strike.** It is `status="good"` in MAME 0.276 — fully emulated — and it is
the 2D game most people would name as the finest of them, on the strength of one mechanic this table
cannot express at all: the **parry**, a defence with no blockstun and no chip that costs you a
precise input instead of a held direction. A fourth column would give the builder a defence option
that is neither "hold away" nor "press a button" but "be right at the exact moment", which is the
most celebrated idea in the genre.

It needs its CD image rather than just the ROM zip, which is a larger download than anything here so
far.
