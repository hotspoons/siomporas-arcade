# sf2-probe — pulling the fight out of the Champion Edition ROM

Runs Street Fighter II: Champion Edition (`sf2ceea`, CPS1/68000) headless in MAME 0.276, drives both
sticks from Lua, reads the game's own object structs and box tables every frame, and distils the
per-frame logs into the config files under `apps/fighter/research/rom/sf2ce/`.

Everything measured here is in the units the arcade used: pixels of a 384×224 screen, frames of a
59.64 Hz display (called 60 Hz everywhere), damage in points of a 144-point life bar.

## Running it

```
tools/sf2-probe/rebuild-romsets.sh                       # once: rename the ROM zips for MAME 0.276
export PROBE_SCRATCH=/tmp/sf2-probe                      # nvram/cfg/snapshots/savestates (default: ext/reference-artwork/rom-dumps/mame)

# 1. boot into a two-player VS match and save a state (≈35 s wall clock)
PROBE_P1=ryu PROBE_P2=zangief tools/sf2-probe/run.sh boot            # -> match_ryu_zangief.sta
PROBE_P1=ryu PROBE_P2=zangief tools/sf2-probe/run.sh boot sf2        # same for World Warrior / sf2hfu for Hyper Fighting

# 2. record the standard plan for a character (≈1–3 min; writes a 200–300 MB JSONL)
PROBE_STATE=match_ryu_zangief PROBE_CHAR=ryu PROBE_PLAN=tools/sf2-probe/lua/plans/char.lua \
  PROBE_TIMEOUT=1800 PROBE_SECONDS=1700 tools/sf2-probe/run.sh record.lua
#    -> ext/reference-artwork/rom-dumps/sf2/sf2ceea/ryu.jsonl   (PROBE_OUT overrides the directory)

# 3. derive
node tools/sf2-probe/derive/derive.mjs  ext/reference-artwork/rom-dumps/sf2/sf2ceea/ryu.jsonl ext/reference-artwork/rom-dumps/sf2/sf2ceea/ryu.raw.json --char ryu
node tools/sf2-probe/derive/tochar.mjs  ext/reference-artwork/rom-dumps/sf2/sf2ceea/ryu.raw.json apps/fighter/research/rom/sf2ce/ryu.json --seed apps/fighter/src/data/chars/ryu.json
node tools/sf2-probe/derive/tosystem.mjs apps/fighter/research/rom/sf2ce/system.json ext/reference-artwork/rom-dumps/sf2/sf2ceea/*.raw.json
```

`run.sh` adds the flags that make MAME behave in a container: `-video none -sound none -nothrottle
-skip_gameinfo -seconds_to_run N` and per-instance `-cfg_directory` when you run several at once
(pass it as an extra argument). Never pass `-console`; it blocks on stdin. The ten zero-filled PLD
stand-ins make MAME print WRONG CHECKSUMS warnings, which `run.sh` filters.

Raw logs stay under `ext/reference-artwork/rom-dumps/` (gitignored). Only the distilled JSON lives in
`apps/fighter/research/`.

## What each script does

