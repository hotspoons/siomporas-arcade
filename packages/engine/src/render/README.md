# Rendering: the depth buffer, and everything it touches

`@apex/engine/render/depth` builds a game's `WebGLRenderer` with its depth buffer chosen on purpose,
and holds the handful of helpers a game needs so that choice does not break its sky, its decals, its
post-processing or its headset. Every game in this repo builds its renderer through it (2026-10-10).

```ts
import { createRenderer, depthRequestFromURL } from '@apex/engine/render/depth'

const { renderer, depth } = createRenderer({
  canvas,
  antialias: false,
  powerPreference: 'high-performance',
  depthMode: depthRequestFromURL() ?? 'auto', // ?depth=reversed|log|standard for an A/B
  fallback: 'standard', // what `auto` builds without EXT_clip_control
  label: 'mygame', // one console line when it is not reversed; null for silence
})
depth.mode // 'reversed' | 'log' | 'standard' — what three actually built
```

Every other `WebGLRenderer` parameter passes straight through (`depth: true`, `stencil`, `alpha`, …);
the depth *mode* is `depthMode` so it does not collide with three's own `depth`.

## Why reversed

three's `logarithmicDepthBuffer` keeps precision over a long view by writing `gl_FragDepth` in every
fragment shader, and that turns early-Z off for the whole renderer: every overdrawn fragment is
shaded and thrown away. A **reversed float** depth buffer (three's `reversedDepthBuffer`, which needs
`EXT_clip_control`) keeps the precision with early-Z intact. On corridor at Ultra, 2560 × 1323, the
same drive went from 18 to 7.6 ms of GPU at p50 (2026-10-09).

For a game on a plain 24-bit buffer the win is precision rather than early-Z — but only where the
depth lives in a float attachment. The engine's styles (`ModernStyle`, `RetroStyle`) give their
scene targets one; a composer of your own should use `composerTarget`. The canvas's own depth buffer
is whatever the browser gave it.

| `depthMode` | builds |
|---|---|
| `auto` (default) | reversed where `EXT_clip_control` exists, `fallback` elsewhere |
| `reversed` | reversed, asked of three unconditionally (three falls back to a plain buffer, and the factory warns) |
| `log` | three's logarithmic buffer — early-Z off |
| `standard` | the plain forward buffer |

`hasClipControl()` asks once, on a throwaway WebGL2 context it then releases, *before* the real
renderer exists — three cannot change its mind after construction.

## What a reversed buffer breaks, and the helper for each

| trap | do this |
|---|---|
| three **reverses the whole render list**, `renderOrder` and all, so a sky at `renderOrder −1000` draws last, and a depth-only proxy at `−1` draws after what it should hide | nothing — `createRenderer` installs `reversedOpaqueSort` / `reversedTransparentSort` (`installDepthSorts` for a renderer built elsewhere) |
| `gl_Position = clip.xyww` (a skybox at the far plane) is the **near** plane reversed | paste `FAR_PLANE_GLSL` into the vertex shader and write `gl_Position = toFarPlane(clip)`. three defines `USE_REVERSED_DEPTH_BUFFER` for `ShaderMaterial`, not `RawShaderMaterial` |
| a raw `gl.clearDepth(1)` disagrees with three's cached, inverted clear value; the next frame clears to "nearest" | `setDepthClear(renderer, d)` in three's terms (1 = far), and back to 1 after |
| the browser resets the **canvas** depth to 1.0 after every composite — the near plane reversed — so a pass that draws on the canvas with `autoClear = false` and no clear of its own sees nothing | `renderer.clearDepth()` first (`ModernStyle` does this before its `extra` pass) |
| `polygonOffset` is in window depth, which runs the other way | `setPolygonOffset(material, renderer, factor, units)` with forward-convention values. three r185 already negates the **factor** itself and not the **units**; the helper turns the units only. Negating both pulled stuntin's ground over every road past ~100 m. `test/three-canary.test.ts` fails if three's half changes |
| a shader's own shadow compare: the bias runs the other way | `shadowBias(light.shadow)` (three marks the shadow camera as it renders the map) |
| anything else you express in window depth | multiply by `depthSign(renderer)` (+1 forwards, −1 reversed) |
| a bare `new THREE.Camera()` has no `updateProjectionMatrix`, which three calls on every camera under a reversed buffer | render full-screen passes with `new OrthographicCamera(-1, 1, 1, -1, 0, 1)` |
| WebXR hands three **forward** projection matrices | nothing — `createRenderer` switches reversed off at `sessionstart` and back on at `sessionend` (`forwardDepthInXR`; `keepReversedInXR: true` to opt out). Programs compiled before the switch keep their shadow compare: a game with shadow maps that enters XR should mark its materials `needsUpdate` |
| a 24-bit fixed depth buffer reversed is no better than forwards | `composerTarget(renderer, w, h)` for three's examples `EffectComposer` (undefined when not reversed, so the composer builds its own default); `useFloatDepth(target, renderer)` for a target you already have (no stencil) |

Live state: `isReversedDepth(renderer)` (false during an XR session); `setReversedDepth(renderer, on)`
flips a renderer built with the capability.

## What it does not do

It reads no global settings and imports no game. A game that wants the choice persisted passes it
in (`depthMode`), and a game that wants its own console voice passes `label`.

## Checking a game

`?depth=standard` is the path every game had before; it should be bit-identical to the old build.
`?depth=reversed` (or the default, where the extension exists) should match it to within sub-pixel
edges. Headless Chromium's SwiftShader (ANGLE on Vulkan) **does** expose `EXT_clip_control`, so the
reversed path can be screenshotted headlessly; hiding the extension from `getExtension` exercises the
fallback.
