// Fixed-timestep simulation, decoupled presentation. The sim runs at SIM_HZ
// regardless of frame rate or visual mode; the renderer interpolates between
// the last two sim snapshots by the accumulator's leftover alpha. Retro mode
// presents on a fixed cadence by skipping renders, never by throttling ticks.

import { MAX_SUBSTEPS, SIM_DT } from '../sim/Tuning'

export interface LoopClient {
  /** Called once per frame before ticking; returns the presentation time scale (slow-mo). */
  beginFrame(frameDt: number): number
  /** Advance the sim exactly one fixed step. */
  simTick(dt: number): void
  /** Draw with interpolation alpha in [0,1). `frameDt` is real seconds since last render. */
  render(alpha: number, frameDt: number): void
}

export class LoopStats {
  frameMs = 0
  simTicks = 0
  simMs = 0
  renderMs = 0
  fps = 0
  presentFps = 0
  private frames = 0
  private presents = 0
  private acc = 0
  /** Rolling frame-time history for the perf graph. */
  readonly history = new Float32Array(120)
  historyHead = 0

  push(frameMs: number, wallMs: number, presented: boolean): void {
    this.frameMs = frameMs
    this.history[this.historyHead] = wallMs
    this.historyHead = (this.historyHead + 1) % this.history.length
    this.frames++
    if (presented) this.presents++
    this.acc += wallMs
    if (this.acc >= 500) {
      this.fps = (this.frames * 1000) / this.acc
      this.presentFps = (this.presents * 1000) / this.acc
      this.frames = 0
      this.presents = 0
      this.acc = 0
    }
  }
}

export class GameLoop {
  readonly stats = new LoopStats()
  /** 0 = present every frame; otherwise minimum ms between presents. */
  presentIntervalMs = 0
  paused = false
  private accumulator = 0
  private lastTime = -1
  private lastPresent = -1
  private lastRenderTime = -1
  private heldAlpha = 0
  private rafId = 0
  private running = false
  private readonly client: LoopClient
  private readonly renderer: { setAnimationLoop(fn: ((t: number) => void) | null): void } | null

  constructor(client: LoopClient, xrRenderer: { setAnimationLoop(fn: ((t: number) => void) | null): void } | null) {
    this.client = client
    this.renderer = xrRenderer
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.lastTime = -1
    // three's setAnimationLoop routes through the XR session's frame loop
    // when one is active, and rAF otherwise.
    if (this.renderer) this.renderer.setAnimationLoop(this.frame)
    else this.rafId = requestAnimationFrame(this.frame)
  }

  stop(): void {
    this.running = false
    if (this.renderer) this.renderer.setAnimationLoop(null)
    else cancelAnimationFrame(this.rafId)
  }

  private readonly frame = (now: number): void => {
    if (!this.running) return
    if (!this.renderer) this.rafId = requestAnimationFrame(this.frame)
    const t0 = performance.now()
    if (this.lastTime < 0) this.lastTime = now
    let frameDt = (now - this.lastTime) / 1000
    this.lastTime = now
    // Tab restore: don't try to catch up more than a handful of ticks.
    if (frameDt > MAX_SUBSTEPS * SIM_DT) frameDt = MAX_SUBSTEPS * SIM_DT
    if (frameDt < 0) frameDt = 0

    const scale = this.client.beginFrame(frameDt)
    let ticks = 0
    if (!this.paused) {
      this.accumulator += frameDt * scale
      const simStart = performance.now()
      while (this.accumulator >= SIM_DT && ticks < MAX_SUBSTEPS) {
        this.client.simTick(SIM_DT)
        this.accumulator -= SIM_DT
        ticks++
      }
      if (this.accumulator >= SIM_DT) this.accumulator = SIM_DT * 0.999 // dropped ticks, avoid spiral
      this.stats.simMs = performance.now() - simStart
    }
    this.stats.simTicks = ticks

    const alpha = this.accumulator / SIM_DT
    let presented = false
    const interval = this.presentIntervalMs
    if (interval <= 0 || this.lastPresent < 0 || now - this.lastPresent >= interval - 0.5) {
      this.lastPresent = interval <= 0 ? now : this.lastPresent < 0 ? now : this.lastPresent + interval * Math.floor((now - this.lastPresent) / interval)
      this.heldAlpha = alpha
      const r0 = performance.now()
      const renderDt = this.lastRenderTime < 0 ? frameDt : (now - this.lastRenderTime) / 1000
      this.lastRenderTime = now
      this.client.render(this.heldAlpha, renderDt)
      this.stats.renderMs = performance.now() - r0
      presented = true
    }
    this.stats.push(performance.now() - t0, frameDt * 1000, presented)
  }
}
