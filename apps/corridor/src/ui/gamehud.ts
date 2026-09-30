// The game's widget in the lower-left corner: the objective, the last few things the game said,
// the waypoint arrow, and a stylised readout of what the car is doing.
//
// Rich, 2026-09-30: game mode hides the status listing in the bar and "instead adds to the widget
// in the lower left corner for objective findings and include a nicer stylized version of the
// speed, heading, road, elevation, and maybe the gear and engine speed too when driving."
//
// The bar's readout was a line of text for a developer reading numbers; this is a dashboard for a
// player glancing at it. The speed is big and the unit is small; the gear sits beside a rev bar
// that turns red at the redline; the heading is a compass point with the degrees under it; the
// road name is the line you would read off a sign. Every value is written only when it changes,
// because this runs every frame and a DOM write a frame per field is a layout a frame.
//
// It has no idea what a race or a program is: `main.ts` hands it an objective and a telemetry
// record and it draws them. `HudPart` from gamepolicy.ts is what a program switches off.
import type { HudPart } from '../gamepolicy'
import type { ObjectiveItem } from '../program'
import { el } from './shell'

export interface Telemetry {
  /** m/s along the nose (sign is direction) */
  speed: number
  units: 'mph' | 'kmh'
  /** 1-based gear, 0 = neutral; null when there is no gearbox (a craft, on foot) */
  gear: number | null
  rpm: number | null
  redline: number | null
  /** true bearing, degrees, 0 = north */
  heading: number | null
  road: string | null
  /** metres above the datum */
  elevation: number | null
  /** 'grass', 'sliding', 'stalled', 'on the ground' — the little tags */
  tags: string[]
  /** what is being driven or flown: 'helicopter', 'on foot'; null for the car */
  craft: string | null
}

export interface Objective {
  goal: string
  score: number
  outcome: 'win' | 'lose' | 'abandoned' | null
  /** a race in progress: its line */
  race?: string | null
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']

export class GameHud {
  readonly root = el('div', 'gamehud')
  /** where the waypoint arrow docks (`WaypointHud.dock`) */
  readonly waypointSlot = el('div', 'gh-waypoint')
  private objective = el('div', 'gh-objective')
  private goal = el('div', 'gh-goal')
  private score = el('div', 'gh-score mono')
  private outcome = el('div', 'gh-outcome')
  private race = el('div', 'gh-race')
  /** the objective list: one row each, the selected one marked, the done ones struck */
  private list = el('div', 'gh-list')
  private lastList = ''
  private notes = el('div', 'gh-notes')
  private telemetry = el('div', 'gh-telemetry')
  private speedEl = el('div', 'gh-speed')
  private speedNum = el('span', 'gh-speed-num mono', '0')
  private speedUnit = el('span', 'gh-speed-unit', 'mph')
  private gearEl = el('div', 'gh-gear')
  private gearNum = el('span', 'gh-gear-num mono', 'N')
  private revBar = el('div', 'gh-rev')
  private revFill = el('div', 'gh-rev-fill')
  private headingEl = el('div', 'gh-heading')
  private headingPt = el('span', 'gh-heading-pt', '—')
  private headingDeg = el('span', 'gh-heading-deg mono', '')
  private roadEl = el('div', 'gh-road', '')
  private elevEl = el('div', 'gh-elev mono', '')
  private tagsEl = el('div', 'gh-tags')
  private craftEl = el('div', 'gh-craft', '')
  private parts: Record<HudPart, boolean> = { speed: true, gear: true, heading: true, road: true, elevation: true, objectives: true, waypoint: true }
  private last: Record<string, string> = {}
  private noteTimers: number[] = []
  private watching: HTMLElement | null = null
  /** nothing to show: `setObjective(null)` every frame must not touch the DOM every frame */
  private blank = true

  constructor() {
    this.objective.append(this.outcome, this.goal, this.race, this.list, this.score, this.notes)
    this.list.hidden = true
    this.speedEl.append(this.speedNum, this.speedUnit)
    this.revBar.append(this.revFill)
    this.gearEl.append(this.gearNum, this.revBar)
    this.headingEl.append(this.headingPt, this.headingDeg)
    this.telemetry.append(this.craftEl, this.speedEl, this.gearEl, this.headingEl, this.roadEl, this.elevEl, this.tagsEl)
    this.root.append(this.objective, this.waypointSlot, this.telemetry)
    this.root.hidden = true
    this.objective.hidden = true
    this.telemetry.hidden = true
  }

  show(on: boolean): void {
    this.root.hidden = !on
    if (on) this.dodge()
  }

  get visible(): boolean {
    return !this.root.hidden
  }

  /** which pieces a program has left on */
  setParts(parts: Record<HudPart, boolean>): void {
    this.parts = { ...parts }
    this.speedEl.hidden = !parts.speed
    this.gearEl.hidden = !parts.gear
    this.headingEl.hidden = !parts.heading
    this.roadEl.hidden = !parts.road
    this.elevEl.hidden = !parts.elevation
    this.waypointSlot.hidden = !parts.waypoint
    if (!parts.objectives) this.objective.hidden = true
    else if (this.last.goal || this.last.score || this.notes.childElementCount || !this.list.hidden) this.objective.hidden = false
  }

