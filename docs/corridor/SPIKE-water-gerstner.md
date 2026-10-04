# Spike — realistic corridor water (Gerstner + depth extinction + shore foam)

Source: [tuxalin/water-shader](https://github.com/tuxalin/water-shader), MIT, Copyright (c) 2017 tuxalin.
See `NOTICE` and `CREDITS.md` for the licence text.

## What this is

The corridor water was a `MeshStandardMaterial` whose normal was perturbed by two scrolling
value-noise layers over world position. From a car it read as moving water, but the specular broke
into blocky patches and nothing about the surface responded to depth — a stream, a pond and the sea
all shaded the same.

This spike replaces the normal with a **summed Gerstner wave** normal evaluated analytically, and
adds **wavelength-dependent colour extinction** and **depth-based shore foam**, the three ideas
worth taking from tuxalin. It deliberately does **not** bring in tuxalin's planar-reflection /
refraction render targets or its normal/foam/shore textures: the corridor renderer is forward and
has no scene-depth texture, so the high-value portable part is the wave/radiance/foam math.

| | before | after |
|---|---|---|
| normal | two scrolling value-noise layers, finite-differenced | four summed Gerstner bands, world-anchored |
| direction | none (pattern scrolls with time only) | each stream's ripples travel **along its channel**; ponds and the sea follow the wind |
| colour | one flat albedo per body | depth extinction per RGB channel, shore → deep |
| foam | falls/rapids only | falls/rapids **and** a noisy band at every bank |
| distance | — | waves and foam fade with range (an analytic normal has no mip) |
| config | three fixed materials | per-body **look** presets, from black bog to Caribbean |

Before / after at Braddock I-70 (Rock Creek), temperate look:

`/tmp/opencode/water/compare-temperate.png` (left before, right after) — plus
`after-swamp.png`, `after-caribbean.png`, `after-black.png` showing the look dial.

## How it works

`apps/corridor/src/world/waterShader.ts` — all ported GLSL, with the MIT header.
`apps/corridor/src/world/water.ts` — builders and the per-look material buckets.

- **Waves.** Four Gerstner bands, long ones aligned with the flow and short ones fanned across it.
  The surface derivative of one band is summed against +Y and the result mixed into three's
  view-space shading normal. Amplitudes/steepness are scaled by per-body and global dials. A range
  fade (mix 0.18…1) keeps a distant sea from shimmering.
- **Flow.** A new per-vertex `aWater = (depth, flowX, flowZ)` attribute is baked at build time. A
  stream's flow is its own channel tangent; a pond or the sea uses the wind heading. The shader
  prefers the attribute and falls back to `uWind`.
- **Depth.** The DEM has no bathymetry, so ground-based depth would read every pond and stream as
  uniformly shallow. Instead a stream ribbon gets a three-vertex cross-section — depth 0 at each
  bank, `crown` at the centre — which is exactly what puts the foam on the banks and a deep tint
  down the channel. Ponds use a constant `pondDepth`.
- **Extinction.** `exp(-depth / extinct)` per channel (red dies first), mixed from a shore tint to
  a deep tint. `WATER_CLARITY` scales the distances: short is opaque mud, long is clear.
- **Foam.** A noisy band in the first half-metre, racing with the flow, faded with range.

## Knobs and per-body looks

Everything is on the F6 panel under **Environment ▸ water** (the old `world` tab's water keys moved
there):

`WATER_LOOK` (default preset) · `WATER_DEPTH` · `WATER_WIDTH_SCALE` · `WATER_SPEED` ·
`WATER_OPACITY` · `WATER_WAVE_STRENGTH` · `WATER_WAVE_AMP` · `WATER_WAVE_LEN` ·
`WATER_WAVE_STEEP` · `WATER_WAVE_FADE` · `WATER_WIND_DEG` · `WATER_CLARITY` · `WATER_FOAM` ·
`WATER_FOAM_BAND` · `WATER_CROWN` · `WATER_LEVEL_M` · `WATER_LEVEL_SPAN`.

The scalar knobs are global multipliers; changing `WATER_LOOK` is live for bodies that do not name
their own look (the default change re-resolves per tick; the bank crown needs a reload).

Per body of water, a `WaterLine`/`WaterArea` may carry `look: '<preset>'`. A style may carry
`water.look` (applied via `WaterResult.setLook`), and code may call `water.setLook(name)` at any
time. Presets live in `WATER_PRESETS` / `WATER_LOOK_NAMES` and can be edited in one place:
`temperate`, `swamp`, `black`, `caribbean`, `alpine`, `mud`.

Bodies that name the same look share a merged draw call, so the Crofton region still draws in a
handful of meshes, not 744.

## API compatibility

`buildWater(water, groundAt)` and `WaterResult.{group,tick,setColours,lines,areas,falls,length_m}`
are unchanged, so `scene.ts`'s call sites are untouched. `WaterResult` only **adds** `setLook` and
`looks`. `StyleDef.water` only **adds** an optional `look`. `scene.ts` gains one line to apply it.

## Demo harness

`apps/corridor/waterdemo.html` + `src/waterdemo.ts` build the water alone on a plain background —
no terrain, trees or road — so the shader can be checked and shots taken in seconds instead of the
minutes the full build takes under software GL. `probes/_wdemo.mjs` drives it:
`PORT=5210 LOOK=swamp node probes/_wdemo.mjs braddock-i70 out.png`.

## Open / next

- No refraction or true water-column depth: on an area the depth is assumed, and a stream's depth is
  a shape rather than a measurement. tuxalin gets this from a refraction+depth render target. If the
  corridor renderer ever gains a scene-depth texture, feed it in and the extinction/foam become
  measured.
- `WATER_CROWN` is baked, so it needs a reload.
- The look presets are corridor-local for now; if another game wants water, `waterShader.ts` is
  already self-contained and can move into the engine.
