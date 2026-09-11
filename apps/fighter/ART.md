# Fighter art

**The prompts live in [PROMPTS.md](PROMPTS.md).** That file is generated, it is the working copy,
and it is the one to open when you actually want to make art. This file is why it is shaped the way
it is — read it once, then don't.

Same idea as [the cabinet art](../arcade/ART.md): draw the layout ourselves, hand it to a generator
with the art to match, cut the result back out by arithmetic. Two things a sprite needs that a decal
does not — **alpha**, and **an anchor** — plus a third that only shows up once there are two sheets:
**scale reconciliation**.

---

## The decision that shapes everything

You named both Street Fighter II and Mortal Kombat / Pit Fighter / Time Killers. Those are opposite
production methods: SF2 was pixels placed by hand, the others photographed actors and digitised them.

**We do the second one**, because it is the one a generator can actually do, and because it is the
only one that also gives us a 3D model. Generators are genuinely bad at true hand-placed pixel art —
you get something that looks like pixel art photographed through a screen door.

So: **generate high-resolution painted figures, quantise down to a sprite if you want that look.**
The same source art feeds the 2D sprite and the 3D reconstruction. One character bible, two products,
nothing drawn twice.

## The templates

```bash
node scripts/fighter-template.mjs
```

| Template | Boxes | What it is |
|---|---|---|
| `reference.png` | 8 | The character bible: full figure, three heads, hands, feet, gear, palette |
| `moves-a.png` | 20 | **A complete playable fighter.** Movement, guard, every normal, throw, reactions |
| `moves-b.png` | 20 | Specials, in-between frames, flourishes. Box 1 is a scale anchor, not a pose |
| `stage.png` | 3 | One arena as far / mid / floor parallax layers |
| `props.png` | 20 | Cut-out scenery objects to dress a stage |
| `turnaround.png` | 8 | One pose from eight cameras. 3D pipeline only |
| `portrait.png` | 1 | Select-screen mug shot, square |

They land in `apps/fighter/art-templates/` and are copied into `ext/`, which is the scratch
directory art goes in and out through.

**The canvas is 2390×1792** — exactly what the generator returns, and exactly 4:3. Matching it means
no resampling of our grid lines going in and a 1:1 pixel mapping coming out. Anything else 4:3 still
works; the cutter centre-crops whatever isn't and says so.

**The grey is not decoration.** `#8f8f8f` inside a box is the key colour — it becomes alpha. The
gutters are darker and get thrown away with the labels. The faint line across each pose box is the
floor.

### Why twenty boxes and not forty

Not pixels — geometry. Every pose on a sheet must be drawn at one shared character scale, and the
widest pose in the set (a sweep) is about 1.35× as wide as the fighter is tall. That sets the box
aspect, and the box aspect sets how many fit:

| Grid | Boxes | Box | Fighter | Sweep needs | |
|---|---|---|---|---|---|
| 4 × 3 | 12 | 547×504 | 413 tall | 557 wide | doesn't fit |
| **5 × 4** | **20** | **431×362** | **296 tall** | **399 wide** | **fits** |
| 6 × 4 | 24 | 353×362 | 296 tall | 399 wide | doesn't fit |

296px is comfortably above what the machines this imitates ever had, and the painted look upscales
far better than pixel art would — which is the other half of the reason for choosing it.

The real ceiling above twenty isn't resolution, it's the generator losing track of its own
instructions. That's why the sheet prompts put **six numbered rules before the pose list** instead of
after it: when it gets absorbed in drawing twenty poses, the invariants are what it silently drops.

## The loop

```bash
node scripts/fighter-sheet.mjs ext/kestrel-a.png kestrel moves-a --dry-run   # look first
node scripts/fighter-sheet.mjs ext/kestrel-a.png kestrel moves-a             # install
```

`--dry-run` cuts to `shots/` and builds a contact sheet over a checkerboard, which is the only way to
see whether the alpha is right — alpha over white looks exactly like white.

Flags: `--fuzz N` tunes key tolerance (default 14 — raise if grey survives, lower if the costume is
being eaten), `--keep-bg` skips keying so you can matte a frame by hand, `--only a,b,c` redoes
individual frames.

Each line ends with what percentage of the box survived. **Over 92% means the key failed** — usually
the generator shaded the background or put the figure on a floor. Under 12% means it ate the
character.

### The anchor

Every frame trims to its own bounding box. A sweep is wide and short; an uppercut is tall and narrow.
Draw them all from the same corner and the character jitters around the screen.

So the template puts a floor line at a known height in every box, and the cutter records where that
line and the box's centre line ended up **relative to each trimmed frame**. That pair goes into
`frames.json` as `anchor`, and the game subtracts it from the character's world position.

```json
"punch-heavy": { "file": "punch-heavy.webp", "w": 205, "h": 335, "anchor": [24, 335] }
```

### Scale reconciliation

Two sheets generated in two conversations will not agree on how big the character is, and **there is
no way to prompt around it** — the model cannot see the other sheet.

So every sheet after the first repeats one pose (IDLE) purely as a ruler. The cutter measures it,
compares against the IDLE already installed, rescales every frame from the new sheet to match, and
throws the repeat away:

```
scale: this sheet's idle is 153px against 196px installed
rescaling every frame from this sheet by 128.1%
```

This is the single thing standing between a character who animates and a character who breathes.

## Stages

Three parallax layers on **one canvas**, because layers generated separately never agree about
palette, light direction or time of day, and a background whose layers disagree reads as a collage.
Then twenty cut-out props in the same palette. Four arenas are defined in
`scripts/fighter-prompts.mjs`: the drained reservoir, the container yard, the car park roof, the
foundry floor.

The stage sheet is **not keyed** — a backdrop with its background removed is nothing. The cutter
knows this and skips keying for `stage` automatically.

**3D is pencilled in, not designed.** When the 2.5D camera exists, these same descriptions become the
brief for a modelled set and the generated layers become the concept art you model from, rather than
the thing that ships. That is how the cabinets went: templated projections of concept art.

## When it goes wrong

| What you see | What to say |
|---|---|
| Poses at different sizes | *"Rule 2: exactly the same height in every box."* Regenerate — this cannot be fixed in the cutter |
| Figures crossing the gutters | *"Keep each pose entirely inside its own box."* |
| A shadow or floor under the feet | *"The background inside each box must be completely flat unshaded grey."* Shadows survive the key and smear under the sprite |
| Key ate the costume | Costume too near the key grey. `--fuzz 8`; if that leaves a halo, regenerate the bible with grey out of the palette |
| Grey left round the figure | `--fuzz 20`. If that fails the background was shaded and the sheet needs redoing |
| Glow baked into a special | Describe the body, never the effect. Regenerate and re-cut with `--only` |
| KO standing up | It's the only lying-down pose and generators resist it. *"Lying flat on their back on the ground, seen from the side."* |
| Face drifts between sheets | Attach the bible **first** and say *"match the face in image 1 exactly"* |

Three or four bad boxes out of twenty is normal, and is what `--only` is for.

## Where it lands

```
apps/fighter/
  art-templates/        the blanks + sheets.json — regenerate, never hand-edit
  public/chars/<id>/
    idle.webp …         keyed, trimmed frames
    frames.json         size and anchor per frame
  public/stages/<id>/   far.webp, mid.webp, floor.webp, and the props
ext/                    scratch; templates and generator output, not committed
shots/                  dry-run output and contact sheets, not committed
```
