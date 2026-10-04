// The performance panel: what the last ten seconds of frames actually did.
//
// Rich, 2026-09-29: *"Can we add a setting to show a performance stats display that includes FPS,
// memory, p95/p99 info, cpu time, etc.? trailworks would be a good example for how we want to show
// something like this."*
//
// `perf.ts` does the measuring and this draws it. Two rules from trailworks' panel, both learned the
// hard way there:
//
//   IT REDRAWS TWICE A SECOND, NOT EVERY FRAME. A panel that rebuilds its own DOM at 60 Hz is a
//   panel that changes the number it is reporting. The meter records every frame; the text catches
//   up on a timer.
//
//   THE GRAPH IS THE POINT. Six numbers tell you the state; a strip of the last few hundred frames
//   tells you the SHAPE — whether 40 fps is a steady 40 or a 60 with a hitch in it, which are
//   different bugs. One bar per frame, coloured against 60 and 30 fps.
//
// It is a plain absolutely-positioned panel rather than a dialog: you read it while you are flying,
// and a modal you have to close to see the world is no use for that.

import { frameColour, perfLines, type PerfMeter } from '../game/session/perf'
import './perfhud.css'

const GRAPH_W = 220
const GRAPH_H = 34
/** the tallest frame the graph plots; past this the bar is simply full height */
const GRAPH_MAX_MS = 50

export class PerfHud {
  readonly root = document.createElement('div')
  private lines = document.createElement('div')
  private canvas = document.createElement('canvas')
  private legendEl = document.createElement('div')
  private meter: PerfMeter
  private timer: number | null = null
  private shownAt = 0
  private tilesOn = false
  /**
   * Extra lines from the world, drawn under the frame numbers. The pyramid uses this to say which
   * tile the eye is on and how many leaf tiles are in view — the meter itself does not know that.
   */
  detail: (() => string[]) | null = null
  /** Swatches for the tile tint. Empty when the world has no pyramid. */
  tilesLegend: (() => { color: string; text: string }[]) | null = null
  /** Turn the tint on the terrain itself. The panel only draws the legend. */
  onTiles: ((on: boolean) => void) | null = null
  /**
   * Run the light-budget ablation: each real light family is briefly switched off and the frame
   * timed, so the panel can say what the hero lamps, the traffic and the fake flood actually cost.
   * It is a button rather than something continuous because switching a light off changes the
   * light count and recompiles every standard material — doing that every frame would cost far more
   * than it measures. Empty text means the world has no lights to measure.
   */
  onMeasureLights: (() => void) | null = null
  private lightsBtn: HTMLButtonElement | null = null

  constructor(meter: PerfMeter) {
    this.meter = meter
    this.root.className = 'perf-hud'
    this.root.hidden = true

    const head = document.createElement('div')
    head.className = 'perf-head'
    head.textContent = 'performance'
    const reset = document.createElement('button')
    reset.textContent = 'reset'
    reset.title = 'start the window again — after a load, or before a run you want to measure'
    reset.onclick = () => {
      this.meter.reset()
      this.shownAt = performance.now()
      this.draw()
    }
    const tiles = document.createElement('button')
    tiles.textContent = 'tiles'
    tiles.title = 'tint each pyramid level and show which colour is which'
    tiles.onclick = () => {
      this.tilesOn = !this.tilesOn
      tiles.classList.toggle('on', this.tilesOn)
      this.onTiles?.(this.tilesOn)
      this.draw()
    }
    const actions = document.createElement('div')
    actions.className = 'perf-actions'
    const lights = document.createElement('button')
    lights.textContent = 'lights'
    lights.title = 'measure what each light family costs: it switches each off for a few frames and times them (takes a few seconds)'
    lights.onclick = () => this.onMeasureLights?.()
    this.lightsBtn = lights
    actions.append(tiles, lights, reset)
    head.append(actions)

    this.lines.className = 'perf-lines mono'
    this.canvas.width = GRAPH_W * devicePixelRatio
    this.canvas.height = GRAPH_H * devicePixelRatio
    this.canvas.className = 'perf-graph'
    this.canvas.title = 'one bar per frame, oldest on the left — green is inside 60 fps, amber inside 30'

    this.legendEl.className = 'perf-legend'
    this.legendEl.hidden = true
    this.root.append(head, this.lines, this.canvas, this.legendEl)
    document.body.append(this.root)
  }

