# corridor viewer

Looks at what `tools/corridor` baked, from above and from the driver's seat.

```bash
just corridor-view      # :5185 — reads tools/corridor/data/sites straight off disk
just corridor-tunnel    # phone: devproxy :5190 + cloudflared quick tunnel
```

`?data=https://<bucket>` points it at a published R2 prefix instead of the local bake; the layout
(`/sites/index.json`, `/sites/<slug>/web/*`) is the same. `?lite` forces the phone build (a quarter
of the terrain vertices, 4k imagery, fewer near trees); touch devices get it automatically.

| file | role |
|---|---|
| `src/site.ts` | the manifest types, height decoding (RGB-encoded PNGs) |
| `src/scene.ts` | terrain, horizon, canopy blanket, spine overlay, structures — one `Site` per load |
| `src/props.ts` | stand-ins: road mesh split by surface class with real-scale UVs, lollipop trees, overpass piers, surface texture sets |
| `src/trees.ts` | near-field procedural trees (ez-tree) with seasonal leaf tint/density, re-assigned around the eye |
| `src/impostors.ts` | far trees: the same models baked to an 8-yaw atlas, one camera-facing quad per tree, toggled per tree as the near set moves |
| `src/grass.ts` | instanced grass/weed blades in a ring around the eye, on open ground off the pavement, mown near the shoulder |
| `src/hextile.ts` | stochastic hex tiling over a texture-array library, for the pavement |
| `src/season.ts` | the four-season palette: leaf tints and densities, grass ramp, ground tint, sky and fog |
| `src/strip.ts` | the fine corridor terrain: 1 m across, 2 m along, road height under every carriageway, DEM beyond; one ground material blending mown turf, rough grass and the air photo |
| `src/fly.ts` | trailworks-style fly camera |
| `src/car.ts` | the car: stuntin's ground regime + lateral grip model, tree collision |
| `src/main.ts` | UI, orbit/drive cameras, phone layout, picking |
| `public/surfaces/` | texture sets from `tools/surfaces/gen.py` |

Controls. **Fly** (trailworks scheme, `src/fly.ts`): WASD/arrows move along the view heading (speed
scales with distance to the orbit target, Shift sprints), Q/E turn the view about the camera, R/F
dolly, T/G raise/lower, left-drag orbits, right-drag looks, wheel dollies; the target rides the
ground. **Drive** (Tab; stuntin dynamics ported in `src/car.ts`): W/S throttle/brake, A/D steer,
Space handbrake, R resets to the photo; drag looks around the chase camera. The car collides with
tree trunks (radius from canopy height) and gets grass drag and grip off the pavement. P = photo,
H = top.
`?season=winter|spring|summer|autumn` or the picker in the header. Phones get a move pad (hold to glide) and drive buttons.

## Rendering notes worth keeping

- The renderer uses a **logarithmic depth buffer**; any custom `ShaderMaterial` must include `common`, `logdepthbuf_pars_*` and `logdepthbuf_*` or it silently fails every depth test (the grass was invisible for an hour over this).
- `UniformsUtils.merge` cannot clone a render-target texture; attach it after the merge.
- After rendering to a render target with sub-viewports, restore viewport and scissor or the main view draws into a corner.
- Under `InstancedMesh`, ez-tree's leaf material (custom wind shader) draws nothing; a plain material with the same texture does.
- Per-frame rebuilds of tens of thousands of instance matrices stall a phone for a second; keep instance slots static and toggle with `addUpdateRange`.
