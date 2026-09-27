// One sound, somewhere in the world — the Web Audio half of spatial.ts.
//
// `spatial.ts` decides WHERE a source is relative to the ears and how much of it should reach
// them. This owns the nodes that carry it out, and nothing else: it has no idea what an engine is,
// which is why traffic can have fifty of these when it gets voices and the player's car is not a
// special case of anything.
//
//   source ──┬── panner ── exterior ──┐
//            │                        ├── out ──▶
//            └── muffle ── interior ──┘
//
// TWO BUSES, because a point source a metre in front of your face is not what an engine sounds
// like from the driver's seat. You are inside the box it is bolted to: you hear it through a
// bulkhead, and it is AROUND you rather than in a direction. Panning hard in first person is the
// single most common way car audio feels wrong, and the fix is not a cleverer panner — it is not
// panning at all when you are inside. `spatialFor().interior` crossfades the two.
//
// Everything is `setTargetAtTime`. An AudioParam stepped once per frame clicks, and the click is
// worse the faster you are going.

import { basis, inverseGain, spatialFor, type Listener, type Vec3 } from './spatial'

export interface VoiceOptions {
  /** full volume inside this radius */
  refDistance?: number
  /** attenuation stops getting worse past this */
  maxDistance?: number
  /** 1 is the physical inverse law */
  rolloffFactor?: number
  /** inside this you are in the cabin and it stops being panned */
  interiorM?: number
  /** beyond this it is fully a point source out in the world */
  exteriorM?: number
  /** the cabin lowpass corner at interior = 1 */
  muffleHz?: number
  /**
   * A measured head model instead of the equal-power pan law. OFF by default, and the reason is
   * measured rather than aesthetic — see INTERIOR_MATCH below.
   */
  hrtf?: boolean
  /** the AudioParam time constant, in seconds. ~3 frames at 60 Hz by default. */
  glide?: number
}

const DEFAULTS: Required<VoiceOptions> = {
  refDistance: 2.5,
  maxDistance: 400,
  rolloffFactor: 0.9,
  interiorM: 1.6,
  exteriorM: 4.0,
  muffleHz: 900,
  hrtf: false,
  glide: 0.05,
}

/**
 * How much quieter the interior bus has to be than the exterior one to weigh the same.
 *
 * THIS IS NOT A FUDGE FACTOR, it is the pan law. A mono signal reaching a stereo output is
 * up-mixed by COPYING — gain 1 into both channels — while an equal-power panner at centre puts
 * cos(π/4) = 0.7071 into each. So an unpanned bus is 3 dB louder than a panned one carrying the
 * same signal, and a crossfade between them steps by 3 dB in the middle: you would hear the level
 * jump as the camera went from cockpit to chase, which is the exact thing the two buses exist to
 * make seamless. Measured, not assumed: probes/enginesim-panlaw.mjs renders both and compares, and
 * probes/enginesim-spatial.mjs fails if the crossfade ever steps again.
 *
 * WHY THE DEFAULT IS NOT HRTF. The same probe swept Chromium's HRTF panner across frequency and
 * azimuth and found its broadband gain varies by 5.25× (at 220 Hz dead ahead it is +3.8 dB; at
 * 12 kHz behind you it is −10.6 dB). That is a real head doing real things, and for a footstep
 * or a voice it is worth it. For this it is not: the whole point of a simulated combustion engine
 * is that the timbre is the actual resonance of the actual cylinders, and an HRTF comb-filters
 * that differently every time you turn the wheel. Equal-power is flat to four decimal places at
 * every frequency and every angle, so the engine sounds like the engine and only its DIRECTION
 * changes. HRTF stays one knob away for anyone who wants it.
 */
const INTERIOR_MATCH = Math.SQRT1_2

/** What `place` decided, so a caller (or a probe) can see it without reading AudioParams. */
export interface Placement {
  distance: number
  interior: number
  /** the distance gain both buses are held to */
  attenuation: number
  /** the interior bus's lowpass corner this frame */
  muffleHz: number
}

export class SpatialVoice {
  readonly out: GainNode
  private readonly panner: PannerNode
  private readonly muffle: BiquadFilterNode
  private readonly exterior: GainNode
  private readonly interior: GainNode
  private readonly ctx: BaseAudioContext

  constructor(ctx: BaseAudioContext, options: VoiceOptions = {}) {
    const o = { ...DEFAULTS, ...options }
    this.ctx = ctx
    this.out = ctx.createGain()

    this.panner = ctx.createPanner()
    this.panner.panningModel = o.hrtf ? 'HRTF' : 'equalpower'
    this.panner.distanceModel = 'inverse'
    this.panner.refDistance = o.refDistance
    this.panner.maxDistance = o.maxDistance
    this.panner.rolloffFactor = o.rolloffFactor
    this.exterior = ctx.createGain()
    // Starts silent and the interior starts open, so a voice that is placed before it is heard
    // fades OUT of the cabin rather than in from infinity.
    this.exterior.gain.value = 0
    this.panner.connect(this.exterior)
    this.exterior.connect(this.out)

    this.muffle = ctx.createBiquadFilter()
    this.muffle.type = 'lowpass'
    this.muffle.frequency.value = 20000
    this.interior = ctx.createGain()
    this.interior.gain.value = INTERIOR_MATCH
    this.muffle.connect(this.interior)
    this.interior.connect(this.out)
  }

