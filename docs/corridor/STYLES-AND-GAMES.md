# Styles, play knobs, and the first two games

**Status:** design, 2026-09-26. Rich: "we should be able to control the render styling so instead
of late summer tired dark green trees and drab looking box houses, we can pick from a palette of
style including alien, fantasy, medieval, etc. — we don't need to build this all out now, but
let's build one that is definitely not trying to pretend to be crofton. And we should be able to
have fun with areas, like exaggerate terrain, set water levels high and make waterworld."

And the first use cases, from his nine-year-old: a squishy-hunting exploration game over Crofton
(realistic and fantasy, multiplayer with friends, hints to the next haul at real stores), and a
parkour/gymnastics/archer game (tricks off real houses and trees, a bow, enemies, first-person
when it gets close).

## The style axis

Every colour in the viewer already flows through one object. `season.ts` defines a `SeasonLook`
per season — leaf tints per leaf kind, the grass ramp, litter, the ground tint on the imagery,
sky, fog, sun and ambient — `siteLook()` shifts it by the site's climate, `weather.ts` modifies
it, and `Site.setSeason()` fans it out to trees, grass, strips, terrain, horizon and impostors.
The sky dome (`sky.ts`) reads the same object. Nothing draws a colour it did not get from there.

So a style is a **third input to that one function**, not a second rendering path:

```
look = style(weather(siteLook(season)))
```

`style.ts` holds a `Style` per name with, initially, only what a palette needs:

| field | realistic | fantasy (the first one) |
|---|---|---|
| leaf tints per kind | as season | violet oak, teal ash, gold aspen, indigo pine, magenta live |
| grass base/tip | as season | lilac base, pale-pink tip |
| litter | as season | plum |
| ground (imagery tint) | as season | pulled toward mauve, desaturated 40 % |
| sky zenith/horizon, clouds | as season+weather | deep violet zenith, peach horizon, pink-lit clouds |
| sun colour | warm white | rose gold |
| water | blue-green | turquoise, opaque |
| building walls / roofs | the seven sidings / four roofs | pale stone, sandstone, whitewash / slate blue, copper green |
| roof shape | gable ≤ 500 m² | steep gable (1.4× rise), spire on anything under 60 m² |
| road paint | yellow / white | white / pale gold |

The imagery is the one input a palette cannot recolour honestly — an air photo of Crofton is an
air photo of Crofton. The fantasy style therefore **lowers the imagery's weight**: the strip's
turf textures run further out (the grass zone becomes the ground), the terrain's imagery is tinted
hard toward the palette, and the horizon drape is tinted the same. It stops looking like a
photograph, which is the point.

Buildings are the one place a style needs geometry, not colour: `buildings.ts` bakes vertex
colours from two arrays and a gable rule. Those become fields on the style. A medieval or alien
style would go further (roof pitch, tower footprints, no lane paint) and that is the second entry
in the table, later.

Where it lives in the UI: the season picker gains a style picker beside it; the stance carries
`style`; the world editor's world record carries a default style so a published world opens as
the author meant it.

## Play knobs

Two already exist and one is missing:

- **water level** — `WATER_LEVEL_M` is trailworks' flooding mechanic in one number; the sea plane
  is always drawn and rises to it. Waterworld is that knob plus the fantasy palette's turquoise.
- **season / weather** — already stance and tuning state.
- **terrain exaggeration** — missing. The honest version scales heights *about the road*: the
  strip and the car stay drivable if the exaggeration is applied to the DEM relative to the spine
  grade (`z' = zroad + k·(z − zroad)`), which keeps every carriageway where it was and lifts the
  hills around it. It is a loader-side transform on the height fields with `k` on the world
  record; the strip, trees and buildings all read `heightAt`, so they follow for free.

## Squishy Hunt

What the bake already knows: `manifest.pois` — crofton-triangle has 237, of which 5 supermarkets,
7 convenience stores, 8 fuel stations, 21 fast food, 24 restaurants, 25 playgrounds, 9 parks,
182 named. Every haul has a real address and a real building to stand in front of.

- **Hauls** are placed at a subset of POIs (stores, fuel, playgrounds), a handful "active" at a
  time. Each is a floating squishy (a catalogue asset: the flux→TRELLIS chain makes one in a
  minute) with a pickup radius.
- **Hints** are the game: "somewhere with a red roof near the school", "past the third pond on
  Crofton Parkway" — generated from the POI's own tags (`shop=convenience`, the nearest named
  road, the nearest park) and distance banding. The minimap shows a direction arc, not a pin.
- **Movement**: on foot (the fly camera at eye height with ground clamp — a walk mode is a few
  lines on `fly.ts`) and the car.
- **Multiplayer** — built 2026-09-26: `tools/worldeditor/rooms.mjs`, a relay on the world-editor
  service. Server-Sent Events push room state, players POST a pose four times a second and a
  claim when they pick up; first claim wins and a late one is refused. `?room=name&player=Ava`
  joins. Friends are capsules with their name over their head; a squishy a friend claims vanishes
  for everyone with a toast. In memory, no dependencies, no authority beyond "who claimed it".
- **Two worlds, one bake**: the same site with `style: realistic` and `style: fantasy`.

Sits in the arcade catalog as a fourth cabinet; the corridor viewer is its engine, the game is a
mode of it (`apps/corridor/src/games/squishy.ts`), not a new app.

## Parkour / Archer

The bigger one. What is new is a **character**:

- third-person controller: run, jump, vault (mantle onto a surface whose top is within reach —
  the buildings' massing and the strip give real edges), wall-run along a facade for a short
  distance, roll on landing.
- **tricks**: airtime and rotation scored — a pirouette off a roof is a jump with yaw input while
  airborne, scored by degrees turned and height cleared, landed clean or not (roll input within a
  window).
- **bow**: a projectile with gravity, drawn from third person, first person while aiming.
- **enemies**: a handful of patrol/chase agents on the road network (the network graph is in the
  bake), knocked down by arrows, close-range switches to first person.

The character controller, the animation set and the enemy behaviour are the work; the world,
the collision surfaces (`groundAt`, `edgeDistance`, `treesNear`, building footprints) and the
scoring geometry are already there. Same engine, same catalog entry pattern.

## Order

1. `style.ts` with `realistic` and `fantasy`; the picker; the stance field. One evening.
2. Terrain exaggeration on `heightAt`, `WATER_LEVEL_M` exposed on the world record.
3. ~~Squishy Hunt: hauls + hints + walk mode single-player, then the relay.~~ Done 2026-09-26; the world-editor pod needs redeploying for the relay to exist outside a dev box.
4. Parkour: the character, then tricks, then the bow, then enemies.
