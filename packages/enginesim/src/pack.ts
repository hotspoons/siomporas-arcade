// A baked engine: the simulator's voice, recorded once, so a car park full of them costs nothing.
//
// Rich, 2026-09-27: "we are going to want to be able to prebake a library of engine sounds for
// other cars in the game so we don't need to run 20 instances of engine simulator for ambient
// traffic noise ... each vehicle will of course get its own real simulator while in it, but for
// exterior world shots we'll want sound fonts/lib sounds baked from the simulator. And we'll want
// to be able to rebake it when we add more configs."
//
// So: the car you are in gets EngineSim (45% of a core, and worth it — the note is the actual
// resonance of the actual cylinders). Everything else gets this, which is the same engine, the
// same script, the same synthesizer, recorded at a ladder of RPMs and played back on four
// AudioBufferSourceNodes.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE ONE HARD PART IS THE LOOP.
//
// An engine's sound repeats every ENGINE CYCLE — two crank revolutions for a four-stroke,
// whatever the cylinder count, because that is when the same cylinder fires again in the same
// order. One cycle is 120/rpm seconds. A loop of N cycles is therefore N·120/rpm seconds, and a
// loop that is anything else clicks once per wrap, forever, at a rate that tracks the engine
// speed — which is the most irritating possible artefact because it sounds like a fault in the
// car.
//
// That length is rarely a whole number of samples. 1000 rpm is 0.12 s, which at 48 kHz is 5760
// samples exactly; 1700 rpm is 0.0705882… s, which is 3388.23 samples and is not. Rather than
// round the loop (which detunes it) or resample (which smears it), this moves the BAKE rpm by a
// fraction of a rev to the nearest value whose cycle is a whole number of samples:
//
//     cycleSamples = round(120 · sampleRate / rpm)   ← an integer, by construction
//     bakedRpm     = 120 · sampleRate / cycleSamples ← what we actually recorded
//
// HOW FAR THAT MOVES THE RPM. Rounding the cycle by at most half a sample moves the rpm by at
// most rpm²/(240·sampleRate) — 0.04 rpm at idle, 7 rpm at 9000. That is an absolute error that
// grows with the square of the rev, but the RATIO is what the ear hears, and the ratio is
// 0.5·rpm/(120·sampleRate): 0.008% at idle and 0.078% at 9000 rpm on a 48 kHz bake. In musical
// terms that worst case is 1.4 cents, and the ear needs around five to notice a pitch change at
// all.
//
// Two earlier versions of this comment were wrong about it and the test caught both: "under half
// an rpm" (false above about 2500 rpm, because the error is quadratic) and "a thousandth of a
// semitone" (off by an order of magnitude — a semitone is 5.95%, so 0.078% is a fortieth of one).
// The bound is asserted in test/pack.test.ts rather than left as prose.
//
// PLAYBACK RATE RESTORES THE EXACT RPM. A layer baked at 1699.88 rpm asked to be 1830 rpm plays
// at 1830/1699.88 = 1.0765×. That is what makes eight layers cover a whole rev range: between
// them, the pitch is a resample of the nearest one, and the layers exist so the resample is never
// far enough to sound like a tape machine.
//
// The manifest stores the loop in SECONDS as well as samples, because `decodeAudioData` resamples
// to the context's rate — a 48 kHz bake in a 44.1 kHz context is no longer a whole number of
// samples, but it is still a whole number of CYCLES, and the loop is defined in continuous time.

/** One recorded layer: a rev, a throttle position, and a seamless loop of it. */
export interface PackLayer {
  /** the rpm actually recorded, which is the requested one nudged onto a whole-sample cycle */
  rpm: number
  /** 0 = overrun (foot off), 1 = wide open. Two is enough; the ear fills in the rest. */
  pedal: number
  /** the audio file, relative to the pack root */
  file: string
  /** the loop, in seconds — authoritative, because a context may not run at the baked rate */
  loopStart: number
  loopEnd: number
  /** and in samples at `sampleRate`, for a baker or a test that wants to check the arithmetic */
  loopStartSamples: number
  loopEndSamples: number
  /** whole engine cycles in the loop */
  cycles: number
  /** peak and rms of the loop, so a player can normalise without decoding everything first */
  peak: number
  rms: number
}

export interface EnginePack {
  /** the engine script this was baked from, e.g. engines/atg-video-2/07_gm_ls.mr */
  source: string
  /** the engine's own name, as the script declares it */
  name: string
  cylinders: number
  /** cubic metres, as the simulator reports it */
  displacement: number
  sampleRate: number
  /** every layer, sorted by pedal then rpm */
  layers: PackLayer[]
  /** what produced this, so a stale pack can be told from a current one without listening to it */
  bakedAt: string
  bakerVersion: number
  /** the synthesizer settings in force during the bake; a rebake with different ones is a new pack */
  voicing: Record<string, number>
}

