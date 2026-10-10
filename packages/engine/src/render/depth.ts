// THE DEPTH BUFFER, chosen once and handled everywhere it leaks.
//
// Rich, 2026-10-10: "any rendering optimization including reverse something something that was
// done over the last couple of days — can we make sure these make it into the main game engine used
// by the other games in this repo?" This module is that: corridor's reversed-depth work, lifted out
// of apps/corridor/src/main.ts and its visuals so every game builds its renderer the same way.
//
// WHY REVERSED. three's `logarithmicDepthBuffer` keeps precision over long ranges by writing
// gl_FragDepth in every fragment shader — and a shader that writes depth cannot be depth-tested
// before it runs, so early-Z is off for the whole renderer: every overdrawn fragment (a leaf behind
// a leaf, the ground under the road, a car behind a car) is shaded in full and then thrown away.
// A REVERSED float depth buffer (three's `reversedDepthBuffer`, which needs EXT_clip_control) keeps
// the same precision without touching gl_FragDepth. Measured on corridor at Ultra, 2560 × 1323, on
// Rich's machine (2026-10-08/09): GPU p50 18 → 7.6 ms over the same drive.
//
// For a game that never used log depth (a plain 24-bit buffer) the gain is precision, not early-Z:
// near/far ratios of 10⁴ stop z-fighting at the far end once the depth that matters is a float. That
// only happens where the depth lives in a float attachment — a render target given
// `useFloatDepth` (the engine's styles do this) or a composer built on `composerTarget`. The
// canvas's own depth buffer is whatever the browser gave it (24-bit, in practice); reversed onto it
// is about as good as forward, and no worse.
//
// WHAT CAME WITH IT — each of these broke a frame on corridor before it was found:
//   - three REVERSES THE WHOLE RENDER LIST under a reversed buffer, renderOrder and all, so a sky at
//     renderOrder −1000 drew last and painted over the world. `installDepthSorts` (done for you by
//     `createRenderer`) sorts every key the other way so three's reverse lands it right.
//   - a raw `gl.clearDepth(1)` bypasses three's cached, inverted clear value: the main frame then
//     cleared depth to "nearest" and nothing passed the test. Use `setDepthClear`.
//   - the browser resets the canvas's depth to 1.0 after every composite (the WebGL default, not
//     three's value) — the NEAR plane reversed. A pass drawn on the canvas with autoClear off and
//     no clear of its own fails every test: `renderer.clearDepth()` first (coast's solid models).
//   - the skybox trick `gl_Position = p.xyww` is the FAR plane forwards and the NEAR plane reversed.
//     Use `FAR_PLANE_GLSL`'s `toFarPlane(p)`.
//   - polygonOffset and a hand-written shadow-map bias are in window depth, which runs the other way.
//     three turns the polygonOffset FACTOR round itself but not the UNITS: `setPolygonOffset` does
//     the rest; `depthSign` and `shadowBias` for a shader's own compare.
//   - a bare `new THREE.Camera()` has no `updateProjectionMatrix`, and three calls it on every camera
//     it renders with under a reversed buffer. Render with an OrthographicCamera(-1, 1, 1, -1, 0, 1).
//   - WebXR hands three FORWARD projection matrices; under a reversed buffer the headset sees
//     nothing right. `createRenderer` turns reversed depth off for the length of an XR session.
//   - a post-processing target with a 24-bit fixed depth buffer is no better reversed than forwards:
//     `composerTarget` / `useFloatDepth`.
//
// Nothing here imports a game. Options come in as arguments; nothing reads a global knob.

import {
  DepthTexture,
  FloatType,
  HalfFloatType,
  WebGLRenderer,
  WebGLRenderTarget,
  type Material,
  type TextureDataType,
  type WebGLRendererParameters,
} from 'three'

/* ---- choosing ------------------------------------------------------------------------------- */

