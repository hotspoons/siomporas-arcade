# Decisions — coast

1. **Real pseudo-3D, drawn with WebGL.** The road is a list of segments with a
   per-segment curve and hill height; every frame the renderer accumulates the
   curve from the camera outward (so distant road sweeps), projects two rows
   per segment, resolves hill occlusion near→far, then draws far→near into one
   dynamic triangle list and one instanced sprite batch. The look is authentic;
   the cost is a few hundred quads.
2. **Screen space is logical.** 224 lines in retro (the arcade board's own
   height, at 30 Hz), 448 in modern; width follows the window. The engine's
   post stacks work unchanged with the orthographic camera.
3. **Sprites are baked from CC0 meshes at startup**, not pre-rendered. Kenney
   kits (CC0) + an ambientCG asphalt texture live under `public/assets` with a
   licence file so the app can be split out intact.
4. **Forks are drawn as two roads spreading from one centreline**; the sim
   picks by the sign of x at the stage end and re-centres. The route is a tree
   (A → B1|B2 → C1|C2|C3), four distinct runs.
5. **Traffic is sparse on purpose** (14 cars, 90–300 segments ahead). Denser
   made every run a bump-fest; bumps keep 85 % of speed.
6. **Stages are authored long and scaled** (`STAGE_SCALE`) to about a minute
   flat-out, with 75 s on the clock and +62 s per checkpoint.
7. **Cockpit view is a canvas texture**: dash, wheel, speedo, gear/turbo, and
   the dice on a pendulum driven by lateral acceleration.
