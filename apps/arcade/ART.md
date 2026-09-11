# Cabinet art

**You do not have to do any of this.** Every cabinet already has its marquee — the lit sign on top,
which is also the menu item — and that is the only panel that matters. A cabinet missing the rest
shows painted body in the game's colour, which is what the lobby looks like now and it reads fine.

What follows is polish, in whatever order and amount you feel like. The two ways to do it:

**One sheet, one prompt, a whole cabinet.** Hand a generator `art-templates/sheet.png` — a labelled
blank with a slot for each panel — plus a picture of art you want it to match, and ask it to fill
the slots in. Then:

```bash
node scripts/cabinet-sheet.mjs ext/what-it-gave-you.jpeg radrun --dry-run   # look first
node scripts/cabinet-sheet.mjs ext/what-it-gave-you.jpeg radrun            # install all four
```

No detection, no magenta, nothing to eyeball: we drew that template, so the slots are known and
cutting them back out is arithmetic. `--dry-run` writes the cut panels and a contact sheet into
`shots/` so you can see whether it kept to the layout before anything is installed. If it wandered,
say "keep every panel inside its box" and ask again, or fall back to one panel at a time.

**One panel at a time.** Attach the single template for that face (`art-templates/side.png` and
friends) with the same reference art, and install what comes back:

```bash
node scripts/cabinet-art.mjs ext/what-it-gave-you.jpeg radrun side
```

Use this to redo one face you are not happy with, without disturbing the others.

Either way the templates are also copied into `ext/`, so they are next to the art you are working
with. Regenerate them with `node scripts/cabinet-template.mjs` if the shapes ever change.

## What a cabinet wears

| Panel | Face | On the sheet? | Own template | Shape | Worth it |
|---|---|---|---|---|---|
| `marquee` | the lit sign on top — also the menu item | yes | `marquee.png` | 16:9 | **done, all three** |
| `side` | side art, mirrored onto both sides | yes | `side.png` | 9:16 | most of what you see |
| `panel` | the control deck, seen from above | yes | `panel.png` | 21:9 | on the selected cabinet |
| `bezel` | the surround framing the screen | yes | `bezel.png` | 4:3 | close up only |
| `attract` | what the screen shows before the game loads | no | `attract.png` | 4:3 | barely visible |

If you only ever do one more thing, make it **side art**: the cabinets either side of the selected
one are turned, so their flanks are most of the picture.

The black shapes on a template are holes the cabinet needs — the wheel and buttons cut out of the
control deck, the screen out of the bezel — and the artwork has to leave them alone. The field is
mid grey because white reads as paper and gets a border drawn round it, and black reads as part of
the art; grey reads as nothing, which is what it is.

## The prompt

For the whole sheet:

> Attached are two images. The first is existing artwork whose style, palette, subject and lettering
> I want you to match exactly. The second is a blank layout template for the decal artwork of an
> arcade cabinet: four grey slots, each labelled, on a darker grey field.
>
> Fill in every slot with finished artwork in the style of the first image, keeping each piece of
> artwork strictly inside its own slot and keeping the slots exactly where and what size they are.
> Where a slot has black shapes on it — the circles on the control panel, the rectangle on the bezel
> — leave them solid black and exactly where they are: those are the holes for the steering wheel,
> the buttons and the screen. The grey gutters between the slots stay flat grey, and the labels can
> go.
>
> MARQUEE: the illuminated sign, logo huge and centred with the tagline beneath it.
> SIDE ART: one dramatic scene running the full height, logo set into the upper third.
> CONTROL PANEL: the deck seen from directly above, artwork around the wheel and button holes,
> instruction text small, logo small at the left end.
> BEZEL: artwork forming a frame around the black screen rectangle, logo small along the bottom.
>
> All of it is flat printed decal artwork, not a photograph of an arcade machine: completely flat
> and straight on, no perspective, no cabinet body, no room, no shadows, no glare, no reflections,
> no bevels. No captions or labels beyond the logos and the text I have asked for.

For one panel on its own:

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

Generators offer a handful of aspect ratios and will not hit a template exactly. That is fine.
`cabinet-sheet.mjs` centre-crops what comes back to the sheet's own 4:3 before cutting, so the slots
still land where they should; `cabinet-art.mjs` centre-crops a single panel to the shape its face
wants and tells you how much it threw away. And
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