/**
 * What a game asks for.
 *   - `auto`: reversed where EXT_clip_control exists, otherwise the game's `fallback`.
 *   - `reversed`: reversed, unconditionally asked of three. Where the extension is missing three
 *     itself falls back to a plain forward buffer (and warns); `createRenderer` reports that.
 *   - `log`: three's logarithmic depth — precise over long ranges, but early-Z is off.
 *   - `standard`: a plain forward buffer, the WebGL default.
 */
export type DepthRequest = 'auto' | 'reversed' | 'log' | 'standard'
/** What was actually built. */
export type DepthMode = 'reversed' | 'log' | 'standard'
/** What `auto` falls back to without EXT_clip_control. */
export type DepthFallback = 'log' | 'standard'

const REQUESTS: readonly DepthRequest[] = ['auto', 'reversed', 'log', 'standard']

/** A string from a URL or a settings file, as a request, or null when it is not one. */
export function parseDepthRequest(v: string | null | undefined): DepthRequest | null {
  const s = v?.trim().toLowerCase()
  return s && (REQUESTS as readonly string[]).includes(s) ? (s as DepthRequest) : null
}

/**
 * `?depth=reversed|log|standard|auto` from a query string (the page's own when omitted), or null.
 * The A/B switch corridor has used since 2026-10-08; any game may honour it.
 */
export function depthRequestFromURL(search?: string, param = 'depth'): DepthRequest | null {
  const q = search ?? (typeof location !== 'undefined' ? location.search : '')
  return parseDepthRequest(new URLSearchParams(q).get(param))
}

export interface DepthPlan {
  /** what to pass three: `reversedDepthBuffer` */
  reversed: boolean
  /** what to pass three: `logarithmicDepthBuffer` */
  log: boolean
  /** why, in words, for a console line or a perf panel */
  reason: string
}

/**
 * The decision, pure: what to ask three for, given the request, the fallback and whether
 * EXT_clip_control is there. `clipControl` is only consulted for `auto`.
 */
export function planDepth(request: DepthRequest, fallback: DepthFallback, clipControl: boolean): DepthPlan {
  switch (request) {
    case 'reversed':
      return { reversed: true, log: false, reason: 'reversed asked for' }
    case 'log':
      return { reversed: false, log: true, reason: 'logarithmic asked for (early-Z is off)' }
    case 'standard':
      return { reversed: false, log: false, reason: 'standard asked for' }
    case 'auto':
      return clipControl
        ? { reversed: true, log: false, reason: 'auto: EXT_clip_control is here' }
        : { reversed: false, log: fallback === 'log', reason: `auto: no EXT_clip_control here, ${fallback}${fallback === 'log' ? ' (early-Z is off)' : ''}` }
  }
}

let clipControlCache: boolean | null = null

/**
 * Does this browser have EXT_clip_control? Asked ONCE, on a throwaway WebGL2 context, BEFORE the
 * real renderer exists — the choice cannot be made after: three decides reversed-or-not when it is
 * constructed, and without the extension it quietly draws a forward 24-bit buffer, which across a
 * long view is z-fighting from the middle distance out. The throwaway context is released at once
 * (the arcade cares how many live contexts a page holds).
 */
export function hasClipControl(): boolean {
  if (clipControlCache !== null) return clipControlCache
  let ok = false
  try {
    if (typeof document !== 'undefined') {
      const gl = document.createElement('canvas').getContext('webgl2')
      ok = !!gl?.getExtension('EXT_clip_control')
      gl?.getExtension('WEBGL_lose_context')?.loseContext()
    }
  } catch {
    ok = false
  }
  clipControlCache = ok
  return ok
}

/* ---- building ------------------------------------------------------------------------------- */