| file | role |
|---|---|
| `lua/common.lua` | address map per romset, input field names, character ids, select-screen grid, helpers (`hold`, `snapshot`) |
| `lua/dumpgfx.lua` | the board's whole graphics region (6 MB) to `gfx.bin`, the live palette, and the CPS-A/B registers. MAME has already stitched the twelve mask ROMs together, so this is the bytes the hardware reads |
| `lua/pose.lua` | one frame from every side at once — the hardware sprite list, the palette, both fighters' positions, and MAME's own screenshot. The decoder in `scripts/rom-sprites.mjs` was checked by drawing this list and diffing it against that screenshot |
| `lua/plans/react.lua` | a short plan for the *other* side of a fight: the flinches, the guards, the sweep knockdown, the throw and the stars, recorded while the character of interest is player two |
| `lua/recon.lua` | what a board looks like from the outside: its regions, shares, screens and palette, a coin, a start, and a picture. The first thing to run on a game that is not Street Fighter II |
| `lua/dumpvideo.lua` | `dumpgfx.lua` for a board whose graphics region has another name (`PROBE_REGION=:video`) |
| `lua/dumpobj.lua` | one frame's sprite list, palette and screenshot from a board whose list this code knows nothing about: it finds the list by looking for a run of records that land on the screen with a non-zero tile code |
| `lua/findobj.lua` | the same search, printing its candidates instead of dumping, for when the answer is not obvious |
| `lua/boot.lua` | power-on → coin ×2 → 1P start → 2P start → cursor routes → picks → waits for `FF8008 & 0x0A == 0x0A` (controls live) → `machine:save(match_<p1>_<p2>)`. Deterministic frame counts; a whole boot is ≈2100 frames. |
| `lua/record.lua` | the move recorder. Loads a state, runs a plan of tests. Every test: wait until both fighters are neutral and still, teleport them (`+0x06`, `+0x1CC`), zero velocities, refill health, settle 14 frames, then feed P1 a per-frame input script while P2 plays the dummy. Writes one JSON line per frame. The round timer is frozen by rewriting the 40-frame sub counter every frame. |
| `lua/plans/gen.lua` | builds the standard plan for a character: calibration (idle, walks, crouch, three jumps, landing), every standing/crouching/jumping normal as whiff / close-whiff / hit / far hit / block / vs crouch / crouch block (3 hit repetitions for the damage spread), 8 throws ×3, throw range probe, close/far range probe every 2 px, specials × strength × {whiff, hit, block, crouch hit, crouch block}, two dizzy accumulation runs, dizzy-threshold pokes, and an unfrozen timer run |
| `lua/plans/chars.lua` | special-move input recipes per character (`@` = the button) |
| `lua/plans/char.lua` | plan entry: `PROBE_CHAR`, `PROBE_REPS` |
| `lua/plans/far.lua` | supplement: far-version hits/blocks at `PROBE_FAR="lp:78,mp:84,..."` (each button's measured close range + 8); its output is appended to the main JSONL before deriving |
| `lua/plans/air.lua` | supplement: later/further jump-in attempts for air normals that never connected |
| `lua/plans/explore*.lua`, `inputs.lua`, `charge*.lua` | the exploration and input-timing experiments that established the map below; kept as examples of ad-hoc plans |
| `derive/derive.mjs` | JSONL → `<char>.raw.json`: frame windows, active frames, boxes in fighter space, contact analysis (damage spread, dizzy points, freeze, stuck frames, pushback, knockdown), projectiles, throws, ranges, dizzy probes |
| `derive/tochar.mjs` | raw → the `apps/fighter/src/data/chars/*.json` shape plus a `rom` block per move |
| `derive/tosystem.mjs` | raws → `system.json` shape: the numbers that are the same for everyone |
| `derive/editions.mjs` | Ryu on WW / CE / HF side by side → `ryu-editions.md` |
| `derive/report.mjs` | compact tables for one shaped character and its differences from the seed |

### Dummy modes (P2)

`p2 = {pre, post}`: stick held before contact and after the reaction state begins. Shorthands:
`stand`, `crouch`, `block` (hold back), `cblock`, `upafter` (stand, then hold up → the first frame the
dummy enters prejump is the first frame it could act), `blockup`, `crouchup`, `cblockup`. The switch
happens only once `+0x03` reads `0E`/`14`: switching on the freeze frame itself lets the game read
"up" while it enters the reaction and turns a stagger into an air reset.

### Per-frame log line

```
{"test":"stand-hp__hit__1","f":6,"in1":"hp","in2":"","timer":"99","scr":451,
 "p1":{"x":520,"y":40,"fl":1,"st":10,"sub":2,"an":"04c498","dur":2,"hp":144,"frz":14,
       "vx":0,"vy":0,"stun":0,"stunT":0,"thr":[..4],"thrable":[29,53],
       "rec":"<24 bytes of the animation record>",
       "bx":[{"t":"atk","id":5,"cx":-43,"cy":71,"rx":31,"ry":13,"raw":"d5471f0d0b012a0002020300"}, ...],
       "obj":[[x,y,code,attr], ...],   # CPS1 OBJ entries within ±96 px of the fighter
       "r0":"<+0x40..+0x9F hex>","r1":"<+0x100..+0x1CF hex>"},
 "p2":{...},"proj":[{"i":0,"x":600,"y":96,"an":"0319a6","bx":[...],...}]}
```

Box centres are in the game's native object space: `cx` positive is *behind* the fighter (sprites
and box data face left), `cy` positive is up from the feet. `derive.mjs` converts to fighter space:
`[x0,y0,x1,y1] = [-cx-rx, cy-ry, -cx+rx, cy+ry]`, +x forward, +y up, origin at the feet.

