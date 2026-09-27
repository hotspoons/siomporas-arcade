// Where a sound is, where you are, and how much of it reaches you.
//
// Rich, 2026-09-27: "make sure we add the ability to position the sound in 3D and do attenuation
// and all that for first and third person cameras etc."
//
// PURE ARITHMETIC, NO WEB AUDIO. Everything here is vectors and curves, so it can be tested
// without a browser and reasoned about without one — the file that talks to `PannerNode` and
// `AudioListener` (corridor's `enginesound.ts`) reads what this decides and does as it is told.
// The split matters because the interesting failures in spatial audio are geometric: a listener
// basis that is not orthonormal, a forward vector taken from the wrong end of the camera, a
// distance model that silences a car you are sitting in.
//
// THE FRAME IS THE SITE'S, x EAST, y NORTH, z UP — the one the bake, `placements.json` and the ECS
// all use, and NOT three's. Converting once at the edge is the rule actors.ts already states.
// Web Audio does not care which axis is up: its listener is defined by a forward and an up vector,
// so a consistent right-handed frame works whatever it is called.
//
// WHAT IS DELIBERATELY NOT HERE: Doppler. Web Audio removed it from the specification, and faking
// it for the car you are driving would be wrong anyway — the relative velocity is zero. When
// traffic gets voices, a passing car needs it and it will be a detune on the sample player, not a
// property of this.

export interface Vec3 {
  x: number
  y: number
  z: number
}

/** Where the ears are and which way they face. `forward` and `up` need not be unit or orthogonal. */
export interface Listener {
  position: Vec3
  forward: Vec3
  up: Vec3
}

/** What a panner and the gains around it should be set to this frame. */
export interface Spatial {
  /** the source, in site metres */
  position: Vec3
  /** metres from the ears to the source */
  distance: number
  /**
   * 0 = outside the car, 1 = sitting in it.
   *
   * THE REASON THERE ARE TWO BUSES. A point source three feet in front of your face is not what an
   * engine sounds like from the driver's seat: you are inside the box it is bolted to, you hear it
   * through the bulkhead, and it is *around* you rather than in a direction. Panning that hard in
   * first person is the single most common way car audio feels wrong. So the exterior bus is
   * spatialised and the interior bus is not, and this number crossfades them.
   */
  interior: number
  /** how much the cabin muffles it: a lowpass corner in Hz for the interior bus */
  muffleHz: number
}

export interface SpatialOpts {
  /** inside this many metres of the source you are considered to be in the cabin */
  interiorM?: number
  /** and fully outside beyond this */
  exteriorM?: number
  /** the lowpass corner applied at `interior = 1` */
  muffleHz?: number
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const len = (v: Vec3) => Math.hypot(v.x, v.y, v.z)
const scale = (v: Vec3, k: number): Vec3 => ({ x: v.x * k, y: v.y * k, z: v.z * k })
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })

/** A unit vector, or the fallback when the input has no length to speak of. */
export function unit(v: Vec3, fallback: Vec3 = { x: 0, y: 1, z: 0 }): Vec3 {
  const l = len(v)
  return l > 1e-6 ? scale(v, 1 / l) : fallback
}

/**
 * An orthonormal listener basis, whatever was handed in.
 *
 * A camera's up vector is rarely exactly perpendicular to its forward — it is usually world-up,
 * kept for stability — and Web Audio does not require orthogonality but behaves unhelpfully
 * without it, tilting the image as you look up or down. Gram-Schmidt removes the forward component
 * from up and renormalises, which is one line and is the difference between a stable stereo image
 * and one that swims when you pitch the camera.
 *
 * The degenerate case is looking straight up or straight down, where forward and up are parallel
 * and there is no way to tell which way "sideways" is. That picks an arbitrary perpendicular
 * rather than producing NaN, because NaN in a listener orientation silences everything with no
 * error anywhere.
 */
export function basis(l: Listener): { forward: Vec3; up: Vec3 } {
  const f = unit(l.forward, { x: 0, y: 1, z: 0 })
  let u = l.up
  const d = dot(u, f)
  u = { x: u.x - f.x * d, y: u.y - f.y * d, z: u.z - f.z * d }
  if (len(u) < 1e-6) {
    // forward is parallel to up: any perpendicular will do, and one always exists
    const pick: Vec3 = Math.abs(f.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 }
    u = cross(cross(f, pick), f)
  }
  return { forward: f, up: unit(u, { x: 0, y: 0, z: 1 }) }
}

/**
 * How loud a source is at a distance, as Web Audio's `inverse` model computes it.
 *
 * Reimplemented rather than left to the PannerNode because the interior bus is NOT spatialised and
 * still has to attenuate, and having two different curves for the same source is how a crossfade
 * develops a hole in the middle.
 *
 *     gain = ref / (ref + rolloff * (max(d, ref) - ref))
 *
 * At `d <= ref` it is 1, which is what makes the car you are sitting in full volume rather than
 * something that fades as the chase camera breathes.
 */
export function inverseGain(distance: number, refDistance: number, rolloffFactor: number, maxDistance: number): number {
  const d = Math.min(Math.max(distance, refDistance), maxDistance)
  return refDistance / (refDistance + rolloffFactor * (d - refDistance))
}

/**
 * Everything the audio graph needs for one source this frame.
 *
 * `interior` is a smoothstep rather than a step, so walking the chase camera in toward the car
 * does not snap between two very different sounds — and so switching from cockpit to chase is a
 * short crossfade rather than a click.
 */
export function spatialFor(source: Vec3, listener: Listener, opts: SpatialOpts = {}): Spatial {
  const interiorM = opts.interiorM ?? 1.6
  const exteriorM = opts.exteriorM ?? 4.0
  const distance = len(sub(source, listener.position))
  const t = Math.min(1, Math.max(0, (exteriorM - distance) / Math.max(0.001, exteriorM - interiorM)))
  const interior = t * t * (3 - 2 * t)
  return { position: source, distance, interior, muffleHz: opts.muffleHz ?? 900 }
}