export interface CreateRendererOptions extends Omit<WebGLRendererParameters, 'logarithmicDepthBuffer' | 'reversedDepthBuffer'> {
  /** which depth buffer; default `auto`. (three's own `depth` — whether there is one at all — passes through.) */
  depthMode?: DepthRequest
  /** what `auto` builds without EXT_clip_control; default `standard` */
  fallback?: DepthFallback
  /**
   * Leave reversed depth on during a WebXR session. Default false: three takes the headset's
   * forward projection matrices as they come, so reversed depth is switched off at `sessionstart`
   * and back on at `sessionend` (see `setReversedDepth` for what that does and does not redo).
   */
  keepReversedInXR?: boolean
  /** a prefix for the one console line saying which depth was built; null for silence */
  label?: string | null
  /** for tests and odd hosts: replaces the throwaway-context probe */
  clipControl?: () => boolean
}

export interface RendererDepth {
  requested: DepthRequest
  /** what three actually built */
  mode: DepthMode
  /** shorthand for `mode === 'reversed'` at construction; ask `isReversedDepth` for the live answer */
  reversed: boolean
  reason: string
}

export interface CreatedRenderer {
  renderer: WebGLRenderer
  depth: RendererDepth
}

/**
 * Build a WebGLRenderer with its depth buffer chosen on purpose, and everything a reversed buffer
 * needs installed: the render-list sorts and the WebXR switch. Every other WebGLRenderer parameter
 * passes straight through.
 *
 *   const { renderer, depth } = createRenderer({ canvas, antialias: false, depthMode: 'auto' })
 *   if (depth.reversed) …
 */
export function createRenderer(opts: CreateRendererOptions = {}): CreatedRenderer {
  const { depthMode: requested = 'auto', fallback = 'standard', keepReversedInXR = false, label = 'renderer', clipControl, ...params } = opts
  const plan = planDepth(requested, fallback, requested === 'auto' ? (clipControl ?? hasClipControl)() : false)
  const renderer = new WebGLRenderer({ ...params, logarithmicDepthBuffer: plan.log, reversedDepthBuffer: plan.reversed })
  const mode: DepthMode = renderer.capabilities.reversedDepthBuffer ? 'reversed' : renderer.capabilities.logarithmicDepthBuffer ? 'log' : 'standard'
  let reason = plan.reason
  if (plan.reversed && mode !== 'reversed') {
    reason = 'reversed asked for, but EXT_clip_control is missing: a plain forward buffer is drawing this'
    if (label !== null) console.warn(`${label}: ${reason}`)
  } else if (label !== null && mode !== 'reversed' && requested !== 'standard') {
    console.info(`${label}: ${mode} depth — ${reason}`)
  }
  installDepthSorts(renderer)
  if (mode === 'reversed' && !keepReversedInXR) forwardDepthInXR(renderer)
  return { renderer, depth: { requested, mode, reversed: mode === 'reversed', reason } }
}

/**
 * Switch reversed depth off for the length of every WebXR session on this renderer, and back on
 * after. `createRenderer` does this unless told `keepReversedInXR`. three r185 copies each XR view's
 * projection matrix in as the device gives it — a forward one — so under a reversed buffer the
 * headset would clip everything nearer than the far plane. Returns the unsubscribe.
 */
export function forwardDepthInXR(renderer: Pick<WebGLRenderer, 'xr' | 'capabilities' | 'state' | 'setOpaqueSort' | 'setTransparentSort'>): () => void {
  const r = renderer as WebGLRenderer
  const start = () => setReversedDepth(r, false)
  const end = () => setReversedDepth(r, true)
  r.xr.addEventListener('sessionstart', start)
  r.xr.addEventListener('sessionend', end)
  return () => {
    r.xr.removeEventListener('sessionstart', start)
    r.xr.removeEventListener('sessionend', end)
  }
}

/** Is depth reversed on this renderer RIGHT NOW (it is not during an XR session)? */
export function isReversedDepth(renderer: WebGLRenderer | null | undefined): boolean {
  return !!renderer?.state.buffers.depth.getReversed()
}

