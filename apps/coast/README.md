# COASTLINE (working title)

A sprite-scaling road racer in the lineage of the great 1986–1991 arcade
cabinets: three stages joined by forks, a countdown extended at checkpoints,
traffic to thread, turbo, hi/lo gear, a radio you tune before you leave — and
two projections, **chase** (car on screen) and **cockpit** (dashboard, wheel,
swinging dice). Pseudo-3D: segments, curves, hills and sprites, drawn on a
224-line logical screen. Modern and retro presentation from
[`packages/engine`](../../packages/engine).

```bash
just dev coast        # http://localhost:5182
just tunnel coast     # phones / remote
```

| Action | Keyboard | Gamepad |
|---|---|---|
| Steer | A / D, ← / → | left stick |
| Accelerate / brake | W / S | RT / LT |
| Gear hi / lo | Shift | A |
| Turbo | Space | B |
| View | C | Y |
| Pause | Esc | Start |

Phones: tilt to steer, GAS right, BRAKE left, GEAR / TURBO pills, VIEW pad.

## Sprites and assets

No sprite is hand-drawn. At startup the game loads CC0 low-poly models
(Kenney's Car, Racing and Nature kits) and renders each one into a sprite
atlas from a few yaws — traffic from behind and at ±20°, the hero car at seven
steering angles — then everything on the road is a scaled quad again. Swapping
a model in `src/render/models.ts` re-bakes automatically; nothing needs
Blender. See [public/assets/LICENSES.md](public/assets/LICENSES.md).

## Layout

```
src/sim/      Road (segments from sections, scenery, forks, runway), Stages
              (route tree + themes), Sim (player, traffic, timer, forks), Snapshot
src/render/   Projection, RoadMesh (per-frame trapezoids), SpriteAtlas (bake),
              SpriteBatch (instanced quads with hill clipping), Background
              (sky + procedural parallax), Cockpit, RenderWorld
src/app/      Game, Settings, Hud, menus, main
src/input/    bindings, InputMap, TouchSource
src/audio/    engine, tyres, bumps and three radio stations
test/         route tree, stage builder, determinism, checkpoints, full run
```
