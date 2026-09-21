# surfaces — road textures from flux, matched to measured pavement

```bash
tools/corridor/.venv/bin/python tools/surfaces/gen.py            # all six sets
tools/corridor/.venv/bin/python tools/surfaces/gen.py concrete   # one
```

Output: `apps/corridor/public/surfaces/<class>/{albedo.jpg,normal.png,roughness.jpg}` and
`surfaces.json`. The class names are the join with the bake: `tools/corridor/corridor/surface.py`
labels every 20 m of a spine `asphalt_new | asphalt_aged | asphalt_patched | concrete | chipseal`,
and the viewer's road mesh is split by that label and textured from this catalogue at real scale
(`metres_per_tile`).

## How the pavement class is measured

Two signals already in every site directory, plus OSM when it bothers to say:

| signal | what it separates | caveat |
|---|---|---|
| **lidar return intensity** of ground points inside the lanes | new asphalt (near-black to a 1064 nm laser) from aged (greyer) from concrete (bright) | not comparable between lidar projects: the same asphalt reads 5,900 on MD_Western_2 and 14,300 on MD_Western_1. Used only RELATIVE to the corridor's own median |
| **NAIP brightness/chroma/texture** inside the lanes | concrete (≥120) from asphalt; texture picks chip seal on small roads | shadows and vehicles raise texture on interstates, so chip seal is gated to non-motorway classes |
| **OSM `surface=`** | an explicit vote | rarely more specific than `asphalt` |

What it found on the first seven corridors: interstates are aged asphalt end to end, with concrete
exactly where the bridge decks are (Braddock's two I-70 bridges, Frederick's overpasses) — the
intensity jump lands on the OSM `bridge=yes` segments to the station. Clarksburg I-270 reads
concrete over ~3.7 km; that is a real concrete section of I-270 and worth checking against the
photos.

## How the textures are made

flux.2-dev on the cluster, top-down orthographic prompt, one metre square, no markings. Then:

1. **Tileable** by rolling the image half a tile in both axes and blending the resulting cross seam
   over 96 px against the original. Works because pavement statistics are stationary — the first
   `asphalt_patched` had one big patch and came back as a cross-shaped smear; the prompt now asks
   for many small repairs spread evenly.
2. **Normal map** from an albedo-derived height field (dark = low; right for aggregate and pits),
   Sobel with wrap-around so the normal tiles too. A stand-in for a real material model: DeepBump
   (ONNX, colour→normal) is the obvious upgrade but it is GPL-3, so it would run as a bake-time
   tool, never in the game.
3. **Roughness** as inverted, blurred albedo: worn aggregate crowns are the glossier parts.

Regenerate a set by deleting its directory. The `raw.jpg` beside each albedo is what flux returned
before tiling, for judging the blend.