/**
 * Turn reversed depth on or off on a live renderer that was built with it (an XR session, an A/B).
 * Sets the clip control, re-inverts the clear value and swaps the render-list sorts. It cannot
 * recompile programs already built: those only differ in shadow-map compares and depth packing,
 * so a game with shadow maps that toggles mid-life should mark its materials `needsUpdate`.
 * Asking for reversed on a renderer without the capability does nothing.
 */
export function setReversedDepth(renderer: WebGLRenderer, on: boolean): void {
  if (on && !renderer.capabilities.reversedDepthBuffer) return
  renderer.state.buffers.depth.setReversed(on)
  installDepthSorts(renderer)
}

/* ---- the render-list order ------------------------------------------------------------------ */

/** The fields of three's render item the sorts read. */
export interface DepthSortItem {
  groupOrder: number
  renderOrder: number
  material: { id: number }
  materialVariant?: number
  z: number
  id: number
}

/*
 * THREE REVERSES THE WHOLE RENDER LIST under a reversed depth buffer — renderOrder and all — after
 * sorting it with these. So they sort every key the opposite way of three's own painter sorts, and
 * three's reverse() lands the list in the order it should have been: renderOrder ascending, opaque
 * front-to-back (a larger reversed z is nearer), transparent back-to-front. (corridor, the sky-only
 * frame, 2026-10-08.)
 */

/** The opaque comparator for a reversed buffer. */
export function reversedOpaqueSort(a: DepthSortItem, b: DepthSortItem): number {
  return a.groupOrder !== b.groupOrder ? b.groupOrder - a.groupOrder
    : a.renderOrder !== b.renderOrder ? b.renderOrder - a.renderOrder
    : a.material.id !== b.material.id ? b.material.id - a.material.id
    : (a.materialVariant ?? 0) !== (b.materialVariant ?? 0) ? (b.materialVariant ?? 0) - (a.materialVariant ?? 0)
    : a.z !== b.z ? a.z - b.z
    : b.id - a.id
}

/** The transparent (and transmissive) comparator for a reversed buffer. */
export function reversedTransparentSort(a: DepthSortItem, b: DepthSortItem): number {
  return a.groupOrder !== b.groupOrder ? b.groupOrder - a.groupOrder
    : a.renderOrder !== b.renderOrder ? b.renderOrder - a.renderOrder
    : a.z !== b.z ? b.z - a.z
    : b.id - a.id
}

/**
 * Install the reversed comparators when the renderer's depth is reversed, three's own otherwise.
 * `createRenderer` and `setReversedDepth` call this; call it yourself only on a renderer you built
 * some other way. It replaces any custom sort the game set.
 */
export function installDepthSorts(renderer: WebGLRenderer): void {
  type Sort = Parameters<WebGLRenderer['setOpaqueSort']>[0]
  const on = isReversedDepth(renderer)
  renderer.setOpaqueSort((on ? reversedOpaqueSort : null) as unknown as Sort)
  renderer.setTransparentSort((on ? reversedTransparentSort : null) as unknown as Sort)
}

/* ---- clears, offsets, biases ---------------------------------------------------------------- */

/**
 * Set the depth clear value THROUGH three's state, in three's terms (1 = far, whichever way the
 * buffer runs). three caches the clear depth and inverts it under a reversed buffer; a raw
 * `gl.clearDepth` leaves GL and three disagreeing, and the next frame clears to "nearest" — a sky
 * and nothing else (corridor, 2026-10-08). Put it back to 1 when you are done.
 */
export function setDepthClear(renderer: WebGLRenderer, depth: number): void {
  renderer.state.buffers.depth.setClear(depth)
}

/**
 * +1 forwards, −1 reversed: multiply anything YOU express in window depth by it — a bias you add to
 * a depth you compare yourself in a shader. Not a material's polygonOffsetFactor: three turns that
 * one round itself (see `setPolygonOffset`). Null (no renderer yet) counts as forwards.
 */
