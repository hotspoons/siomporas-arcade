// GPU pass timings for the performance panel: what each stage of the frame actually costs on the
// GPU, as a running average.
//
// WHY A TIMER QUERY AND NOT A CLOCK. `performance.now()` around a `renderer.render` measures how
// long it took to SUBMIT the draw calls, not how long the GPU then spent drawing them — with vsync
// on, that gap is where the whole cost hides (the same reason the panel keeps cpu and frame time
// apart). `EXT_disjoint_timer_query_webgl2` asks the GPU itself. The extension is webgl2-only and
// missing under swiftshader, so every method here is a no-op and `available` is false when it is
// not there; the panel then simply shows no gpu line rather than a lie.
//
// ONE QUERY PER PASS, ROUND-ROBIN. WebGL2 allows only one active query per target, so passes are
// timed strictly one after another inside a frame — begin, draw, end, next. A query's result is
// not ready until a frame or two later, so each label keeps one query in flight; if a label's
// result has not come back yet, that pass is skipped this frame rather than stalling the loop
// waiting for the GPU. The result is folded into an exponential average, which is the running
// average the panel reports.

import type * as THREE from 'three'

export interface GpuSpan {
  label: string
  /** running-average milliseconds on the GPU */
  ms: number
}

interface Slot {
  q: WebGLQuery | null
  started: boolean
  pending: boolean
}

/** `EXT_disjoint_timer_query_webgl2` is not in the TS lib; the two fields we use, spelled out. */
interface TimerExt {
  TIME_ELAPSED_EXT: number
  GPU_DISJOINT_EXT: number
}

export class GpuProfiler {
  readonly labels: readonly string[]
  /** false on a context without the timer extension: every call is then a no-op */
  readonly available: boolean
  private gl: WebGL2RenderingContext
  private ext: TimerExt | null
  private slots = new Map<string, Slot>()
  private ema = new Map<string, number>()

  constructor(renderer: THREE.WebGLRenderer, labels: readonly string[]) {
    this.labels = labels
    const gl = renderer.getContext() as WebGL2RenderingContext
    this.gl = gl
    this.ext = (gl.getExtension?.('EXT_disjoint_timer_query_webgl2') ?? null) as TimerExt | null
    this.available = !!this.ext && typeof gl.createQuery === 'function'
    for (const l of labels) this.slots.set(l, { q: null, started: false, pending: false })
  }

  /** Start timing `label`, unless its previous query has not landed yet. */
  begin(label: string): void {
    if (!this.available) return
    const s = this.slots.get(label)
    if (!s || s.pending) return
    const q = s.q ?? (s.q = this.gl.createQuery())
    this.gl.beginQuery(this.ext!.TIME_ELAPSED_EXT, q)
    s.started = true
  }

  /** Stop timing `label`. Does nothing if `begin` skipped it this frame. */
  end(label: string): void {
    if (!this.available) return
    const s = this.slots.get(label)
    if (!s || !s.started) return
    this.gl.endQuery(this.ext!.TIME_ELAPSED_EXT)
    s.started = false
    s.pending = true
  }

  /**
   * Collect any finished queries into the running average. Call once a frame, before `begin`.
   *
   * A DISJOINT result means the GPU was reclocked or the timer lost coherence mid-query (a tab
   * switch, a driver power state); the numbers from that span are garbage, so they are dropped
   * rather than averaged in.
   */
  poll(): void {
    if (!this.available) return
    if (this.gl.getParameter(this.ext!.GPU_DISJOINT_EXT)) {
      for (const s of this.slots.values()) if (s.pending) this.discard(s)
      return
    }
    for (const [label, s] of this.slots) {
      if (!s.pending || !s.q) continue
      if (!this.gl.getQueryParameter(s.q, this.gl.QUERY_RESULT_AVAILABLE)) continue
      const ns = this.gl.getQueryParameter(s.q, this.gl.QUERY_RESULT) as number
      const ms = ns / 1e6
      const prev = this.ema.get(label)
      this.ema.set(label, prev === undefined ? ms : prev * 0.8 + ms * 0.2)
      this.discard(s)
    }
  }

  private discard(s: Slot): void {
    if (s.q) this.gl.deleteQuery(s.q)
    s.q = null
    s.started = false
    s.pending = false
  }

  read(): GpuSpan[] {
    return this.labels.map((label) => ({ label, ms: this.ema.get(label) ?? 0 }))
  }

  reset(): void {
    this.ema.clear()
  }
}