/** A library of packs, which is what the game loads. */
export interface PackIndex {
  version: number
  bakedAt: string
  packs: { id: string; source: string; name: string; cylinders: number; dir: string }[]
}

/** The baker's own version. Bump it when the OUTPUT changes, so stale packs are detectable. */
export const BAKER_VERSION = 1

/**
 * One engine cycle in whole samples: the number the whole scheme rests on.
 *
 * Four-stroke, so the cycle is two crank revolutions regardless of cylinder count — that is when
 * the same cylinder fires again in the same order, and it is the period the sound actually has.
 */
export function cycleSamples(rpm: number, sampleRate: number): number {
  return Math.max(1, Math.round((120 * sampleRate) / rpm))
}

/** The rpm we will really record, having moved the cycle onto a whole number of samples. */
export function bakeRpm(rpm: number, sampleRate: number): number {
  return (120 * sampleRate) / cycleSamples(rpm, sampleRate)
}

/**
 * How many cycles to loop.
 *
 * Long enough that the ear does not hear the repeat, short enough that twenty cars is not a
 * hundred megabytes. An engine cycle at idle is about 150 ms and at redline about 17 ms, so a
 * fixed cycle COUNT would give a long loop at idle and a very short one at the top — the wrong
 * way round, because the top end is where a short repeat is most obvious. This targets a
 * DURATION and rounds to whole cycles.
 *
 * The floor is 2, not 1: one cycle is the shortest thing that can possibly loop, and it loops at
 * the firing rate, which the ear hears as a buzz rather than an engine. Two was chosen over four
 * because four fought the target at idle — 800 rpm wants 3.3 cycles and a floor of four made the
 * idle loop 0.6 s while every other layer was 0.5.
 */
export function loopCycles(rpm: number, targetSeconds = 0.5, minCycles = 2): number {
  return Math.max(minCycles, Math.round((targetSeconds * rpm) / 120))
}

/**
 * The rev ladder for one engine.
 *
 * Geometric, not linear. Pitch is logarithmic, so equal rpm steps are wide at the bottom and
 * pointless at the top: from 800 rpm, a 400 rpm step is a musical fourth; from 6000 it is a
 * semitone. A geometric ladder makes every step the same INTERVAL, which is the same amount of
 * resampling in each direction and therefore the same amount of audible stretch.
 *
 * `maxStep` caps the interval — the default 1.26 is about four semitones, which is roughly where
 * a resampled engine layer starts to sound like a tape machine rather than an engine.
 */
export function rpmLadder(idle: number, redline: number, maxStep = 1.26): number[] {
  if (!(redline > idle)) return [idle]
  const steps = Math.max(1, Math.ceil(Math.log(redline / idle) / Math.log(maxStep)))
  const ratio = Math.pow(redline / idle, 1 / steps)
  const out: number[] = []
  for (let i = 0; i <= steps; i += 1) out.push(idle * Math.pow(ratio, i))
  return out
}

/**
 * Which two layers bracket an rpm, and how far between them we are.
 *
 * `t` is in PITCH, not in rpm: the crossfade between two layers is a crossfade between two
 * resamplings of the same engine, and what the ear tracks is the interval. Linear interpolation
 * in rpm puts the halfway point in the wrong place and makes the lower layer hang around too
 * long, audible as a rev that speeds up in lurches.
 */
export function bracket(layers: readonly PackLayer[], rpm: number): { lo: number; hi: number; t: number } {
  if (layers.length === 0) return { lo: -1, hi: -1, t: 0 }
  if (layers.length === 1 || rpm <= layers[0].rpm) return { lo: 0, hi: 0, t: 0 }
  const last = layers.length - 1
  if (rpm >= layers[last].rpm) return { lo: last, hi: last, t: 0 }
  let i = 0
  while (i < last && layers[i + 1].rpm < rpm) i += 1
  const a = layers[i].rpm, b = layers[i + 1].rpm
  const t = Math.log(rpm / a) / Math.log(b / a)
  return { lo: i, hi: i + 1, t: Math.min(1, Math.max(0, t)) }
}

/** What to set `playbackRate` to so a layer baked at `bakedRpm` sounds like `rpm`. */
export function playbackRate(bakedRpm: number, rpm: number): number {
  return rpm / bakedRpm
}
