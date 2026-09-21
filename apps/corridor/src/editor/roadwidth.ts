// Road width preview: change the cross-section and SEE where the pavement edges would go, over the
// road that is actually there, before committing to a rebuild.
//
// The knobs (LANE_WIDTH, SHOULDER_OUT, SHOULDER_IN, ROAD_ONEWAY_CENTRE) are the viewer's own, and
// `scene.ts` rebuilds the road and the strip 250 ms after any of them changes. That rebuild is
// seconds of work on a 6 km site, so dragging a slider with it wired live is unusable. Instead the
// sliders here move only a pair of line outlines — cheap, instant, and drawn from `stations()` and
// `pavedWidth()`, the very functions the asphalt is built from, so what you see is where the
// asphalt will land. `apply` writes the values into the tuning module and triggers the one rebuild.
//
// Self-mounting: the editor's `refresh()` rewrites `#body` whenever the panel's shape changes, so a
// row appended there would vanish on the next selection. This owns a floating panel of its own,
// created on first `mount()` and toggled from its own button, and touches nothing else in the
// editor's DOM.
import * as THREE from 'three'
import { pavedOffset, pavedWidth, stations, taperedLanes, type Station } from '../props'
import type { Site } from '../scene'
import * as T from '../tuning'
import { el, slider } from './ui'

/**
 * The knobs, reached through `TUNE_TABS` rather than through new setters: those entries already
 * carry the getter and setter the F6 panel uses, so there is exactly one way to write a tunable and
 * no second copy to drift.
 */
interface Knob {
  name: string
  get: () => number
  set: (v: number) => void
  min: number
  max: number
  step: number
  note: string
}

const TUNE_KEYS = T.TUNE_TABS.flatMap((tab) => tab.sections.flatMap((sec) => sec.keys))
const knob = (name: string, min: number, max: number, step: number, note: string): Knob | null => {
  const k = TUNE_KEYS.find((q) => q.name === name)
  return k ? { name, get: k.get, set: k.set, min, max, step, note } : null
}

const KNOBS: Knob[] = [
  knob('LANE_WIDTH', 2.4, 5, 0.02, 'one lane, metres'),
  knob('SHOULDER_OUT', 0, 6, 0.05, 'outside shoulder, metres'),
  knob('SHOULDER_IN', 0, 6, 0.05, 'median shoulder, metres'),
  knob('ROAD_ONEWAY_CENTRE', 0, 1, 1, '0 = lanes on the spine, 1 = asphalt on the spine'),
].filter((k): k is Knob => k !== null)

export class RoadWidth {
  private panel: HTMLElement | null = null
  private group = new THREE.Group()
  private site: Site | null = null
  private st: Station[] = []
  private lanesAt: (s: number) => number = () => 2
  private twoWayAt: (s: number) => boolean = () => false
  /** proposed values, live while dragging; only `apply` pushes them into tuning.ts */
  private want = new Map<string, number>()

  private readonly scene: THREE.Scene

  constructor(scene: THREE.Scene) {
    this.scene = scene
    this.group.name = 'roadwidth-preview'
    this.group.visible = false
    this.scene.add(this.group)
  }

  /** Called whenever a site finishes loading. */
  setSite(site: Site | null) {
    this.site = site
    this.st = []
    if (!site) {
      this.group.clear()
      return
    }
    const segs = site.manifest.spine.segments
    const segAt = (s: number) => segs.find((g) => g.s_start - 0.5 <= s && s <= g.s_end + 0.5)
    const stepLanes = (s: number) => {
      const n = Number(segAt(s)?.tags.lanes)
      return Number.isFinite(n) && n > 0 ? n : 2
    }
    this.lanesAt = taperedLanes(stepLanes, site.manifest.spine.length_m, T.ROAD_TAPER_M)
    this.twoWayAt = (s: number) => {
      const tg = segAt(s)?.tags ?? {}
      if (tg.oneway === 'yes' || tg.oneway === '-1') return false
      if (tg.oneway === 'no') return true
      return !['motorway', 'motorway_link', 'trunk_link', 'primary_link'].includes(tg.highway ?? '')
    }
    // every 6 m, the same spacing roadMesh uses, so the outline and the asphalt agree station for station
    this.st = stations(site.spineAt, site.manifest.spine.length_m, 6)
    for (const k of KNOBS) this.want.set(k.name, k.get())
    this.redraw()
  }