export function depthSign(renderer: WebGLRenderer | null | undefined): 1 | -1 {
  return isReversedDepth(renderer) ? -1 : 1
}

/**
 * polygonOffset with the factor and units written as for a FORWARD buffer (positive pushes away
 * from the camera, negative pulls toward it), correct under either.
 *
 * HALF OF THIS THREE ALREADY DOES. three r185 negates the FACTOR itself when the buffer is reversed
 * (WebGLState.setPolygonOffset) and leaves the UNITS alone, so only the units are turned round
 * here. Negating both — the obvious fix — hands GL a slope term pointing the wrong way: stuntin's
 * ground, pushed back by factor 2 / units 4, came FORWARD over every road beyond ~100 m
 * (headless, 2026-10-10). `test/three-canary.test.ts` fails if three's half ever changes.
 *
 * Decided at the time of the call: a material built during an XR session keeps the forward sign.
 */
export function setPolygonOffset(material: Material, renderer: WebGLRenderer | null | undefined, factor: number, units: number): void {
  material.polygonOffset = true
  material.polygonOffsetFactor = factor
  material.polygonOffsetUnits = units * depthSign(renderer)
}

/**
 * A light shadow's bias for a shader that does its own shadow compare. three marks each shadow
 * camera `_reversedDepth` as it renders the map; the bias moves the receiver away from the light in
 * window depth, which a reversed buffer counts the other way. (three's own materials handle this.)
 */
export function shadowBias(shadow: { bias: number; camera: object }): number {
  return (shadow.camera as { _reversedDepth?: boolean })._reversedDepth ? -shadow.bias : shadow.bias
}

/* ---- GLSL ----------------------------------------------------------------------------------- */

/**
 * A skybox / dome / star field at the far plane, whichever way depth runs. Paste it above `main` in
 * a ShaderMaterial's vertex shader and write `gl_Position = toFarPlane(clip)` where you used to
 * write `clip.xyww`. three defines USE_REVERSED_DEPTH_BUFFER for ShaderMaterial (not for
 * RawShaderMaterial — define it yourself there from `isReversedDepth`).
 *
 * z = w is the far plane of a forward buffer and the NEAR plane of a reversed one: the dome then
 * draws in front of everything (corridor's sky, stars and galaxy, 2026-10-08).
 */
export const FAR_PLANE_GLSL = /* glsl */ `
vec4 toFarPlane(vec4 clip) {
#ifdef USE_REVERSED_DEPTH_BUFFER
  return vec4(clip.xy, 0.0, clip.w);
#else
  return clip.xyww;
#endif
}
`

/* ---- post-processing targets ---------------------------------------------------------------- */

/**
 * Give a render target a 32-bit float depth texture, so a reversed buffer drawn into it keeps its
 * precision (a 24-bit fixed buffer reversed is no better than forwards). Only when the renderer is
 * reversed and the target has a depth buffer, no stencil, and no depth texture of its own. Call
 * before the target is first rendered to. Returns whether it did.
 */
export function useFloatDepth(target: WebGLRenderTarget, renderer: WebGLRenderer | null | undefined): boolean {
  if (!isReversedDepth(renderer) || !target.depthBuffer || target.stencilBuffer || target.depthTexture) return false
  target.depthTexture = new DepthTexture(target.width, target.height, FloatType)
  return true
}

/**
 * The scene render target for a post composer (three's examples EffectComposer takes it as its
 * second argument) — a HalfFloat colour target with a FloatType depth texture — when the renderer is
 * reversed; `undefined` otherwise, so the composer builds its own default exactly as before.
 */
export function composerTarget(renderer: WebGLRenderer, width: number, height: number, type: TextureDataType = HalfFloatType): WebGLRenderTarget | undefined {
  if (!isReversedDepth(renderer)) return undefined
  return new WebGLRenderTarget(width, height, { type, depthTexture: new DepthTexture(width, height, FloatType) })
}
