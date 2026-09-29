// Listen to the engine you are editing, from the form.
//
// docs/corridor/PLAN-VEHICLES-ACTORS.md §4 item 2: "the enginesim setup picker and its audio mix,
// with a **listen** button — audio you cannot hear while tuning is audio nobody tunes."
//
// WHY THIS IS A FILE AND NOT FOUR LINES IN THE FORM. An `AudioContext` is a resource with a
// lifetime, an `EngineSim` holds a worklet and a wasm instance, and a browser will not start either
// without a real gesture. Four lines in a click handler gets all three wrong: a context per click
// exhausts the browser's supply, an engine left running keeps playing after the pane closes, and
// the failure modes (no worklet support, wasm that will not fetch, a context the browser suspended
// again) all arrive as an exception from somewhere unhelpful. So: one bench, one context, reused.
//
// IT IS A DYNO, NOT THE GAME'S PATH. `setFree({ dyno: true })` hands the drivetrain back to
// engine-sim so it revs against its own inertia — which is what you want on a bench and is NOT what
// the game does (`enginesound.ts` drives rpm through corridor's own gearbox). Tuning against the
// dyno and playing against the gearbox is the right split: the bench is for the engine's voice, the
// game is for what the car does with it.
//
// THE GESTURE IS THE BUTTON. An AudioContext created inside a click handler is allowed to start, so
// `listen()` must be called synchronously from one — which it is, and which is why there is no
// "enable audio" step anywhere in this file.
import { EngineSim, ENGINES, RPM_PER_RAD, enginesByGroup, type EngineProfile } from '@apex/enginesim'

/**
 * An engine script's rev range, in RPM.
 *
 * `EngineProfile.redline` is RADIANS PER SECOND, and `RPM_PER_RAD` is 60/2π ≈ 9.549 — so RPM is
 * rad/s **times** it. The doc comment on that field in `packages/enginesim/src/EngineSim.ts` says
 * "divide by RPM_PER_RAD for RPM", which is backwards: a 7000 rpm engine declares 733 rad/s, and
 * 733 × 9.549 is 7000 while 733 ÷ 9.549 is 77. Nothing depended on it before this file, which is
 * presumably why it survived.
 *
 * There is no idle in the profile at all, so it is a fraction of the redline, bounded to somewhere
 * an engine actually idles.
 */
function revRange(p: EngineProfile | null | undefined): { idle: number; redline: number } {
  const redline = p?.redline ? p.redline * RPM_PER_RAD : 7000
  return { idle: Math.min(1200, Math.max(600, redline * 0.12)), redline }
}

export interface ListenOptions {
  /** the engine script to load — a `path` from the enginesim catalog */
  setup: string
  /** 0…1, straight onto the synthesizer's own volume */
  gain?: number
  /** Hz; the lowpass the vehicle document asks for, applied on the way out */
  lowpass?: number
  /** where on the rev range to sit it. 0…1 of idle→redline */
  throttle?: number
  /** stop on its own after this long, seconds. 0 = until stopped */
  seconds?: number
  onState?: (s: ListenState) => void
}

export type ListenState =
  | { at: 'starting' }
  | { at: 'running'; engine: string }
  | { at: 'stopped' }
  | { at: 'failed'; why: string }

/** Every engine script this build ships, grouped for a picker. */
export function engineChoices(): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = []
  for (const [group, entries] of enginesByGroup()) {
    for (const e of entries) out.push({ value: e.path, label: `${group} — ${e.name}` })
  }
  return out.sort((a, b) => a.label.localeCompare(b.label))
}

/** Is this a script the build actually has? For the validator's `audioSetups`. */
export function engineSetups(): string[] {
  return ENGINES.map((e) => e.path)
}

/**
 * The bench. One at a time, deliberately.
 *
 * A second engine started while the first is running is two combustion simulations in the audio
 * thread — about 90% of a core, measured on the machine `packages/enginesim/scripts/measure.mjs`
 * was run on — and the second one is the only one anybody wanted. So `listen` stops whatever was
 * playing before it starts.
 */
