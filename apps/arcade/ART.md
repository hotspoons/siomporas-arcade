# Cabinet art — one panel at a time

The lobby is a real three.js scene: cabinets standing in a dim room, the selected one lit and turned
toward the camera. Each face of a cabinet is a flat quad and takes **one image**. No atlas, no sheet,
nothing to slice — a panel is a picture, and any one of them can be redone on its own without
touching the others.

The loop, per panel:

1. **Attach two images** to ChatGPT or Gemini: art you want it to match (the sheets in `ext/` are
   ideal — it made them, and the cabinets already wear their marquees), and the layout template for
   the panel you want, from `art-templates/`.
2. Paste the prompt below, with the panel's line swapped in.
3. Save whatever JPEG it hands back and install it:

```bash
node scripts/cabinet-art.mjs ext/whatever-it-called-it.jpeg radrun side
```

That trims any border it put round the art, crops to the shape that face wants, encodes a webp and
drops it in `public/cabinets/radrun/`. `--dry-run` writes it to `shots/` to look at first. Reload the
arcade and it is on the cabinet.

## What a cabinet wears

| Panel | Face | Template | Shape | Have it? |
|---|---|---|---|---|
| `marquee` | the lit sign on top — also the menu item | `art-templates/marquee.png` | 16:9 | **yes, all three** |
| `side` | side art, mirrored onto both sides | `art-templates/side.png` | 9:16 | no |
| `panel` | the control deck, seen from above | `art-templates/panel.png` | 21:9 | no |
| `bezel` | the surround framing the screen | `art-templates/bezel.png` | 4:3 | no |
| `attract` | what the screen shows before the game loads | `art-templates/attract.png` | 4:3 | no |

Only the marquee actually matters and all three exist. The rest is polish: a cabinet with no side art
shows painted body in the game's colour and looks fine. Add them in any order, whenever.

The templates are mid grey with black holes where the cabinet needs holes — the wheel and buttons
cut out of a control deck, the screen out of a bezel. Grey because white reads as paper and gets a
border drawn round it, and black reads as part of the art. Regenerate them with
`node scripts/cabinet-template.mjs` if the shapes ever change.

## The prompt

> Attached are two images. The first is existing artwork whose style, palette, subject and lettering
> I want you to match exactly. The second is a blank layout template: it defines the shape of the
> panel you are drawing, and any black shapes on it are holes that must stay solid black and stay
> exactly where they are.
>
> Draw **[ THE PANEL — one line from below ]** for this arcade cabinet, in the style of the first
> image.
>
> It is flat printed decal artwork, not a photograph of an arcade machine: completely flat and
> straight on, no perspective, no cabinet body, no room, no shadows, no glare, no reflections, no
> bevels. The artwork fills the whole image edge to edge, matching the template's proportions — no
> border, no frame, no margin, no background showing around it. No captions or labels beyond the
> logo and any text I have asked for.

And the panel line:

| Panel | The line |
|---|---|
| `side` | *the tall side panel: one dramatic scene running its full height, with the logo set into the upper third* |
| `panel` | *the control deck seen from directly above: a wide shallow strip of artwork, with the big black circle left of centre left untouched where the steering wheel is fitted and the three smaller black circles left untouched where the buttons go, instruction text small, logo small at the left end* |
| `bezel` | *the bezel that surrounds the screen: artwork forming a frame around the black rectangle in the middle, which is the screen and must stay solid black, with the logo small along the bottom edge* |
| `marquee` | *the illuminated marquee sign: the logo huge and centred with the tagline beneath it in smaller type* |
| `attract` | *the attract screen: a title screen for the game with the logo and INSERT COIN* |

If a panel comes back with a stray caption or a border, say so and ask again — they generally fix it
on the second go.

## The three games

The reference image carries the look, so this is only here for when you are generating from nothing
or want to remind it what a game is:

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

## On shapes

Generators offer a handful of aspect ratios and will not hit the template exactly. That is fine:
`cabinet-art.mjs` centre-crops to the shape the face wants and tells you how much it threw away, and
the geometry measures whatever texture it gets and sizes the face to match, so nothing is ever
stretched. If it warns that it is cutting more than a third, the image came back the wrong shape —
ask again, or pass `--no-crop` to keep the whole picture and let the cabinet face take the shape it
implies.

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

## If you ever do get a multi-panel sheet

`scripts/slice-cabinet.mjs` cuts several panels out of one image and is where the current marquees
came from. It needs the panels laid out on a plain magenta field to find their edges, which these
generators manage only sometimes — hence everything above. It is still there if a sheet turns up.