  /** The two proposed pavement edges, as line geometry lifted clear of the asphalt. */
  private redraw() {
    this.group.clear()
    if (!this.st.length) return
    const left: number[] = []
    const right: number[] = []
    const lane = this.want.get('LANE_WIDTH') ?? T.LANE_WIDTH
    const out = this.want.get('SHOULDER_OUT') ?? T.SHOULDER_OUT
    const inn = this.want.get('SHOULDER_IN') ?? T.SHOULDER_IN
    const centre = this.want.get('ROAD_ONEWAY_CENTRE') ?? T.ROAD_ONEWAY_CENTRE
    const UP = new THREE.Vector3(0, 1, 0)
    for (const s of this.st) {
      const twoWay = this.twoWayAt(s.s)
      const lanes = this.lanesAt(s.s)
      // the same arithmetic as pavedWidth/pavedOffset, but on the PROPOSED numbers
      const w = lanes * lane + out + (twoWay ? out : inn)
      const off = twoWay || centre >= 0.5 ? 0 : (out - inn) / 2
      const side = s.dir.clone().cross(UP)
      const y = s.pos.y + 0.12
      left.push(s.pos.x + side.x * (off - w / 2), y, s.pos.z + side.z * (off - w / 2))
      right.push(s.pos.x + side.x * (off + w / 2), y, s.pos.z + side.z * (off + w / 2))
    }
    for (const [pts, colour] of [[left, 0x35e0ff], [right, 0xffd23f]] as [number[], number][]) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: colour, depthTest: false, transparent: true, opacity: 0.95 }))
      line.renderOrder = 900
      this.group.add(line)
    }
  }

  /** Current vs proposed, in metres, for the readout. */
  private summary(): string {
    const lane = this.want.get('LANE_WIDTH') ?? T.LANE_WIDTH
    const out = this.want.get('SHOULDER_OUT') ?? T.SHOULDER_OUT
    const inn = this.want.get('SHOULDER_IN') ?? T.SHOULDER_IN
    const now2 = pavedWidth(2, true), now1 = pavedWidth(3, false)
    const new2 = 2 * lane + 2 * out, new1 = 3 * lane + out + inn
    const off = pavedOffset(false)
    return `2-lane two-way ${now2.toFixed(2)} → ${new2.toFixed(2)} m · 3-lane one-way ${now1.toFixed(2)} → ${new1.toFixed(2)} m · carriageway offset ${off.toFixed(2)} m`
  }

  private dirty(): boolean {
    return KNOBS.some((k) => Math.abs((this.want.get(k.name) ?? k.get()) - k.get()) > 1e-6)
  }

  /** Push the proposed numbers into tuning.ts and ask the site for its one rebuild. */
  private apply(onDone: () => void) {
    for (const k of KNOBS) k.set(this.want.get(k.name) ?? k.get())
    this.site?.retune()
    onDone()
  }

  /** Build the floating panel once and return its toggle button for the editor's toolbar. */
  mount(host: HTMLElement): HTMLButtonElement {
    const btn = el('button', '', 'road (5)') as HTMLButtonElement
    const panel = el('div', 'roadwidth hidden')
    const body = el('div', 'roadwidth-body')
    const note = el('div', 'roadwidth-note mono')
    const redraw = () => {
      note.textContent = this.summary()
      applyBtn.disabled = !this.dirty()
      applyBtn.textContent = this.dirty() ? 'apply •' : 'apply'
      this.redraw()
    }
    const applyBtn = el('button', 'roadwidth-apply', 'apply') as HTMLButtonElement
    applyBtn.onclick = () => this.apply(redraw)
    panel.append(el('div', 'roadwidth-title', 'road cross-section'), body, note, applyBtn)
    for (const k of KNOBS) {
      body.append(
        slider(k.name, k.get(), k.min, k.max, k.step, k.get(), k.note, (v) => {
          this.want.set(k.name, v)
          redraw()
        }),
      )
    }
    btn.onclick = () => {
      const on = panel.classList.toggle('hidden')
      this.group.visible = !on
      btn.classList.toggle('on', !on)
      if (!on) redraw()
    }
    document.body.append(panel)
    host.append(btn)
    this.panel = panel
    return btn
  }

  /** Shown only while the panel is open, so it never clutters the other modes. */
  get visible(): boolean {
    return !!this.panel && !this.panel.classList.contains('hidden')
  }
}
