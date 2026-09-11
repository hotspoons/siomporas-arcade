# Cabinet art

**You do not have to do any of this.** Every cabinet already has its marquee — the lit sign on top,
which is also the menu item — and a cabinet missing the rest shows painted body in the game's colour,
which reads fine. What follows is polish, in whatever order and amount you feel like.

It is also *checkable*. Artwork that is nearly right is the whole problem with generating it — a
flank a few percent out shows as a pale hem along the bottom of a machine, a marquee of the wrong
shape makes one cabinet taller than the two beside it — and none of that is visible in a contact
sheet. So before anything else:

```bash
just art-check            # measure every panel against the machine it goes on
just art-check radrun     # one cabinet
```

Every line it prints is a row of [the remediation table](#when-something-is-wrong) at the bottom of
this file: what it means, what to ask for, and what to run.

## The idea

A generator follows an outline the way a painter follows a reference, not the way a cutter follows a
template. It will not hit a shape exactly and nothing here asks it to. Instead:

**Everything is drawn with bleed.** Each slot on the template is a plain rectangle and the prompts
ask for the scene to run off all four of its sides — detail into the margins, nothing important near
an edge. What gets cut out is the slot, so artwork that overshoots is trimmed and the only thing that
can actually go wrong is artwork that falls *short*.

**The guides say where the machine is.** Inside the two side slots is the outline of a cabinet's
side, and inside the bezel is the hole the screen fills. They are drawn a shade off the slot so they
read as guidance rather than as edges to stop at: keep the logo and anything that matters inside
them, and let the background carry on past.

**The shapes come from the machine.** `scripts/lib/fit.mjs` holds the cabinet's own measurements and
every template, cutter and check reads them from there. `apps/arcade/test/cabinet-art.test.ts` fails
if they ever drift from `ART_FIT` in [Cabinet.ts](src/lobby/Cabinet.ts), so a change to the cabinet
cannot quietly leave the templates describing a machine we no longer build.

## Doing it

**One sheet, one prompt, a whole cabinet.** Hand a generator `ext/sheet.png` — a labelled blank with
a slot for each panel — plus a picture of art you want it to match, and [the sheet
prompt](#the-sheet-prompt). Then:

```bash
node scripts/cabinet-sheet.mjs ext/what-it-gave-you.png radrun --dry-run   # look first
node scripts/cabinet-sheet.mjs ext/what-it-gave-you.png radrun            # install all five
just art-check radrun
```

The panels are *found*, not assumed. Every one is artwork sitting on the template's flat grey, so the
islands of not-grey are the panels, and each is matched to the slot it sits nearest. That survives a
generator handing back its own canvas shape, which they all do — the last one returned 3:2 for a 4:3
sheet — and it cuts a panel drawn inside its slot to the artwork rather than to the slot.

**One panel at a time.** Attach that face's own template from `apps/arcade/art-templates/` with the
same reference art and [its prompt](#the-panel-prompts), and install what comes back:

```bash
node scripts/cabinet-art.mjs ext/what-it-gave-you.png radrun side-left
```

Use this to redo one face without disturbing the others, and to get a bigger image of one panel than
a shared sheet can give you.

## What a cabinet wears

| Panel | Face | Shape | Worth it |
|---|---|---|---|
| `marquee` | the lit sign on top — also the menu item | 16:9 | **the one that matters** |
| `side-left` | the left flank | the machine's outline, 0.40:1 | most of what you see |
| `side-right` | the right flank | the same outline mirrored | most of what you see |
| `panel` | the control deck, seen from above | 2.86:1 | on the machine you are standing at |
| `bezel` | the surround framing the screen | 1.49:1, hole in the middle | close up only |
| `attract` | a still for the screen | 4:3 | only where no loop was filmed |

Two things follow from the machine and are worth knowing before you ask for anything:

**The sign is as tall as its artwork**, so a marquee's shape decides how tall that cabinet is. Ask
for 16:9 and a row of machines is level; hand over a 2:1 sign and that one stands taller than its
neighbours. The cutter squares a marquee up to 16:9 by taking the excess off the ends, which is what
the margins are for.

**A flank is not a rectangle.** The side is a solid board with the screen, the speakers and the sign
recessed between two of them, and its outline was traced off a scan of a real upright: the swell of
the control panel, the monitor leaning back nineteen degrees, the speaker panel raked over it, the
sign, and a top sloping away to the back. The deep notch between the control panel and the sign is
most of the shape. The two flanks are mirror images of each other, because the front of the machine
is at the left on one and at the right on the other.

## The sheet prompt

> Attached are two images. The first is existing artwork whose style, palette, subject and lettering
> I want you to match exactly. The second is a blank layout template for the printed decals of an
> arcade cabinet: five labelled grey slots on a darker grey field.
>
> Fill every slot with finished artwork in the style of the first image. Each slot is a window onto a
> larger scene: run the artwork off all four edges of its slot, with the incidental detail — sky,
> road, ground, background — going right into the corners, and keep every logo, face, vehicle and
> word of text well inside the slot with room to spare. I am going to crop these, so anything near an
> edge may be lost and nothing important should be there.
>
> Keep each piece of artwork strictly inside its own slot and leave the grey gutters between the
> slots flat grey. The labels can go.
>
> MARQUEE: the illuminated sign, logo huge and centred with the tagline beneath it.
> SIDE — LEFT and SIDE — RIGHT: the two flanks. Inside each slot is a paler shape — that is the
> outline of the side of the machine, and the two are mirror images of each other. Fill the whole
> slot, corners included, but put the logo and everything that matters inside that shape and clear of
> the notch cut into one side of it. Two *different* scenes in the same world.
> CONTROL PANEL: the deck seen from directly above — a wide shallow band of artwork filling the slot
> corner to corner, instruction text small, logo small at one end.
> BEZEL: artwork filling the slot, with the busiest detail round the edges. The darker rectangle
> marked SCREEN is where the monitor sits: leave it flat and near-black, and do not draw a picture,
> a border or a frame inside it.
>
> All of it is flat printed decal artwork, not a photograph of an arcade machine: completely flat and
> straight on, no perspective, no cabinet body, no room, no shadows, no glare, no reflections, no
> bevels. No captions or labels beyond the logos and the text I have asked for.

## The panel prompts

One panel at a time, attach that panel's template from `apps/arcade/art-templates/` and use the same
frame with the line for the panel swapped in:

> Attached are two images. The first is existing artwork whose style, palette, subject and lettering
> I want you to match exactly. The second is a blank template: it defines the exact shape of the
> panel you are drawing, and any paler shape inside it marks where the machine actually is.
>
> Draw **[ THE PANEL — one line from below ]** for this arcade cabinet, in the style of the first
> image, at exactly the proportions of the template.
>
> Fill the whole image edge to edge and corner to corner — no border, no frame, no margin, no
> background showing around it — and let the incidental detail run off all four edges. Keep every
> logo, face and word of text well inside, with room to spare: I am going to crop this, and anything
> near an edge may be lost.
>
> It is flat printed decal artwork, not a photograph of an arcade machine: completely flat and
> straight on, no perspective, no cabinet body, no room, no shadows, no glare, no reflections, no
> bevels. No captions or labels beyond the logo and any text I have asked for.

| Panel | The line |
|---|---|
| `marquee` | *the illuminated marquee sign, 16:9: the logo huge and centred with the tagline beneath it in smaller type* |
| `side-left` / `side-right` | *the tall side panel of the cabinet. The paler shape in the template is the outline of the machine's side — fill the whole image, but keep the logo and everything that matters inside that shape and clear of the notch cut into one side of it* — ask for the two flanks separately, as different scenes in the same world, and they will come back mirror images because their templates are |
| `panel` | *the control deck seen from directly above: a wide shallow band of artwork filling the image corner to corner, instruction text small, logo small at one end* |
| `bezel` | *the panel surrounding the screen, with the busiest detail round the edges. The darker rectangle marked SCREEN is where the monitor sits: leave it flat and near-black, with no picture, border or frame inside it* |
| `attract` | *the attract screen: a title screen for the game with the logo and INSERT COIN* |

## What happens to what comes back

Nothing is used as it arrives, and each of these exists because a generator got something wrong in a
way you cannot see until it is on the machine:

| Step | Why |
|---|---|
| **panels are found** on the sheet, not cut from fractions | every generator returns its own canvas shape |
| **marquees are squared to 16:9** | the sign's shape decides the machine's height |
| **flanks are edge-filled** ([lib/flank.mjs](../../scripts/lib/flank.mjs)) | the geometry cuts the real outline out; where the machine reaches past the drawn shape, the template's grey showed as a hem. The artwork's own edge colour is carried out over it. It does *not* stretch rows to fit — that melts the art sideways |
| **bezels are nine-sliced** ([lib/bezel.mjs](../../scripts/lib/bezel.mjs)) | no generator puts the hole where the cabinet has one. The drawn opening is found and the border re-laid around the real one; a side that was never drawn is mirrored from the opposite one |
| **decks and bezels are fitted inside their face** | a 6:1 strip stretched onto a 2.9:1 deck is a smear; fitted, it is a band across a painted deck, which is what a real control panel is |
| **everything is encoded sharp-yuv** | saturated line art through webp's usual chroma subsampling grows cyan and magenta fringes on every black outline, and the bloom finds every one |

## When something is wrong

`just art-check` prints one line per problem and the line below it is the fix. In full:

| It says | What it means | What to do |
|---|---|---|
| `missing` | no artwork for that panel | generate it, or leave it — the cabinet shows painted body |
| `… is 2.08:1, wants 1.78:1` | the shape is outside tolerance | ask again with the template attached; for a marquee the cutter squares it up for you |
| `artwork covers 94% of the machine` | the drawn flank shape is smaller than the outline | fine below a few percent — the edges are carried out. Worse than that, show the generator the side template again and say "fill the whole image, corners included" |
| `artwork covers 60% of the machine` (FAIL) | it drew something that is not the shape at all | regenerate that flank on its own with `art-templates/side-left.png` |
| `artwork is 6.6:1, so it covers 43% of the deck` | the control panel came back as a thin strip | usable — it becomes a band across the deck. To fill it, ask again for artwork that "fills the control panel slot corner to corner" |
| `x% of the area behind the glass is not dark` | the bezel's hole was detected in the wrong place | `node scripts/cabinet-bezel.mjs <source> <game> --dry-run` and try `--opening`, `--shift` or `--grow`; put whatever works in `art-templates/bezel.json` so it survives the next regeneration |
| `727px on its long edge, wants 900` | too small for something you lean in on | generate that panel on its own rather than as part of a sheet — a shared sheet gives each panel a fifth of the canvas |
| `marquees run 1.78:1 to 2.08:1` | the machines will be different heights | should not happen now marquees are squared up; if it does, re-cut those sheets |
| `no loop filmed` | the screen shows a still, or the game's colour | `node scripts/capture-attract.mjs <game>` with that game's dev server up |

### Per-game corrections

`art-templates/bezel.json` carries per-game corrections for the bezel fitter, and they survive
regenerating the artwork:

| Knob | What it does |
|---|---|
| `opening` | `[x0, y0, x1, y1]` as fractions of the source — where the hole really is, instead of detecting it |
| `shift` | `[dx, dy]` to nudge the detected opening |
| `grow` | widen (+) or tighten (−) it |
| `mirror` | sides to rebuild from the one opposite: `left`, `top`, `right`, `bottom` |
| `overlap` | how far the art tucks under the glass, fraction of the panel's width. Default `0.022` |
| `dark` | what sits behind the glass. Default `#050505` |

## The attract loops

The screens play a few seconds of each game's own title, filmed from the game itself:

```bash
node scripts/capture-attract.mjs             # all three, their dev servers must be up
node scripts/capture-attract.mjs radrun --seconds 14
```

It loads a game on its own dev server, hides the menu and the HUD, lets the scene settle and records
the page — Playwright's recorder writes webm, which is what a video texture wants, so there is no
encoder in the loop. The result lands in `public/cabinets/<game>/attract.webm` and the cabinet finds
it. The loop is cropped to the glass rather than squashed onto it, so the recording's shape does not
have to match. Re-run it whenever a game's title screen changes.

The loop runs on the selected cabinet only; the others hold a frame of theirs, which is enough to
stop them looking switched off.

## The three games

The reference image carries the look, so this is only here for when you are generating from nothing:

**Turbo Radrun** — OutRun / Rad Mobile. Sunset orange and hot pink, Miami skyline, palms, a coast
road, a red 1960s mid-engined endurance racer. Logo `TURBO RADRUN`, chrome blue with orange speed
streaks. Tagline `STAGES THROUGH USA & EUROPE!`.

**Stuntin'** — Hard Drivin' / Stunts. Bright daylight, deep blue sky, green hills, loops and
corkscrews, a chunky sports car upside down at the top of a loop. Logo `STUNTIN'`, bold italic yellow
with a red outline. Tagline `LOOP THE LOOP — DRIVE THE IMPOSSIBLE!`.

**Apex Conduit** — S.T.U.N. Runner. Near-black with electric cyan and magenta, a neon wireframe
tunnel, a wedge-shaped hovercraft riding its wall, laser light. Logo `APEX CONDUIT`, sharp angular
cyan chrome. Tagline `RIDE THE WALL — RUN THE LIGHT!`.

Style line, if you need to spell it out: *authentic early-1990s arcade cabinet screen printing —
saturated, high contrast, hard-edged airbrush illustration with heavy black outlines and
chrome-and-gradient lettering, flat colour the way ink sits on a printed vinyl decal.*

## The carpet

The room is geometry and light rather than photographs — dark walls, neon ceiling strips, and the
marquees doing most of the lighting. The floor is the one texture worth generating, because arcade
carpet is unmistakable and tiling it is free:

> A seamless tileable texture of 1990s arcade carpet, viewed from directly above, flat and
> orthographic with completely even lighting and no shadows. Black background with a chaotic pattern
> of neon geometric shapes — magenta and cyan triangles, yellow zigzags, teal squiggles, scattered
> white stars. Dense, busy, edge to edge, no border, no vignette, tiles seamlessly.

Save it yourself to `public/room/carpet.webp`; it is not a cabinet panel, so `cabinet-art.mjs` does
not handle it. Without it the floor is a dark procedural checker — fine, but forgettable.

## Regenerating the templates

```bash
node scripts/cabinet-template.mjs
```

Draws every template from the machine's own measurements and copies the sheet into `ext/`. Run it
after any change to the cabinet's geometry — the test will tell you if you forgot.
