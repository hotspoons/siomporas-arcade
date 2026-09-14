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
| `cycle.png` | 6 | **Six frames of ONE animation.** The route that actually works |
| `cycle-4.png` | 4 | The same at four, for lighter characters |

They land in `apps/fighter/art-templates/` and are copied into `ext/`, which is the scratch
directory art goes in and out through.

**The canvas is 2390×1792** and the model we serve returns **2048×1536**. Both are exactly 4:3, the
cutter works in fractions of the sheet rather than pixels, and the difference costs nothing but
detail. Above about 3.2 megapixels the card runs out of memory. Anything that isn't 4:3 gets
centre-cropped and the cutter says so.

**The green is not decoration.** `#00b140` inside a box is the key colour — it becomes alpha. The
gutters are darker and get thrown away with the labels. The faint line across each pose box is the
floor.

**It used to be grey, and grey does not work.** Not for want of tolerance: a generator does not read
a flat grey field as a key colour, it reads it as a *lit studio wall*, and then lights it — a
gradient across the background and a cast shadow under the feet, in every box, ignoring every
instruction against it. The shadow is grey, the wall is grey, and the key is grey, so no `--fuzz`
setting separates them; raising it to 35 ate the costume while the shadows survived. Chroma green
fixes it on the first attempt, because the model knows a green screen is a surface that is not a
surface. If a character's costume genuinely needs green, redraw the templates with
`node scripts/fighter-template.mjs --key=magenta` — never fork a recoloured copy.

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

### The prompt is cut off at about 2000 characters

Measured against the served model, not guessed. Put a loud instruction — *"THE CHARACTER WEARS A
LARGE BRIGHT YELLOW HAT IN EVERY BOX"* — at character 1200 of a prompt and the picture changes. Put
the same sentence at 2200 and the picture is **byte-identical** to the one without it. The cutoff is
somewhere between 1700 and 2200, which is what a 512-token text encoder looks like from outside.

Nothing reports this. No error, no warning, no field in the response. A rule past the cutoff has not
been weakly applied — it was never read, and that is indistinguishable from a model that ignores
instructions until you test for it.

The ceiling has since been raised to 2048 tokens on the cluster — it is a pipeline default rather
than an encoder limit, and the HTTP API cannot set it, so the deployment patches it at startup. That
removes the *silent* loss, and it is worth having for that alone. It did not make the art better:
with the whole bible prompt arriving, the character finally came out right, and the sheet layout
fell apart instead — heads boxes full of torsos, an empty palette. Past roughly two thousand
characters this model trades one rule for another.

**So write to the first ~1800 characters regardless**, and the order of one is a budget rather than
a matter of taste. Two consequences worth stating plainly, because both were mis-diagnosed here
first:

- The style paragraph sits at the bottom of every prompt in this pipeline and has therefore never
  been read by anything. What carries the style is the attached bible, which is why attaching it
  works and describing it does not — the description was not losing to the image, it was not
  arriving.
- A long list of numbered rules spends the budget on its own tail. The rules that held were the
  early ones. Adding an important rule at the bottom of the list, as happened with proportions
  twice, changes nothing at all and looks like the model refusing.

### Attach the bible as an image, never as a description

The style is the bible's job and it cannot be carried in words. Describing it — "a photographed
actor in costume, retouched into hard-edged illustration" — gets you a photograph of an actor, which
is half the sentence and the wrong half. Attaching the bible alongside the template gets the painted
look, and brings scale consistency with it.

That needs the generator to accept two images, which took a fix; `scripts/flux-art.mjs` has the
detail. The consequence for this file is simpler: **whatever the bible gets wrong is inherited by
every frame drawn from it.** A bible with cast shadows produces sheets with cast shadows no matter
what the sheet prompt says. Fix the bible and regenerate; do not fight it downstream.

### Except that twenty doesn't work, and six does