## Memory map (sf2ce / sf2hf; World Warrior offsets in the second column)

| what | sf2ce | sf2 (WW) |
|---|---|---|
| match flags (word) | `FF8008` — bit 3 match in progress, bit 1 controls live | same |
| P1 object | `FF83BE` (P2 = +0x300) | `FF83C6` |
| projectiles | `FF9376`, 0xC0 apart, ≤8, live when word at base == 0x0101 | `FF938A` |
| camera left edge | `FF8BC4` (i16) | `FF8BD8` |
| round timer | `FF8ABE` BCD, `FF8ABF` sub counter reloaded to 0x28 (40 frames per tick) | `FF8ACE` (30 frames per tick) |
| select-screen picks | `FF894D` P1 has picked, `FF894F` P2 cursor character id | different |
| CPS1 OBJ list | gfxram `910000`, 8 bytes per sprite `x,y,code,attr`, ends at attr ≥ 0xFF00; screen = (x−64, y−16) | same |

### Player object (0x300 bytes)

| offset | type | meaning |
|---|---|---|
| `+0x00` | u8 | 1 = object live |
| `+0x03` | u8 | state: `00` standing/neutral, `02` crouching, `04` jumping (sub `00` prejump, `02` airborne, `04` landing, `06` air attack), `06` landing after an air attack / getting up, `08` guard stance (proximity block), `0A` normal attack, `0C` special move, `0E` hit or block reaction, knockdown and dizzy, `14` thrown |
| `+0x04` | u8 | sub-state (`02` while animating, `00` on the frame a new state is entered) |
| `+0x06` | i16 | pos_x, world px (players start at 552 / 728) |
| `+0x0A` | i16 | pos_y, world px, 40 = floor, up is positive |
| `+0x12` | u8 | 1 = facing right |
| `+0x19` | u8 | frames left on the current animation record |
| `+0x1A` | u32 | animation record pointer (ROM) |
| `+0x2A` | i16 | health, 144 full; `+0x2C` the value the life bar drains toward |
| `+0x30` | u32 | per-character table (0x10 bytes each) |
| `+0x34` | u32 | box table pointer (ROM) |
| `+0x38` | u32 | per-character table (0x20 bytes each) |
| `+0x42` | u16 | gravity, 8.8 fixed (Ryu 0x0050 = 0.3125 px/f²) |
| `+0x47` | u8 | hit freeze countdown; 0x0E on every contact |
| `+0x5D` | u8 | dizzy meter timer; each hit adds 40 (light) / 60 (medium) / 80 (heavy) / 130 (sweep) / 120 (specials); the meter clears when it reaches 0 |
| `+0x5F` | u8 | dizzy meter; dizzy when it would exceed 30 |
| `+0x64..6B` | i16×4 | throw box x, y, rad_x, rad_y (written when a throw is attempted) |
| `+0x6C,+0x6E` | u16 | throwable box rad_x, rad_y (Ryu 29/53, Zangief 45/53, Blanka 30/53) |
| `+0x181` | u8 | 1 while airborne |
| `+0x18B` | u8 | 1 while attacking |
| `+0x193` | u8 | free-running counter (the damage / dizzy randomness) |
| `+0x1BC` | i16 | displayed life bar |
| `+0x1C4` | i32 | velocity x, 16.16 fixed (Ryu walks 3.0 / −2.0) |
| `+0x1C8` | i32 | velocity y, 16.16 fixed |
| `+0x1CC` | i16 | pos_x mirror used by the pushback |
| `+0x291` | u8 | character id: 0 Ryu, 1 Honda, 2 Blanka, 3 Guile, 4 Ken, 5 Chun-Li, 6 Zangief, 7 Dhalsim, 8 Bison, 9 Sagat, 10 Balrog, 11 Vega |

### Animation record (ROM, 0x18 bytes, `+0x1A` points at one)

