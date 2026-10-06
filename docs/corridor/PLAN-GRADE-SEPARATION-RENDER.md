# Plan — grade-separated crossings: rendering the DEM, the underside, and the ground

Rich, 2026-10-06, underpass at site (9461.6, 10188.9) on `dc-metro-take-2` (the Beltway), plus the
earlier "outer loop turns to grass" on the same highway.

## The three reports

1. **The underpass has DEM in the roadway.** The car drives through it (physics ignores the
   structure) but a ground surface is *rendered* across the carriageway. "We need a way to
   algorithmically ignore DEM for overpasses for rendering too."
2. **The hill has no base texture; the world is see-through.** A grass slope beside/over the road
   loses its fine ground and the coarse imagery shows from below where the world was "dropped".
   "All DEM mesh [should be] textured with at least a base texture (configurable fallback)."
3. **The overpass reads as a black lid.** Wants concrete barriers, a concrete bottom with
   thickness, and supports auto-generated in the median of the road below when OSM has none.

## Diagnosis

### (2) see-through — the road-cover clip, fixed here

`visuals/roadcover.ts` draws the pavement into a top-down mask and every ground-level material
discards fragments covered by it. The test was `world.y > roadY - 1.2 && world.y < roadY + 80` —
**80 m above the pavement**. That band is meant for a tree whose crown reaches over a lane (the
whole tree is bogus and should go). Applied to *terrain and grass* it deletes legitimate land: a
hill standing over a road, or the earth an underpass runs through, is inside the band and was
discarded. The fine DEM vanished, the coarse overview showed from underneath, and the world read
as see-through — "I have seen this other places."

Fix (done): the ceiling is per-material. Terrain and grass take a thin shell at the pavement
(default `uRoadCoverCeil = 2.5`); foliage keeps 80 via `installRoadClip(mat, 80)`. Grass splices
`ROAD_CLIP_PARS` itself and spreads `roadClipUniforms`, so the shared default is what fixes it
without touching `grass.ts`.

### (2) base texture — added here

A DEM tile with no photo (past the overview's edge, or one whose pyramid tile 404/503s — the dev
log is full of `pyramid: … failed to load — parent stands in`) drew as the flat `bare` colour. The
terrain shader now samples a shared **base texture** top-down by world position whenever the
material has no map (`uFallback`/`uFallbackOn`). It is the surface set's `grass_rough` map, chosen
by `TERRAIN_FALLBACK_CLASS` in `scene.ts` — one name to change to re-skin it.

### (3) the overpass — improved here

`props.ts:overpassMesh` gained concrete barriers along the deck edges, a thicker deck + recessed
soffit + girders, a lift out of the pure-black shadow, and a median column on the centreline of the
road below when OSM gives no abutment (both edge piers landed on a carriageway) or the road below
is wide enough to be divided (`roadWidth >= 14`).

### (1) DEM in the roadway — still open, needs one more decision

Physics already knows the structure: `isDeck(y, earthY, OVERPASS_CLEAR_M)` marks a carriageway
standing clear of the bare earth, `physGroundAt(grade=true)` skips it, and the deck streams back as
a trimesh collider. **Rendering has no such notion.**

Two candidate sources, and they need different fixes:

- **A DEM "lid".** If the bake left the bridge surface in the DEM, the terrain heightfield has one
  surface per column at bridge height and there is no valley floor to show if we simply discard it
  — a hole, not a fix. The right fix is then in the bake (bare-earth the structure) or a viewer
  pass that *lowers* the lid to the deck's measured ground.
- **The graded strip.** `strip.ts` blends the road edge (`e.y`) into the DEM; an elevated
  carriageway's strip climbs to the deck and can throw a rendered mound across the lower road,
  which physics (which grades with `grade=true`) walks straight through. The fix is to make the
  *strip* obey the same deck rule the grader does — pass the deck predicate into `buildStrip`
  so a station more than `OVERPASS_CLEAR_M` above the bare earth contributes no pavement-grade
  fill.

**Next step:** confirm which of the two it is at (9461.6, 10188.9). The bridge is now at that
stance in the dev browser. If the surface in the roadway sits at deck height, it is A; if it sits
just above the lower road and follows the ramp's plan, it is B (the strip).

## Verified

- `tsc -p apps/corridor/tsconfig.json --noEmit` clean.
- `vitest run --root apps/corridor` — 725 passed.
- Overpass fall-through (`probes/.build/bridgefix.mjs raw`) was already `sank: 0` before this change.

## Not yet verified visually

The dev browser's tab is backgrounded, so `requestAnimationFrame` is throttled and screenshots
return a stale frame; headless swiftshader crashes on the full dc-metro stance (tile-decode
timeouts / renderer loss). **Bring the tab forward at the stance to see the clip fix, the base
texture and the new overpass.** The fallback shader is the only change that can break all terrain
if a GLSL error slips through — check a tile with imagery and one without.
