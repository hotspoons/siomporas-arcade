// The lighting panel: the report that sits under the performance panel.
//
// Rich, 2026-10-05: *"I wanted a new panel that is shown below and includes lighting reports, not
// just a new lights testing mode."* The performance panel answers "what does the frame cost"; this
// answers "what are the LIGHTS doing" — the scene's inventory, each tunable family's mode and lamp
// count and measured cost, and a row for every `Light` object. It is a report, so it reads the
// world as it stands, on the same twice-a-second cadence as the perf panel. The one button re-runs
// the cost ablation; the result then STAYS on the panel rather than flashing past as a button
// label. `lightreport.ts` holds the formatting.
//
// IT IS PLACED UNDER THE PERFORMANCE PANEL rather than at a fixed offset, because the perf panel's
// height changes with the graph and the legend. The anchor element is handed in and its bottom
// edge is measured each draw.

import { lightDumpRows, lightLines, type LightReport } from './lightreport'
import './lightpanel.css'

export class LightPanel {
  readonly root = document.createElement('div')
  private lines = document.createElement('div')
  private dumpEl = document.createElement('div')
  private measureBtn = document.createElement('button')
  private dumpBtn = document.createElement('button')
  private timer: number | null = null
  private dumpOn = false
  private anchor: HTMLElement
  /** The report itself, filled by the game; null until the world exists. */
  report: (() => LightReport) | null = null
  /** Run the cost ablation. A button rather than continuous: see `main.ts measureLights`. */
  onMeasure: (() => void) | null = null

  constructor(anchor: HTMLElement) {
    this.anchor = anchor
    this.root.className = 'light-hud'
    this.root.hidden = true

    const head = document.createElement('div')
    head.className = 'light-head'
    head.textContent = 'lighting'
    this.dumpBtn.textContent = 'dump'
    this.dumpBtn.title = 'list every Light object in the scene: type, family, intensity, range, cone, shadow'
    this.dumpBtn.onclick = () => {
      this.dumpOn = !this.dumpOn
      this.dumpBtn.classList.toggle('on', this.dumpOn)
      this.draw()
    }
    this.measureBtn.textContent = 'measure'
    this.measureBtn.title = 'time each light family by switching it off for a few frames: the numbers stay on the panel (takes a few seconds)'
    this.measureBtn.onclick = () => this.onMeasure?.()
    const actions = document.createElement('div')
    actions.className = 'light-actions'
    actions.append(this.dumpBtn, this.measureBtn)
    head.append(actions)

    this.lines.className = 'light-lines mono'
    this.dumpEl.className = 'light-dump mono'
    this.dumpEl.hidden = true
    this.root.append(head, this.lines, this.dumpEl)
    document.body.append(this.root)
  }

  get open(): boolean {
    return !this.root.hidden
  }

  show(on: boolean): void {
    if (on === this.open) return
    this.root.hidden = !on
    if (on) {
      this.place()
      // twice a second, like the perf panel: fast enough to feel live, slow enough to read
      this.timer = window.setInterval(() => this.draw(), 500)
      this.draw()
    } else {
      if (this.timer !== null) clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Show the measure button as working (or done) while the ablation runs. */
  measureBusy(on: boolean, label = 'measure'): void {
    this.measureBtn.disabled = on
    this.measureBtn.textContent = label
    this.measureBtn.classList.toggle('on', on)
  }

  /** The text a probe or a console can read without going through the DOM. */
  text(): string[] {
    const r = this.report?.()
    return r ? lightLines(r) : []
  }

  /** Sit directly under the perf panel, whatever height it has settled to. */
  private place(): void {
    const bottom = this.anchor.getBoundingClientRect().bottom
    this.root.style.top = `${Math.round(bottom + 8)}px`
  }

  private draw(): void {
    if (!this.open) return
    this.place()
    const r = this.report?.()
    if (!r) {
      this.lines.replaceChildren()
      this.dumpEl.replaceChildren()
      return
    }
    this.lines.replaceChildren(...lightLines(r).map((t) => {
      const d = document.createElement('div')
      d.textContent = t
      return d
    }))
    this.dumpEl.hidden = !this.dumpOn
    if (this.dumpOn) {
      const rows = lightDumpRows(r)
      this.dumpEl.replaceChildren(...rows.map((t) => {
        const d = document.createElement('div')
        d.textContent = t
        return d
      }))
    }
  }

  dispose(): void {
    this.show(false)
    this.root.remove()
  }
}