  /** Feed this voice. The source goes to BOTH buses; the crossfade picks which one you hear. */
  connectFrom(source: AudioNode): void {
    source.connect(this.panner)
    source.connect(this.muffle)
  }

  disconnect(): void {
    this.panner.disconnect()
    this.muffle.disconnect()
    this.exterior.disconnect()
    this.interior.disconnect()
    this.out.disconnect()
  }

  /**
   * Put this voice at `source` and the ears at `listener`, this frame.
   *
   * Sets the CONTEXT listener as well as the panner, because there is one pair of ears and every
   * voice shares them; calling this for several voices in a frame writes the same listener several
   * times, which is cheap and always consistent.
   */
  place(source: Vec3, listener: Listener, options: VoiceOptions = {}): Placement {
    const o = { ...DEFAULTS, ...options }
    const now = this.ctx.currentTime
    const glide = o.glide

    const { forward, up } = basis(listener)
    setXYZ(this.ctx.listener, 'position', listener.position, now, glide)
    setListenerOrientation(this.ctx, forward, up, now, glide)

    const spatial = spatialFor(source, listener, o)
    setXYZ(this.panner, 'position', spatial.position, now, glide)

    // Not AudioParams, so these take effect at once — which is what live tuning wants.
    this.panner.refDistance = o.refDistance
    this.panner.maxDistance = o.maxDistance
    this.panner.rolloffFactor = o.rolloffFactor
    const model = o.hrtf ? 'HRTF' : 'equalpower'
    if (this.panner.panningModel !== model) this.panner.panningModel = model

    // The panner applies its own distance gain to the exterior bus, so THIS is the curve the
    // interior bus needs to match it: the same formula, computed by hand, on the branch the
    // panner never sees. Two different curves on one source is how a crossfade develops a hole.
    const attenuation = inverseGain(spatial.distance, o.refDistance, o.rolloffFactor, o.maxDistance)

    // Equal-GAIN, not equal-power. The two buses are the same signal, so at the halfway point they
    // sum coherently and a √0.5/√0.5 crossfade would be 3 dB loud in the middle — which is exactly
    // the distance the chase camera sits at.
    this.exterior.gain.setTargetAtTime(1 - spatial.interior, now, glide)
    this.interior.gain.setTargetAtTime(spatial.interior * attenuation * INTERIOR_MATCH, now, glide)
    // Open the cabin filter back up on the way out, so the interior bus is not audibly dull while
    // it still has any weight in the crossfade.
    const corner = spatial.muffleHz + (20000 - spatial.muffleHz) * (1 - spatial.interior)
    this.muffle.frequency.setTargetAtTime(corner, now, glide)

    return { distance: spatial.distance, interior: spatial.interior, attenuation, muffleHz: corner }
  }

  /** For tests and probes: what the graph is actually set to right now. */
  get state() {
    return {
      panningModel: this.panner.panningModel,
      refDistance: this.panner.refDistance,
      maxDistance: this.panner.maxDistance,
      rolloffFactor: this.panner.rolloffFactor,
      exterior: this.exterior.gain.value,
      interior: this.interior.gain.value,
      muffleHz: this.muffle.frequency.value,
    }
  }
}

/*
 * AudioParams or the deprecated setters, whichever this browser has.
 *
 * `PannerNode.positionX` and friends are the modern form and the only one that can be RAMPED —
 * `setPosition` jumps, and a jump per frame on a moving car is an audible zipper. But Safari
 * shipped the old form for years, some builds still only have it, and a spatialiser that throws on
 * the first frame takes the whole engine down with it.
 */
function setXYZ(
  target: PannerNode | AudioListener,
  which: 'position' | 'orientation',
  v: Vec3,
  now: number,
  glide: number,
): void {
  const axes = which === 'position'
    ? (['positionX', 'positionY', 'positionZ'] as const)
    : (['orientationX', 'orientationY', 'orientationZ'] as const)
  const holder = target as unknown as Record<string, AudioParam | undefined>
  const px = holder[axes[0]]
  if (px) {
    px.setTargetAtTime(v.x, now, glide)
    holder[axes[1]]?.setTargetAtTime(v.y, now, glide)
    holder[axes[2]]?.setTargetAtTime(v.z, now, glide)
    return
  }
  const legacy = target as unknown as Record<string, ((x: number, y: number, z: number) => void) | undefined>
  legacy[which === 'position' ? 'setPosition' : 'setOrientation']?.(v.x, v.y, v.z)
}

/** The listener's orientation is six numbers in one call in the legacy form, so it gets its own. */
function setListenerOrientation(
  ctx: BaseAudioContext, forward: Vec3, up: Vec3, now: number, glide: number,
): void {
  const l = ctx.listener as unknown as Record<string, AudioParam | undefined>
  if (l.forwardX) {
    l.forwardX.setTargetAtTime(forward.x, now, glide)
    l.forwardY?.setTargetAtTime(forward.y, now, glide)
    l.forwardZ?.setTargetAtTime(forward.z, now, glide)
    l.upX?.setTargetAtTime(up.x, now, glide)
    l.upY?.setTargetAtTime(up.y, now, glide)
    l.upZ?.setTargetAtTime(up.z, now, glide)
    return
  }
  const legacy = ctx.listener as unknown as {
    setOrientation?: (fx: number, fy: number, fz: number, ux: number, uy: number, uz: number) => void
  }
  legacy.setOrientation?.(forward.x, forward.y, forward.z, up.x, up.y, up.z)
}
