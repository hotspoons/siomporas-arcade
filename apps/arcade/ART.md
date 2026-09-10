# Cabinet art — what the 3D arcade needs, and how to generate it

The lobby is a real three.js scene: cabinets standing in a dim room, the selected one lit and
turned toward the camera. Each cabinet is one mesh whose faces are flat quads, so every panel of
artwork maps onto its face with UVs of 0..1 — **no atlas, one image per panel**. That keeps the
generator's job simple (draw one flat rectangle of art) and means a panel can be re-generated on
its own without disturbing the others.

Files live in `public/cabinets/<game>/`, where `<game>` is `radrun`, `stuntin` or `apex`:

| File | Face | Target aspect | Required? |
|---|---|---|---|
| `marquee.webp` | the lit sign on top — **this is the menu item** | ~16:9 | **yes** |
| `side.webp` | side art (mirrored onto both sides) | ~9:16 | yes |
| `panel.webp` | control deck: wheel, buttons, shifter | ~21:9 | yes |
| `bezel.webp` | the surround framing the screen | ~4:3 | optional |
| `attract.webp` | what the screen shows before the live render takes over | 4:3 | optional |

Only `marquee.webp` is truly required. A cabinet with no `side.webp` gets flat painted sides in the
game's accent colour, and so on down the list — see `MISSING` handling in
[`src/lobby/CabinetArt.ts`](src/lobby/CabinetArt.ts). So the arcade works from the first marquee and
gets richer as art lands.

**Aspect ratios are targets, not contracts.** The geometry measures each texture as it loads and
sizes its face to match, so nothing is ever stretched — a 1.81:1 marquee simply makes a slightly
taller lightbox than a 1.78:1 one. Get close and don't fight the generator over it.

## The prompt

Generators are much better at one coherent sheet than at five separate images that have to look
like the same product. So ask for **one sheet per game** with the panels laid out flat on a plain
magenta field. Magenta (`#FF00FF`) appears nowhere in the art, which lets
`scripts/slice-cabinet.mjs` find each panel's exact bounding box and cut it out automatically — no
eyeballing coordinates.

Send this, with the **GAME** block swapped for the one you want:

> A texture sheet of flat artwork panels for an arcade cabinet, laid out on a solid bright magenta
> background (#FF00FF). Orthographic and perfectly flat-on: this is the printed decal artwork
> itself, not a photograph of a cabinet. No perspective, no cabinet body, no room, no shadows, no
> lighting effects, no glare, no reflections, no bevels, no mockup framing. Each panel is a clean
> rectangle of finished artwork separated from the others by at least 60 pixels of bare magenta.
> Do not write any labels, captions or panel names on the magenta.
>
> Lay out four panels:
>
> 1. Top left, a wide rectangle about 16:9 — the MARQUEE. The game's logo huge and centred, with
>    the tagline beneath it in smaller type. Bordered by a thin flat black retainer frame.
> 2. Below it, a tall narrow rectangle about 9:16 — the SIDE ART. A single dramatic scene running
>    the full height of the panel, with the logo reading vertically or set into the upper third.
> 3. Right, a very wide short rectangle about 21:9 — the CONTROL PANEL. Seen from directly above:
>    the flat deck artwork with a dark circular void where the steering wheel is fitted, and dark
>    circles where the buttons are. Instruction text, and the logo small at one end.
> 4. Beneath it, a rectangle about 4:3 — the BEZEL. A frame of artwork with a solid pure black
>    rectangle filling the middle where the screen sits.
>
> Style: authentic early-1990s arcade cabinet screen-printing. Saturated, high-contrast, hard-edged
> airbrush illustration with heavy black outlines and chrome-and-gradient lettering. Flat colour,
> the way ink sits on a printed vinyl decal.
>
> GAME: *(one of the three blocks below)*

**Turbo Radrun** — OutRun/Rad Mobile lineage. Sunset-orange and hot-pink Miami skyline, palm trees,
a coast road curving to the horizon, a red 1960s mid-engined endurance racer drifting. Logo `TURBO
RADRUN` in chrome-blue with orange speed streaks. Tagline `STAGES THROUGH USA & EUROPE!`. Its
marquee already exists at `public/cabinets/radrun/marquee.webp`, cut from the sheet you generated
— so for this game ask for the other three panels only, and tell the generator to match that
marquee's palette.

**Stuntin'** — Hard Drivin'/Stunts lineage. Bright daylight, deep blue sky, a stunt track of loops
and corkscrews on green hills, a chunky sports car upside down at the top of a loop. Logo
`STUNTIN'` in bold italic yellow with a red outline. Tagline `LOOP THE LOOP — DRIVE THE IMPOSSIBLE!`.

**Apex Conduit** — S.T.U.N. Runner lineage. Near-black with electric cyan and magenta. A neon
wireframe tunnel rushing at the viewer, a wedge-shaped hovercraft riding its wall, laser light. Logo
`APEX CONDUIT` in sharp angular cyan chrome. Tagline `RIDE THE WALL — RUN THE LIGHT!`.

## Slicing a generated sheet

```bash
node scripts/slice-cabinet.mjs ext/<the-generated-sheet>.jpeg radrun
```

It finds the magenta background, splits out every non-magenta island bigger than a threshold, sorts
them by size and shape, and writes `marquee.webp` / `side.webp` / `panel.webp` / `bezel.webp` into
`apps/arcade/public/cabinets/radrun/`. It prints what it matched to what and, with `--dry-run`,
writes a contact sheet to `shots/` so you can check the assignment before it overwrites anything.
Pass `--only marquee,side` to write just some of them.

If a sheet comes back on a white or dark background instead of magenta, the slicer will say so and
you can pass explicit crops: `--crop marquee=0,0,1129,625`.

## The room

The room itself is geometry and light, not photographs — dark walls, a low ceiling with neon
strips, and the cabinets' own marquees doing most of the lighting. The one texture worth generating
is the carpet, because arcade carpet is unmistakable and tiling it is free:

> A seamless tileable texture of 1990s arcade carpet, viewed from directly above, flat and
> orthographic with completely even lighting and no shadows. Black background with a chaotic
> pattern of neon geometric shapes — magenta and cyan triangles, yellow zigzags, teal squiggles,
> scattered white stars. Dense, busy, edge-to-edge, no border, no vignette, tiles seamlessly.

Save it as `public/room/carpet.webp`. Without it the floor falls back to a dark procedural
checker, which is fine but forgettable.
