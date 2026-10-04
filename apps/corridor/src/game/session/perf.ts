// What the frame rate actually is, rather than what it feels like.
//
// Rich, 2026-09-29: *"Can we add a setting to show a performance stats display that includes FPS,
// memory, p95/p99 info, cpu time, etc.? trailworks would be a good example."*
//
// THE AVERAGE IS THE LEAST USEFUL NUMBER ON THE SCREEN. A run that holds 60 fps and drops four
// frames a second to 8 ms of garbage collection reads as "58 fps" and feels broken; the thing you
// can feel is the tail. So this keeps a window of raw frame times and reports the percentiles, the
// worst frame, and how much time was LOST to stalls — which is the number that says whether a hitch
// is one long pause or a hundred small ones.
//
// `ext/trailworks/viewer/src/render/PerfHud.tsx` is the model, and the shape of `RunSummary` there
// is deliberately the shape of `PerfSummary` here: fps, p50, p95, p99, max, stalls, time lost. That
// is a good set, arrived at by staring at a globe renderer for a month, and there is no reason for
// this to invent a different one.
//
// NO DOM AND NO THREE. The HUD draws what this measures, and a headless probe can drive a hundred
// frames through it and assert the percentiles without a canvas. The renderer's own counters arrive
// as a plain record, so the same module serves the viewer, the editor's preview and a test.

/** How long a frame has to take before it counts as a stall rather than a slow frame. */
export const STALL_MS = 50

/** The frame budget a stall is measured against: 60 fps. */
export const BUDGET_MS = 1000 / 60

export interface PerfSummary {
  frames: number
  /** how long the window covers, seconds */
  sec: number
  fps: number
  /**
   * THE RUNNING AVERAGE, which the percentiles beside it deliberately are not.
   *
   * The panel led with p50 because the average hides a hitch, and that is still true. But the
   * average is the number that answers "what does the pipeline cost when it is behaving", and with
   * the per-family light ablations beside it, it is the one you compare against. So it is here, and
   * clearly labelled, rather than instead of the tail.
   */
  mean: number
  /** the median frame: what it is like most of the time */
  p50: number
  /** the tail: what it is like when it is bad, which is what you feel */
  p95: number
  p99: number
  max: number
  /** frames over `STALL_MS` */
  stalls: number
  /** Σ (ms − budget) over those frames: time lost to hitches, which is the honest total */
  stallMs: number
}

export const EMPTY_SUMMARY: PerfSummary = {
  frames: 0, sec: 0, fps: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0, stalls: 0, stallMs: 0,
}

/**
 * The p'th percentile of a set of samples, by nearest rank.
 *
 * NEAREST RANK, NOT INTERPOLATION, because every value here is a frame that really happened and a
 * p99 of 41.3 ms — a number no frame took — invites the question of which frame that was. The
 * answer should always be "that one".
 *
 * The input is not mutated: the caller's array is usually a live ring buffer.
 */
export function percentile(samples: readonly number[], p: number): number {
  if (!samples.length) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.ceil(Math.min(1, Math.max(0, p)) * sorted.length)
  return sorted[Math.max(0, rank - 1)]
}

/** Everything about a window of frame times. `sec` is how long they took in total. */
export function summarize(ms: readonly number[]): PerfSummary {
  if (!ms.length) return { ...EMPTY_SUMMARY }
  let total = 0
  let max = 0
  let stalls = 0
  let stallMs = 0
  for (const v of ms) {
    total += v
    if (v > max) max = v
    if (v >= STALL_MS) {
      stalls++
      stallMs += v - BUDGET_MS
    }
  }
  const sec = total / 1000
  return {
    frames: ms.length,
    sec: +sec.toFixed(3),
    // FRAMES OVER THE TIME THEY TOOK, not 1000 / mean: with a window of uneven frames the two
    // differ, and this one is the rate you would have measured with a stopwatch.
    fps: sec > 0 ? ms.length / sec : 0,
    mean: total / ms.length,
    p50: percentile(ms, 0.5),
    p95: percentile(ms, 0.95),
    p99: percentile(ms, 0.99),
    max,
    stalls,
    stallMs,
  }
}