```
+00 flags?   +01 duration (frames)   +02 0x80 = last record of the sequence   +03 walk-cycle index
+04 u32 sprite list pointer
+08 vuln box 1 id  +09 vuln box 2 id  +0A vuln box 3 id  +0B "weak" box id (unused in CE)  +0C attack box id  +0D push box id
+0E u16 per-character sprite constant (Ryu 0x1B80 idle / 0x1B96 attack; Zangief 0x26xx)
+16 flag (1 on recovery frames and while airborne)   +17 move tag (FF neutral; 03 fierce, 05 sweep, 09 tatsumaki, 0A shoryuken, 06/17 jumps)
```
Ryu's fierce: `04C480` (dur 4, no attack box) → `04C498` (dur 2, attack 5) → `04C4B0` (dur 6, attack 6)
→ `04C4C8` (10) → `04C4E0` (12) → `04C4F8` (end). The first record shows one frame less than its
duration because the frame the input is accepted still draws the previous pose.

### Box tables (`+0x34` → header of six i16 offsets)

Ryu `0A826C`: `000C` vuln1, `00C0` vuln2, `0138` vuln3, `01A0` weak, `01A8` attack, `03E8` push.
Zangief `0A9B54`: `000C 0090 00DC 0120 013C 0128`. Entry = `hitbox_ptr + offset + id*size`; size 4 for
vuln/push (`x i8, y i8, rad_x u8, rad_y u8`), 12 for attack (`x, y, rad_x, rad_y, damage-ish index,
alt x (used when ≥0x80), sound?, 0, strength index ×3, 0`). x positive is behind the fighter.

### Sprite list (record `+04`)

Header of five words: `[OBJ count] [size<<8 | palette] [x offset] [y offset] [?]`, then a grid of
16-bit CPS1 tile codes, column-major, 0 = empty cell. A single-sprite pose is a 12-byte record
whose `[1]` carries the block size (`0x5301` = 4×6 tiles, palette 1) and whose last word is the tile
code. Rather than decode the grid dims, the recorder captures the hardware OBJ list every frame
(`obj` per fighter): `x, y, code, attr` with `attr = size<<8 | flipy<<6 | flipx<<5 | palette`, screen
position `(x-64, y-16)`. Ryu idle = one block sprite, code `0x0060`, pal 1, 4×6 tiles; Zangief idle =
38 single tiles `0x88xx`, pal 7. Those codes index the CPS1 gfx ROMs directly.

## Conventions in the distilled JSON

* frame 1 of a move is the frame the game accepts the input (`+0x03` changes; the old pose is still drawn)
* `startup` = frames before the first frame with a live attack box (the move hits on frame `startup+1`)
* `active` = frames with an attack box out (whiff run, no freeze); `recovery` = frames after the last active one until `+0x03` is neutral again
* `hitstop` = attacker freeze (14 on every contact; the defender freezes 16); `hitstun`/`blockstun` = frames from the end of the attacker freeze until the dummy's jump input is accepted
* `stuckOnHit` in the `rom` block = frames from contact to the dummy acting, freeze included
* `damage`, `dizzy` carry `{min,max,mean,samples}` — both are randomised per hit
* boxes `[x0,y0,x1,y1]` in fighter space, +x forward, +y up, origin at the feet

## The sprites

`scripts/rom-sprites.mjs` draws the fighters out of `gfx.bin`. Read its header for the tile format
and how it was established; the short version is that a tile is 16x16 in 128 bytes, four bitplanes
per eight pixels, colour 15 transparent, and that the sprite list gives the block size, the flips and
the palette. The recorder already logged the sprite list around each fighter every frame, so no new
run is needed for a character's own moves — the poses come out of the same logs the frame data did,
and are named after the moves that play them.

Two things do need their own runs. A character never flinches in its own recording, because it is the
one attacking, so `plans/react.lua` records it as the dummy; and a character's colours have to come
from a match where it was player one, because player two wears the alternate palette
(`PROBE_TAG=<char> pose.lua`, one per character).

## Other boards

The same two questions decide how far this travels: is there a graphics region that decodes, and is
there a list in RAM saying what is drawn where. `lua/recon.lua` answers the first half in one run.