class Bench {
  private ctx: AudioContext | null = null
  private sim: EngineSim | null = null
  private gain: GainNode | null = null
  private filter: BiquadFilterNode | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private token = 0
  private playing: string | null = null

  get running(): string | null {
    return this.playing
  }

  /**
   * Start it. MUST be called synchronously from a click, or the browser will not let the context
   * run and the whole thing will sit there silently in the `suspended` state.
   */
  async listen(o: ListenOptions): Promise<void> {
    const mine = ++this.token
    await this.stop()
    if (mine !== this.token) return // somebody clicked again while we were tearing down
    o.onState?.({ at: 'starting' })
    try {
      // The context is made HERE, inside the gesture's call stack. Making it lazily somewhere else
      // is how an editor ends up with a context the browser refuses to start.
      this.ctx ??= new AudioContext()
      if (this.ctx.state === 'suspended') await this.ctx.resume()
      const sim = await EngineSim.create(this.ctx)
      if (mine !== this.token) { sim.disconnect(); return }
      const profile = await sim.load(o.setup)
      if (mine !== this.token) { sim.disconnect(); return }

      // gain and the document's lowpass, in that order, between the engine and the speakers — the
      // same two numbers `audio.gain` and `audio.lowpass_hz` mean in the game.
      const filter = this.ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.value = Math.max(100, Math.min(20000, o.lowpass ?? 9000))
      const gain = this.ctx.createGain()
      gain.gain.value = Math.max(0, Math.min(1, o.gain ?? 0.8))
      sim.connect(filter)
      filter.connect(gain)
      gain.connect(this.ctx.destination)

      // Free-revving: engine-sim drives its own inertia, which is what a bench is.
      sim.setIgnition(true)
      sim.setStarter(true)
      sim.setFree({ dyno: true })
      setTimeout(() => sim.setStarter(false), 600)
      const { idle, redline } = revRange(profile)
      const t = Math.max(0, Math.min(1, o.throttle ?? 0.35))
      sim.drive(idle + (redline - idle) * t, t)

      this.sim = sim
      this.gain = gain
      this.filter = filter
      this.playing = o.setup
      o.onState?.({ at: 'running', engine: o.setup })
      if (o.seconds && o.seconds > 0) {
        this.timer = setTimeout(() => { void this.stop().then(() => o.onState?.({ at: 'stopped' })) }, o.seconds * 1000)
      }
    } catch (e) {
      await this.stop()
      // Every way this fails is a real state a person can hit — no AudioWorklet in this browser, a
      // wasm that will not fetch behind a proxy, a context the browser suspended again — so it is
      // reported rather than thrown. A silent listen button is worse than one that says why.
      o.onState?.({ at: 'failed', why: (e as Error).message })
    }
  }

  /** Change the rev point without restarting: what a slider wants. */
  rev(t: number): void {
    if (!this.sim) return
    const { idle, redline } = revRange(this.sim.profile)
    const x = Math.max(0, Math.min(1, t))
    this.sim.drive(idle + (redline - idle) * x, x)
  }

  setGain(v: number): void {
    if (this.gain) this.gain.gain.value = Math.max(0, Math.min(1, v))
  }

  setLowpass(hz: number): void {
    if (this.filter) this.filter.frequency.value = Math.max(100, Math.min(20000, hz))
  }

  async stop(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.playing = null
    const sim = this.sim
    this.sim = null
    if (sim) {
      sim.setIgnition(false)
      sim.setMuted(true)
      sim.disconnect()
    }
    this.gain?.disconnect()
    this.filter?.disconnect()
    this.gain = null
    this.filter = null
    // The CONTEXT is kept. Closing and reopening one per listen exhausts the browser's supply of
    // them (Chrome allows about six per page) and a bench is clicked a great many times.
  }
}

/** The one bench. Module-scope because a second simultaneous engine is never what anybody wanted. */
export const bench = new Bench()