/** The renderer's own counters, as a plain record so this module never imports three. */
export interface RenderCounts {
  calls: number
  triangles: number
  lines: number
  points: number
  geometries: number
  textures: number
  programs: number
}

export const NO_COUNTS: RenderCounts = {
  calls: 0, triangles: 0, lines: 0, points: 0, geometries: 0, textures: 0, programs: 0,
}

export interface PerfReading extends PerfSummary {
  counts: RenderCounts
  /** JS heap in megabytes, or null where the browser will not say (everything but Chrome) */
  heapMB: number | null
  heapLimitMB: number | null
  /** main-thread blocks over 50 ms, since the meter was reset */
  longTasks: number
  lastLongMs: number
  /**
   * How much of the frame was spent in OUR javascript, milliseconds.
   *
   * Measured by the caller around its own update-and-render, because only the caller knows where
   * that starts and stops. The gap between this and the frame time is the browser: compositing,
   * the GPU catching up, and whatever else is on the machine.
   */
  cpuMs: number
}

/**
 * The live meter: frames in, a reading out.
 *
 * A RING BUFFER, NOT A GROWING ARRAY. This runs every frame for as long as the HUD is open, and an
 * array that grows at 60 Hz is a memory leak that a performance panel would be especially silly to
 * have. The window is the last `capacity` frames — ten seconds at 60 fps by default, which is long
 * enough for a p99 to mean something and short enough to respond when you fly into trees.
 */
export class PerfMeter {
  private ms: number[] = []
  private cpu: number[] = []
  private at = 0
  private filled = 0
  private capacity: number
  private last = 0
  longTasks = 0
  lastLongMs = 0
  /**
   * The latest renderer counters, and their running average over the same window as the frames.
   *
   * `counts` is what the last frame drew; `countsSamples` is the ring the average is taken from.
   * The panel wants the average (a single noisy frame of draw calls is not a useful reading), but
   * keeps the instantaneous field because probes set it directly.
   */
  counts: RenderCounts = { ...NO_COUNTS }
  private countsSamples: (RenderCounts | undefined)[] = []
  private countsFilled = 0
  private obs: { disconnect: () => void } | null = null

  constructor(capacity = 600) {
    this.capacity = Math.max(8, capacity)
    this.ms = new Array(this.capacity).fill(0)
    this.cpu = new Array(this.capacity).fill(0)
    this.countsSamples = new Array(this.capacity)
  }