  get open(): boolean {
    return !this.root.hidden
  }

  show(on: boolean): void {
    if (on === this.open) return
    this.root.hidden = !on
    if (on) {
      this.shownAt = performance.now()
      this.meter.watchLongTasks()
      // TWICE A SECOND. Fast enough to feel live, slow enough that the number holds still long
      // enough to read — trailworks settled on the same 500 ms.
      this.timer = window.setInterval(() => this.draw(), 500)
      this.draw()
    } else {
      if (this.timer !== null) clearInterval(this.timer)
      this.timer = null
      this.meter.stopWatching()
      if (this.tilesOn) {
        this.tilesOn = false
        this.root.querySelector('.perf-actions button')?.classList.remove('on')
        this.onTiles?.(false)
      }
    }
  }

  toggle(): boolean {
    this.show(!this.open)
    return this.open
  }

  /** Show the lights button as working (or done) while the ablation runs. */
  lightsBusy(on: boolean, label = 'lights'): void {
    if (!this.lightsBtn) return
    this.lightsBtn.disabled = on
    this.lightsBtn.textContent = label
    this.lightsBtn.classList.toggle('on', on)
  }

  /** The text a probe or a console can read without going through the DOM. */
  text(): string[] {
    return perfLines(this.meter.read())
  }

  private draw(): void {
    if (!this.open) return
    const r = this.meter.read()
    const rows = perfLines(r)
    for (const t of this.detail?.() ?? []) if (t) rows.push(t)
    const secs = (performance.now() - this.shownAt) / 1000
    rows.push(`window ${r.frames} frames · ${secs.toFixed(0)} s open`)
    // rebuilt as text rather than as elements: five short lines, and a diff is not worth the code
    this.lines.replaceChildren(...rows.map((t) => {
      const d = document.createElement('div')
      d.textContent = t
      return d
    }))
    this.plot(this.meter.window())
    this.drawLegend()
  }

  /** The level swatches. Hidden until the tiles button is on, which is also when the ground is tinted. */
  private drawLegend() {
    this.legendEl.hidden = !this.tilesOn
    if (!this.tilesOn) {
      this.legendEl.replaceChildren()
      return
    }
    const rows = this.tilesLegend?.() ?? []
    this.legendEl.replaceChildren(...rows.map((row) => {
      const d = document.createElement('div')
      const swatch = document.createElement('i')
      swatch.style.background = row.color
      d.append(swatch, document.createTextNode(row.text))
      return d
    }))
  }

  /**
   * One bar per frame, oldest at the left.
   *
   * A CANVAS RATHER THAN DIVS. trailworks does this with flex children, which is fine for its forty
   * two-second bins; this plots the last six hundred FRAMES, and six hundred elements re-laid out
   * twice a second is a performance panel with a performance problem.
   */
  private plot(ms: number[]): void {
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return
    const w = this.canvas.width
    const h = this.canvas.height
    ctx.clearRect(0, 0, w, h)
    if (!ms.length) return
    const bar = Math.max(1, w / ms.length)
    for (let i = 0; i < ms.length; i++) {
      const v = Math.min(ms[i], GRAPH_MAX_MS)
      const tall = Math.max(1, (v / GRAPH_MAX_MS) * h)
      ctx.fillStyle = frameColour(ms[i])
      ctx.fillRect(i * bar, h - tall, Math.max(1, bar - 0.5), tall)
    }
    // the 60 fps line, so the bars have something to be short of
    const y = h - (1000 / 60 / GRAPH_MAX_MS) * h
    ctx.fillStyle = 'rgba(255,255,255,0.25)'
    ctx.fillRect(0, y, w, Math.max(1, devicePixelRatio))
  }

  dispose(): void {
    this.show(false)
    this.root.remove()
  }
}