  /**
   * The objective list (program.ts `api.objectives`). Redrawn only when a row's text, its done
   * mark or the selection changed — the program refreshes the details every second.
   */
  setObjectives(items: ObjectiveItem[], selected: string | null): void {
    const key = items.map((o) => `${o.id}\u0001${o.title}\u0001${o.detail ?? ''}\u0001${o.done ? 1 : 0}\u0001${o.id === selected ? 1 : 0}`).join('\n')
    if (key === this.lastList) return
    this.lastList = key
    this.list.replaceChildren(...items.map((o) => {
      const row = el('div', `gh-item${o.id === selected ? ' sel' : ''}${o.done ? ' done' : ''}`)
      row.append(el('span', 'gh-item-title', o.title))
      if (o.detail) row.append(el('span', 'gh-item-detail', o.detail))
      return row
    }))
    this.list.hidden = !items.length
    if (items.length && this.parts.objectives) this.objective.hidden = false
    else if (!items.length && !this.last.goal && !this.last.score && this.notes.childElementCount === 0) this.objective.hidden = true
    this.dodge()
  }

  private write(key: string, node: HTMLElement, text: string): void {
    if (this.last[key] === text) return
    this.last[key] = text
    node.textContent = text
  }

  /** the readout; null when there is nothing to read (the free camera) */
  setTelemetry(t: Telemetry | null): void {
    if (!t) {
      if (!this.telemetry.hidden) this.telemetry.hidden = true
      return
    }
    if (this.telemetry.hidden) this.telemetry.hidden = false
    const v = Math.abs(t.speed) * (t.units === 'kmh' ? 3.6 : 2.237)
    this.write('speed', this.speedNum, String(Math.round(v)))
    this.write('unit', this.speedUnit, t.units === 'kmh' ? 'km/h' : 'mph')
    this.write('craft', this.craftEl, t.craft ?? '')
    this.craftEl.hidden = !t.craft
    if (t.gear === null) {
      this.gearEl.hidden = true
    } else {
      this.gearEl.hidden = !this.parts.gear
      this.write('gear', this.gearNum, t.speed < -0.3 ? 'R' : t.gear > 0 ? String(t.gear) : 'N')
      const rl = t.redline && t.redline > 0 ? t.redline : 1
      const f = Math.max(0, Math.min(1, (t.rpm ?? 0) / rl))
      const pct = `${Math.round(f * 100)}%`
      if (this.last.rev !== pct) {
        this.last.rev = pct
        this.revFill.style.width = pct
        this.revFill.classList.toggle('hot', f > 0.9)
      }
    }
    if (t.heading === null) {
      this.headingEl.hidden = true
    } else {
      this.headingEl.hidden = !this.parts.heading
      const brg = ((t.heading % 360) + 360) % 360
      this.write('pt', this.headingPt, COMPASS[Math.round(brg / 22.5) % 16])
      this.write('deg', this.headingDeg, `${String(Math.round(brg)).padStart(3, '0')}°`)
    }
    this.write('road', this.roadEl, t.road ?? '')
    if (t.elevation === null) this.write('elev', this.elevEl, '')
    else this.write('elev', this.elevEl, t.units === 'kmh' ? `${Math.round(t.elevation)} m` : `${Math.round(t.elevation * 3.28084)} ft`)
    const tags = t.tags.join('|')
    if (this.last.tags !== tags) {
      this.last.tags = tags
      this.tagsEl.replaceChildren(...t.tags.map((s) => el('span', 'gh-tag', s)))
    }
  }

  /** the goal and the score; null clears the block */
  setObjective(o: Objective | null): void {
    if (!o) {
      if (this.blank) return
      this.blank = true
      this.last.goal = this.last.score = this.last.race = this.last.outcome = ''
      this.goal.textContent = this.score.textContent = this.outcome.textContent = this.race.textContent = ''
      this.outcome.className = 'gh-outcome'
      this.objective.hidden = this.notes.childElementCount === 0 && this.list.hidden
      return
    }
    this.blank = false
    this.write('goal', this.goal, o.goal)
    this.write('score', this.score, o.score ? `${o.score.toLocaleString()} pts` : '')
    this.write('race', this.race, o.race ?? '')
    const oc = o.outcome ? (o.outcome === 'win' ? 'WIN' : o.outcome === 'lose' ? 'LOSE' : 'ABANDONED') : ''
    if (this.last.outcome !== oc) {
      this.last.outcome = oc
      this.outcome.textContent = oc
      this.outcome.className = `gh-outcome${o.outcome ? ` ${o.outcome}` : ''}`
    }
    this.objective.hidden = !this.parts.objectives
    this.dodge()
  }

  /** something the game said: kept for a while under the goal, newest at the bottom */
  note(text: string, kind: 'info' | 'ok' | 'warn' = 'info', ms = 9000): void {
    const row = el('div', `gh-note ${kind}`, text)
    this.notes.append(row)
    while (this.notes.childElementCount > 4) this.notes.firstElementChild?.remove()
    if (this.parts.objectives) this.objective.hidden = false
    const t = window.setTimeout(() => {
      row.classList.add('fade')
      window.setTimeout(() => {
        row.remove()
        if (!this.last.goal && !this.last.score && this.notes.childElementCount === 0 && this.list.hidden) this.objective.hidden = true
      }, 600)
    }, ms)
    this.noteTimers.push(t)
    this.dodge()
  }

  /** Sit above the attribution block while its list is open; otherwise a hand off the corner. */
  private dodge(): void {
    const attrib = document.getElementById('attribution')
    const list = attrib?.querySelector('.attrib-list') as HTMLElement | null
    if (list && this.watching !== list) {
      this.watching = list
      new MutationObserver(() => this.dodge()).observe(list, { attributes: true, attributeFilter: ['hidden'] })
    }
    const open = !!attrib && !!list && !list.hidden
    const clear = open ? Math.max(0, window.innerHeight - attrib!.getBoundingClientRect().top) + 8 : 0
    const bottom = `${Math.max(34, clear)}px`
    if (this.root.style.bottom !== bottom) this.root.style.bottom = bottom
  }
}