  /** Start counting long tasks. Safe where `PerformanceObserver` has no `longtask`, i.e. not Chrome. */
  watchLongTasks(): void {
    if (this.obs || typeof PerformanceObserver === 'undefined') return
    try {
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          this.longTasks++
          this.lastLongMs = e.duration
        }
      })
      obs.observe({ entryTypes: ['longtask'] })
      this.obs = obs
    } catch {
      this.obs = null
    }
  }

  stopWatching(): void {
    this.obs?.disconnect()
    this.obs = null
  }

  /** One frame: how long it took, how much of that was our own work, and what it drew. */
  frame(ms: number, cpuMs = 0, counts?: RenderCounts): void {
    if (!(ms > 0) || !Number.isFinite(ms)) return
    this.ms[this.at] = ms
    this.cpu[this.at] = Number.isFinite(cpuMs) ? cpuMs : 0
    if (counts) {
      this.counts = counts
      this.countsSamples[this.at] = counts
      if (this.countsFilled < this.capacity) this.countsFilled++
    }
    this.at = (this.at + 1) % this.capacity
    if (this.filled < this.capacity) this.filled++
    this.last = ms
  }

  /** The counters averaged over the window, or the last frame's when nothing was sampled yet. */
  private avgCounts(): RenderCounts {
    if (!this.countsFilled) return this.counts
    let n = 0
    const s = { ...NO_COUNTS }
    for (const c of this.countsSamples) {
      if (!c) continue
      n++
      s.calls += c.calls
      s.triangles += c.triangles
      s.lines += c.lines
      s.points += c.points
      s.geometries += c.geometries
      s.textures += c.textures
      s.programs += c.programs
    }
    if (!n) return this.counts
    return {
      calls: s.calls / n, triangles: s.triangles / n, lines: s.lines / n, points: s.points / n,
      geometries: s.geometries / n, textures: s.textures / n, programs: s.programs / n,
    }
  }

  /** Frame times in the window, oldest first — for a sparkline. */
  window(): number[] {
    if (this.filled < this.capacity) return this.ms.slice(0, this.filled)
    return [...this.ms.slice(this.at), ...this.ms.slice(0, this.at)]
  }

  get lastMs(): number {
    return this.last
  }

  reset(): void {
    this.ms.fill(0)
    this.cpu.fill(0)
    this.countsSamples.fill(undefined)
    this.at = 0
    this.filled = 0
    this.countsFilled = 0
    this.longTasks = 0
    this.lastLongMs = 0
  }

  /** Everything, now. */
  read(): PerfReading {
    const win = this.window()
    const heap = readHeap()
    const cpu = this.filled
      ? (this.filled < this.capacity ? this.cpu.slice(0, this.filled) : this.cpu).reduce((a, b) => a + b, 0) / this.filled
      : 0
    return {
      ...summarize(win),
      counts: this.avgCounts(),
      heapMB: heap.usedMB,
      heapLimitMB: heap.limitMB,
      longTasks: this.longTasks,
      lastLongMs: this.lastLongMs,
      cpuMs: cpu,
    }
  }
}

/** Chrome's heap numbers, or nulls. Never throws: `performance.memory` is not standard. */
export function readHeap(): { usedMB: number | null; limitMB: number | null } {
  try {
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory
    if (!m) return { usedMB: null, limitMB: null }
    return { usedMB: m.usedJSHeapSize / 1048576, limitMB: m.jsHeapSizeLimit / 1048576 }
  } catch {
    return { usedMB: null, limitMB: null }
  }
}

/** 12_345_678 → "12.3M". For counters that are read at a glance rather than compared. */
export function short(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(Math.round(n))
}

/**
 * The lines a panel shows, already written.
 *
 * Here rather than in the HUD so that a probe can assert what the screen says without parsing the
 * DOM, and so that the same reading can go to a console, a log or a report.
 */
export function perfLines(r: PerfReading): string[] {
  const out = [
    `${r.fps.toFixed(0)} fps · avg ${r.mean.toFixed(1)} · p50 ${r.p50.toFixed(1)} · cpu ${r.cpuMs.toFixed(1)} ms`,
    `p95 ${r.p95.toFixed(1)} · p99 ${r.p99.toFixed(1)} · worst ${r.max.toFixed(0)} ms`,
    `${short(r.counts.calls)} draws · ${short(r.counts.triangles)} tris · ${short(r.counts.geometries)} geom · ${short(r.counts.textures)} tex · ${short(r.counts.programs)} prog`,
  ]
  if (r.heapMB != null) out.push(`heap ${r.heapMB.toFixed(0)} MB${r.heapLimitMB ? ` of ${r.heapLimitMB.toFixed(0)}` : ''}`)
  // only when there is something to say: a line reading "0 stalls" every frame is a line you stop reading
  if (r.stalls) out.push(`${r.stalls} stalls · ${r.stallMs.toFixed(0)} ms lost · last ${r.lastLongMs.toFixed(0)} ms`)
  return out
}

/**
 * Green, amber or red for a frame time.
 *
 * Against 60 fps and 30 fps rather than against the average, because the question a colour answers
 * is "is this all right", and that has an absolute answer.
 */
export function frameColour(ms: number): string {
  if (ms <= BUDGET_MS * 1.2) return '#3ddc84'
  if (ms <= 1000 / 30) return '#ffd400'
  return '#ff6b5e'
}