| board | game | pixels | sprite list | how it went |
|---|---|---|---|---|
| CPS1 | Street Fighter II, all editions | yes | yes | **done end to end.** `:gfx` decodes, the list is in gfxram at the page CPS-A register 0 points to, the palette device holds finished RGB |
| CPS2 | Super Street Fighter II Turbo | yes | yes | **verified.** The same decoder, unchanged: `node scripts/rom-frame.mjs ssf2t` draws the board's own frame back pixel for pixel. The list moved to `objram1`/`objram2` and the top bits of x and y are flags rather than position, both of which `dumpobj.lua` works out by itself. What a full extraction still needs is the per-game part: where the fighters' structs live and what their animation records look like |
| Neo Geo | Samurai Shodown | probably | **no** | boots and plays, and `:cslot1:sprites` is 10 MB of what should be ordinary tiles — but the sprite list lives in video RAM that the driver keeps to itself, and no memory share exposes it. Poses from this board would have to be captured off the screen, or the driver patched |
| Midway T-unit | Mortal Kombat | **no** | n/a | boots and plays, and can be driven and screenshotted like anything else — but its 12 MB `:video` region is not a tile bank. About a third of it is zero, so the pixels are in there, yet neither a linear read nor Midway's usual bank interleave produces a picture: the blitter reads an encoded stream, and decoding it is its own project |

### Getting a set to run at all

Romsets are labelled for the MAME that made them, so `rebuild-romsets.sh` matches by CRC and renames.
Two traps, both of which look exactly like a bad dump:

* **Blanks are 0xFF, never 0x00.** A CPS2 set that ships already decrypted declares an all-FF key
  region, and the driver reads that as "nothing to decrypt". Zeros mean "decrypt with a zero key",
  and the game boots to a screen of noise.
* **A romset lists every BIOS revision ever dumped** and the machine runs on any one of them, so
  `SKIP_MISSING` takes a pattern for names that are not really missing — that is what makes a Neo
  Geo set build from a collection that has only some of them.

The MAME 2003 set has no CPS2 decryption keys and only MAME-generated Neo Geo BIOS stand-ins. The
2015 set has real BIOS dumps, and for CPS2 it has the *Phoenix* sets — bootlegs that were decrypted
once and for all, which need no key at all. `ssf2tad` is the one this used.

`tools/sf2-probe/rebuild-romsets.sh` takes a `PATTERN` for the family to rebuild, and a `BLANK_MAX`
for how large a missing file may be before it is stood in for with zeros — 300 bytes by default,
which covers PLD equations; `BLANK_MAX=100000` also covers a sound DSP, at the cost of audio we do
not record. Never blank a program ROM or a decryption key: the game will boot to a black screen.

## Known gaps

* The 68000 code that maps attack-table bytes to damage / dizzy points was not disassembled; the
  distilled values are measured (3 samples per hit, more for the calibration probes) and the
  randomness is reported as a range.
* Special-cancel (2-in-1) windows were not measured.
* Landing after an empty jump reads as 1 frame; a normal pressed on the frame after touchdown comes
  out.
* The fireball's sprite is captured by taking the objects near the projectile in a palette that is
  not the fighter's. It comes out looking right but has not been diffed against a MAME frame the way
  the fighters were.
* World Warrior's select-screen variables were not found; `boot.lua` still lands in Ryu vs Zangief on
  `sf2` because the cursor starts on those characters. Hyper Fighting's turbo skips display frames, so
  its frame counts are display frames, ≈0.7 of CE's.
* Zangief's crouching MP/HP next to the dummy come out as a grab (28 damage) — recorded, but the
  crouching-strike data for those two comes from the far-distance hit tests.
* Command throws (SPD) show as jumps on whiff; only their hit data is meaningful.
* Mashed specials (Honda's hands, Chun-Li's lightning legs, Blanka's LP/HP electricity) come out
  after the first button press has already produced a normal; their whiff frames are recorded but
  the hit tests were spoiled by the dummy reacting to that normal, so their damage is missing.
* Ken's shoryuken reads 1 frame of startup, Blanka's rolling attack 0: the first animation record of
  those moves already carries an attack box, so the box is live on the frame after the input.
* Heavy multi-hit normals (Ryu/Ken close HK, Zangief close HK, Honda close HK and crouch MK, Blanka
  close MK, Dhalsim close HP) hit twice; their `hitstun`/`pushHit` are the totals of both contacts
  and `hits` says 2.