The argument above is sound about geometry and wrong about what a generator will hold. Run against
`moves-a`, the 9B model **rewrote the 5×4 grid into twelve boxes of its own**, painted the template's
labels into the artwork as garbled lettering (`JFOLE`, `WEHT PICHD`, `FALK PUNGH`), invented a gold
disc into the character's hand in nearly every frame, and cast a shadow under every pose. Four of
twenty boxes were the pose that was asked for.

Six boxes of **one animation** holds perfectly: grid intact, facing right, no invented props, feet on
the line. The frames differ by inches, so the model has one drawing to get right and five small
variations of it — the easiest thing on the list rather than the hardest. Hence `cycle.png`, and
hence Phase 1 of PROMPTS.md.

The boxes on the cycle sheets carry **no label and no number**, because the model copies lettering
into the art wherever it finds it — on the six-box sheet it duplicated the numerals into the boxes
two and three times over. There is nothing a label tells it that the prompt cannot.

What six boxes buys that twenty never could is **motion**. `moves-a` gives one drawing per move, held
for however many frames the move is active; the arcade board spends six drawings on Ryu's idle and
four on Chun-Li's. The cost is honest — a character is eight or nine generations rather than one.

## The loop

```bash
node scripts/fighter-sheet.mjs ext/kestrel-a.png kestrel moves-a --dry-run   # look first
node scripts/fighter-sheet.mjs ext/kestrel-a.png kestrel moves-a             # install
```

`--dry-run` cuts to `shots/` and builds a contact sheet over a checkerboard, which is the only way to
see whether the alpha is right — alpha over white looks exactly like white.

Flags: `--fuzz N` tunes key tolerance (default 14 — raise if the key colour survives, lower if the
costume is being eaten), `--keep-bg` skips keying so you can matte a frame by hand, `--only a,b,c`
redoes individual frames, `--untrimmed NAME` hands the frames to the packer instead of installing
them.

### `--untrimmed`, and who owns the anchor

For the cycle sheets the cutter stops short of trimming:

```bash
node scripts/fighter-sheet.mjs ext/kestrel-idle.png kestrel cycle --untrimmed idle
node scripts/pack-frames.mjs ext/art/kestrel kestrel --height 90 --contact
```

It writes `ext/art/kestrel/idle/00.png…` — the keyed box, uncropped, every frame identically sized —
plus `pack.json` carrying `floorY` and `anchorX` derived from the template geometry. `pack-frames.mjs`
then computes the anchors and writes `atlas.png` + `frames.json` where the game actually looks,
`public/assets/crown/chars/<id>/`.

The point of stopping short is that **the anchor should have one owner**. Both scripts had grown
their own arithmetic for it, and two sources of truth for the number that keeps a character from
jittering is a bug waiting for a quiet afternoon. Handing over whole boxes makes the shared baseline
structural rather than something the cutter promises.

Each line ends with the **mean alpha** of the cut box — how much of it is actually still opaque.
Over 92% means the key failed; under 6% means it ate the character. A normal full-height figure reads
around 20%, because a standing body is mostly gaps between its own limbs.

(This used to measure the *bounding box* instead, which is a different question and the wrong one: a
figure drawn nearly box-height legitimately fills 90% of its bounding box, so every frame of a
six-box sheet was reported as a failed key.)

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
| A shadow or floor under the feet | You are on a grey template. Regenerate the templates — they are green now, and this is the failure green exists to fix |
| Feet clipped at the bottom edge of the box | The figure was drawn too large. The frame's lowest row becomes the box edge instead of the sole, so the anchor is wrong and the character sinks into the floor. Ask for three-quarters box height with clear space below the feet |
| Key ate the costume | Costume too near the key colour. `--fuzz 8`; if that leaves a halo, regenerate the bible with that colour out of the palette, or switch the key with `--key=magenta` |
| Key colour left round the figure | `--fuzz 20`. If that fails the background was shaded and the sheet needs redoing |
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
