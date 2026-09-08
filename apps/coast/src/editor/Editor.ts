// The world builder: a plan-view track editor and a set view for wiring tracks
// into a route.
//
// Two modes share one canvas.
//
//   SET    Every track in the world as a box. Drag a box to arrange it, drag
//          from its exit port onto another box to link them (two links out of
//          one box is a fork — left then right). Branches can rejoin: point
//          both halves of a fork at the same track and you have Turbo OutRun's
//          shape, several ways round converging on one last stage.
//
//   TRACK  One track's centreline in real metres. Drop waypoints, drag them
//          about, and drag their handles to set the curvature between them, the
//          way you would in a vector editor. Under the canvas: a profile strip
//          for the hills, and a timeline strip carrying the scenes, the vibes,
//          the macro elements and everything you have placed by hand.
//
// Conventions (⌘ on a Mac, Ctrl elsewhere):
//   click            select / use the primed tool   drag       move it
//   double-click     insert a waypoint on the road  ⌥ click    delete under the pointer
//   ⇧ click a node   smooth ↔ cusp                  B          bank on / off
//   Q / E            lower / raise the waypoint     Delete     delete the selection
//   wheel            zoom under the pointer         middle / space drag   pan
//   T                test drive                     Esc        back to the menu

import { ROAD_HALF_WIDTH, SEG_LENGTH } from '../sim/Tuning'
import { PALETTES } from '../render/RenderTuning'
import { builtinAsWorld } from '../world/builtin'
import { compileTrack, curveToRadius, EASY_RADIUS, MAX_CURVE, MIN_RADIUS, radiusToCurve, type TrackReport } from '../world/compile'
import { buildPath, handleIn, handleOut, MAX_GRADE, NODE_GRADE, STEEP_GRADE, TrackPath, type PathSample } from '../world/path'
import { PROP_GROUPS, PROP_INFO, sceneDef, sceneGroups } from '../world/scenes'
import { VIBES, VIBE_FADE, vibeDef, type VibeDef } from '../world/vibes'
import { checkWorld, emptyTrack, reachable, routeLengthOf, type CoastTrack, type SpanKind, type WorldData } from '../world/types'
import type { WorldStore } from '../world/WorldStore'

export interface EditorCallbacks {
  /** Drive the world as it stands, starting on `trackId`. */
  onTest(world: WorldData, trackId: string): void
  onExit(): void
}

type Mode = 'set' | 'track'

type Tool =
  | { kind: 'select' }
  | { kind: 'node' }
  | { kind: 'scene'; id: string }
  | { kind: 'vibe'; id: string }
  | { kind: 'prop'; id: string }
  | { kind: 'span'; id: SpanKind; side: -1 | 0 | 1 }
  | { kind: 'crossing' }

type Sel =
  | { kind: 'node'; i: number }
  | { kind: 'handle'; i: number; which: 'in' | 'out' }
  | { kind: 'prop'; i: number }
  | { kind: 'scene'; i: number }
  | { kind: 'vibe'; i: number }
  | { kind: 'span'; i: number }
  | { kind: 'crossing'; i: number }
  | { kind: 'track'; id: string }
  | { kind: 'link'; from: string; slot: number }
  | null

interface DialogButton {
  label: string
  value: string
  primary?: boolean
  danger?: boolean
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = IS_MAC ? '⌘' : 'Ctrl'
const UNDO_DEPTH = 60
/** Where the in-progress world is parked between keystrokes, in case the tab dies. */
const DRAFT_KEY = 'apex-coast.editor.draft.v1'
/** How long after the last edit the draft is written (ms). */
const DRAFT_DELAY = 700

interface Draft {
  v: 1
  worldId: string | null
  trackId: string
  world: WorldData
  at: number
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s} second${s === 1 ? '' : 's'} ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h} hour${h === 1 ? '' : 's'} ago` : 'a while ago'
}
const MIN_SCALE = 0.02
const MAX_SCALE = 4
/** The widest the lateral axis may be stretched against the along-road one. */
const MAX_STRETCH = 40
/** The stretches the toolbar button walks through; 0 means fit it to the track. */
const STRETCHES = [0, 1, 2, 4, 8, 16]
const STRIP_MARGIN = 14
const PROFILE_H = 96
const TIMELINE_H = 122
/** Grid pitch of the set view, in its own units. */
const SET_CELL = 220
const BOX_W = 168
const BOX_H = 66

const SPAN_TOOLS: { id: SpanKind; side: -1 | 0 | 1; name: string; colour: string; desc: string }[] = [
  { id: 'shore', side: -1, name: 'Ocean front · left', colour: '#2f86c8', desc: 'The sea comes up to the road past a sliver of beach.' },
  { id: 'shore', side: 1, name: 'Ocean front · right', colour: '#2f86c8', desc: 'The sea comes up to the road past a sliver of beach.' },
  { id: 'facades', side: -1, name: 'Buildings · left', colour: '#9aa4ae', desc: 'A continuous rank of shopfronts at the kerb.' },
  { id: 'facades', side: 1, name: 'Buildings · right', colour: '#9aa4ae', desc: 'A continuous rank of shopfronts at the kerb.' },
  { id: 'facades', side: 0, name: 'Buildings · both', colour: '#9aa4ae', desc: 'Shopfronts down both sides — a street canyon.' },
  { id: 'tunnel', side: 0, name: 'Tunnel', colour: '#2a2a34', desc: 'A bore: walls, ceiling, no sky. Dark without the headlights.' },
  { id: 'workzone', side: -1, name: 'Roadworks · left', colour: '#e8801a', desc: 'Barrier taper in, a jersey barrier along the lane line, taper out.' },
  { id: 'workzone', side: 1, name: 'Roadworks · right', colour: '#e8801a', desc: 'Barrier taper in, a jersey barrier along the lane line, taper out.' },
  { id: 'guardrail', side: 0, name: 'Extra barriers', colour: '#d0d4dc', desc: 'A line of barriers along both edges, over and above the scene.' },
  { id: 'clear', side: 0, name: 'Clear the roadside', colour: '#6a6a72', desc: 'Nothing grows here: an open view.' },
]

const SPAN_COLOUR: Record<SpanKind, string> = { shore: '#2f86c8', tunnel: '#2a2a34', workzone: '#e8801a', facades: '#9aa4ae', guardrail: '#d0d4dc', clear: '#6a6a72' }
const SPAN_NAME: Record<SpanKind, string> = { shore: 'Ocean front', tunnel: 'Tunnel', workzone: 'Roadworks', facades: 'Buildings', guardrail: 'Barriers', clear: 'Clear' }

function hex(c: number): string {
  return `#${c.toString(16).padStart(6, '0')}`
}

export class Editor {
  readonly el: HTMLElement
  private readonly plan: HTMLCanvasElement
  private readonly profile: HTMLCanvasElement
  private readonly timeline: HTMLCanvasElement
  private readonly paletteEl: HTMLElement
  private readonly statusInfo: HTMLElement
  private readonly statusHints: HTMLElement
  private readonly titleEl: HTMLElement
  private readonly crumbEl: HTMLElement
  private readonly loadSelect: HTMLSelectElement
  private readonly tip: HTMLElement
  private readonly store: WorldStore
  private readonly cb: EditorCallbacks

  private world: WorldData
  private worldId: string | null = null
  private trackId = ''
  private mode: Mode = 'set'
  private tool: Tool = { kind: 'select' }
  private sel: Sel = null
  private visible = false
  private dirty = true
  /** Fit once the canvas actually has a size: show() runs before the browser has laid it out. */
  private needFit = false
  private spaceHeld = false
  private menu: HTMLElement | null = null

  /** Plan view: world metres at the canvas centre, and pixels per metre. */
  /**
   * The plan view. `scale` is pixels per metre along the road; `stretch` multiplies that across it.
   *
   * These roads are 5 km long and wander by a couple of hundred metres, so at one scale for both axes
   * a whole stage is a hairline and there is nothing to grab. Stretching the lateral axis is the same
   * trick a road engineer's long section uses: distances along and across are honestly labelled, they
   * are just not the same. `stretchAuto` refits it whenever the view is fitted.
   */
  private view = { cx: 0, cz: 500, scale: 0.22, stretch: 1 }
  private stretchAuto = true
  /** Set view: its own units at the canvas centre, and pixels per unit. */
  private setView = { cx: 0, cy: 0, scale: 1 }
  private pan: { px: number; py: number; cx: number; cy: number } | null = null
  private drag:
    | { kind: 'node'; i: number }
    | { kind: 'handle'; i: number; which: 'in' | 'out' }
    | { kind: 'prop'; i: number }
    | { kind: 'span'; i: number; grab: 'from' | 'to' | 'both'; at: number }
    | { kind: 'stop'; which: 'scene' | 'vibe'; i: number }
    | { kind: 'newspan'; from: number; to: number }
    | { kind: 'height'; i: number; py: number; y0: number }
    | { kind: 'box'; id: string; dx: number; dy: number }
    | { kind: 'link'; from: string; px: number; py: number }
    | null = null

  private undoStack: string[] = []
  private redoStack: string[] = []
  /** Edits made since the last Save, and the debounce timer that parks them. */
  private unsaved = false
  private draftTimer = 0
  private draftOffered = false
  private pathCache: { key: string; path: TrackPath } | null = null
  private reportCache: { key: string; report: TrackReport } | null = null
  private hover = { x: 0, z: 0, s: -1, lateral: 0, near: false }
  private readonly hoverSample: PathSample = { s: 0, x: 0, z: 0, y: 0, heading: 0, bank: 0 }
  private paletteW = Number(localStorage.getItem('apex-coast.editor.paletteW') ?? 232) || 232
  private paletteCollapsed = localStorage.getItem('apex-coast.editor.paletteCollapsed') === '1'

  constructor(parent: HTMLElement, store: WorldStore, cb: EditorCallbacks) {
    this.store = store
    this.cb = cb
    this.world = { v: 1, name: 'New World', start: 't1', tracks: [emptyTrack('t1', 'Stage 1')] }
    this.trackId = this.world.tracks[0].id
    this.el = document.createElement('div')
    this.el.className = 'editor hidden'
    this.el.innerHTML = `
      <div class="toolbar">
        <span class="title" data-title>New World</span>
        <button data-act="rename-world" title="Rename this world">Rename</button>
        <button data-act="new-world">New</button>
        <select data-load><option value="">Open…</option></select>
        <button data-act="save" title="${MOD}S">Save</button>
        <button data-act="save-as">Save as…</button>
        <button data-act="delete-world" title="Delete this world">Delete</button>
        <span class="sep"></span>
        <button data-act="mode-set" data-mode-set>◫ Set</button>
        <button data-act="mode-track" data-mode-track>⌇ Track</button>
        <span class="crumb" data-crumb></span>
        <span class="sep"></span>
        <button data-act="undo" title="${MOD}Z">↶</button><button data-act="redo" title="${MOD}⇧Z">↷</button>
        <button data-act="zoom-" title="−">−</button><button data-act="fit" title="0">Fit</button><button data-act="zoom+" title="+">+</button>
        <button data-act="stretch" data-stretch title="How much the view exaggerates the road's wander. These roads are 5 km long and stray a couple of hundred metres, so at 1:1 a whole stage is a hairline.">⇔ Auto</button>
        <span class="spring"></span>
        <button data-act="smooth" title="Open out every corner the car could not hold">◡ Smooth</button>
        <button data-act="fork-builtin" title="Trace the built-in coast-to-coast route into editable waypoints">⑂ Fork built-in</button>
        <button data-act="export">Export</button>
        <label class="import">Import<input type="file" accept="application/json" hidden /></label>
        <button data-act="check" title="V">✓ Check</button>
        <button data-act="test" class="primary" title="T">▶ Test drive</button>
        <button data-act="exit" title="Esc">Menu</button>
      </div>
      <div class="body">
        <div class="palette"></div>
        <div class="palette-grip" title="Drag to resize · double-click to collapse"></div>
        <div class="stack">
          <canvas class="plan"></canvas>
          <canvas class="strip profile"></canvas>
          <canvas class="strip timeline"></canvas>
        </div>
      </div>
      <div class="status"><span class="info"></span><span class="hints"></span></div>
      <div class="editor-tip hidden"></div>
    `
    parent.appendChild(this.el)
    this.plan = this.el.querySelector('canvas.plan')!
    this.profile = this.el.querySelector('canvas.profile')!
    this.timeline = this.el.querySelector('canvas.timeline')!
    this.paletteEl = this.el.querySelector('.palette')!
    this.statusInfo = this.el.querySelector('.status .info')!
    this.statusHints = this.el.querySelector('.status .hints')!
    this.titleEl = this.el.querySelector('[data-title]')!
    this.crumbEl = this.el.querySelector('[data-crumb]')!
    this.loadSelect = this.el.querySelector('[data-load]')!
    this.tip = this.el.querySelector('.editor-tip')!
    // Canvases are sized from their layout box when they draw, and the editor only draws when something
    // changed — so a canvas measured before the layout settled (or a window resized mid-edit) stayed at
    // whatever size it was born with, stretched by CSS. Watch the box instead of hoping.
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        this.dirty = true
        if (this.visible && this.stretchAuto) this.needFit = true
      })
      ro.observe(this.plan)
      ro.observe(this.el)
    }
    window.addEventListener('resize', () => {
      this.dirty = true
    })

    this.el.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act
      if (act) void this.action(act)
    })
    this.loadSelect.addEventListener('change', () => {
      const id = this.loadSelect.value
      this.loadSelect.value = ''
      if (id) this.open(id)
    })
    const file = this.el.querySelector<HTMLInputElement>('.import input')!
    file.addEventListener('change', () => {
      const f = file.files?.[0]
      if (!f) return
      void f.text().then((txt) => {
        try {
          const d = JSON.parse(txt) as WorldData
          if (!Array.isArray(d.tracks) || !d.tracks.length) throw new Error('bad')
          this.setWorld(d, null)
          this.flash(`Imported “${d.name}”`)
        } catch {
          this.flash('Not a world file')
        }
        file.value = ''
      })
    })
    const grip = this.el.querySelector<HTMLElement>('.palette-grip')!
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      grip.setPointerCapture(e.pointerId)
      const startX = e.clientX
      const startW = this.paletteCollapsed ? 54 : this.paletteW
      const move = (ev: PointerEvent) => {
        const w = Math.max(54, Math.min(420, startW + ev.clientX - startX))
        this.paletteCollapsed = w < 110
        if (!this.paletteCollapsed) this.paletteW = Math.max(150, w)
        this.applyPalette()
      }
      const up = () => {
        grip.removeEventListener('pointermove', move)
        grip.removeEventListener('pointerup', up)
      }
      grip.addEventListener('pointermove', move)
      grip.addEventListener('pointerup', up)
    })
    grip.addEventListener('dblclick', () => {
      this.paletteCollapsed = !this.paletteCollapsed
      this.applyPalette()
    })

    this.plan.addEventListener('pointerdown', (e) => this.onPlanDown(e))
    this.plan.addEventListener('pointermove', (e) => this.onPlanMove(e))
    this.plan.addEventListener('pointerup', (e) => this.onPointerUp(e))
    this.plan.addEventListener('dblclick', (e) => this.onPlanDouble(e))
    this.plan.addEventListener('wheel', (e) => this.onWheel(e), { passive: false })
    this.plan.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      this.openMenu(e)
    })
    this.plan.addEventListener('pointerleave', () => {
      this.hover.near = false
      this.hover.s = -1
      this.hideTip()
      this.dirty = true
    })
    this.profile.addEventListener('pointerdown', (e) => this.onProfileDown(e))
    this.profile.addEventListener('pointermove', (e) => this.onStripMove(e))
    this.profile.addEventListener('pointerup', (e) => this.onPointerUp(e))
    this.timeline.addEventListener('pointerdown', (e) => this.onTimelineDown(e))
    this.timeline.addEventListener('pointermove', (e) => this.onStripMove(e))
    this.timeline.addEventListener('pointerup', (e) => this.onPointerUp(e))
    window.addEventListener('keydown', (e) => this.onKey(e))
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') this.spaceHeld = false
    })
    window.addEventListener('resize', () => (this.dirty = true))
    // A reload, a crash or a closed tab must not cost an hour: flush the draft on the way out.
    window.addEventListener('beforeunload', () => this.writeDraft())
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.writeDraft()
    })
    window.addEventListener('pointerdown', (e) => {
      if (this.menu && !this.menu.contains(e.target as Node)) this.closeMenu()
    })
    this.applyPalette()
    this.buildPalette()
  }

  // --- lifecycle ------------------------------------------------------------

  show(): void {
    this.visible = true
    this.el.classList.remove('hidden')
    this.refreshLoadList()
    this.buildPalette()
    this.fit()
    this.dirty = true
    void this.offerDraft()
  }

  hide(): void {
    this.visible = false
    this.closeMenu()
    this.el.classList.add('hidden')
    // Leaving for a test drive or the menu: park the work now, not in 700 ms.
    this.writeDraft()
  }

  get isVisible(): boolean {
    return this.visible
  }

  get current(): WorldData {
    return this.world
  }
  get currentId(): string | null {
    return this.worldId
  }
  get currentTrackId(): string {
    return this.trackId
  }

  setWorld(data: WorldData, id: string | null): void {
    this.world = structuredClone(data)
    this.worldId = id
    this.trackId = this.world.tracks.some((t) => t.id === this.world.start) ? this.world.start : (this.world.tracks[0]?.id ?? '')
    this.sel = null
    this.undoStack = []
    this.redoStack = []
    this.pathCache = null
    this.reportCache = null
    this.unsaved = false
    clearTimeout(this.draftTimer)
    this.titleEl.textContent = this.world.name
    this.mode = 'set'
    this.buildPalette()
    this.fit()
    this.dirty = true
  }

  /** Called every frame; redraws only when something changed. */
  tick(): void {
    if (!this.visible) return
    if (this.needFit) this.fit()
    if (!this.dirty) return
    this.dirty = false
    this.draw()
  }

  // --- data helpers ---------------------------------------------------------

  private get track(): CoastTrack {
    return this.world.tracks.find((t) => t.id === this.trackId) ?? this.world.tracks[0]
  }

  private path(): TrackPath {
    const t = this.track
    const key = JSON.stringify(t.nodes)
    if (this.pathCache?.key !== key) this.pathCache = { key, path: buildPath(t.nodes) }
    return this.pathCache.path
  }

  private report(): TrackReport {
    const t = this.track
    const key = JSON.stringify(t)
    if (this.reportCache?.key !== key) this.reportCache = { key, report: compileTrack(t, 1, this.path()).report }
    return this.reportCache.report
  }

  private pushUndo(): void {
    this.undoStack.push(JSON.stringify(this.world))
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift()
    this.redoStack.length = 0
  }

  private changed(): void {
    this.pathCache = null
    this.reportCache = null
    this.dirty = true
    this.unsaved = true
    this.queueDraft()
  }

  // --- the draft ------------------------------------------------------------
  //
  // Everything here exists because a browser tab is not a safe place to keep an hour's
  // work. Every edit parks the whole world in localStorage a beat later, and the editor
  // offers it back the next time it opens if it is newer than what was saved.

  private queueDraft(): void {
    clearTimeout(this.draftTimer)
    this.draftTimer = window.setTimeout(() => this.writeDraft(), DRAFT_DELAY)
  }

  private writeDraft(): void {
    clearTimeout(this.draftTimer)
    if (!this.unsaved) return
    const draft: Draft = { v: 1, worldId: this.worldId, trackId: this.trackId, world: this.world, at: Date.now() }
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
    } catch {
      // A full quota is not worth interrupting the session over; Save still works.
    }
  }

  private readDraft(): Draft | null {
    try {
      const raw = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as Draft | null
      if (!raw || raw.v !== 1 || !raw.world || !Array.isArray(raw.world.tracks) || !raw.world.tracks.length) return null
      return raw
    } catch {
      return null
    }
  }

  private clearDraft(): void {
    clearTimeout(this.draftTimer)
    this.unsaved = false
    try {
      localStorage.removeItem(DRAFT_KEY)
    } catch {
      /* nothing to do */
    }
  }

  /** Offer back any edits the last session did not save. Asked once, on first opening. */
  private async offerDraft(): Promise<void> {
    if (this.draftOffered) return
    this.draftOffered = true
    const draft = this.readDraft()
    if (!draft) return
    if (JSON.stringify(draft.world) === JSON.stringify(this.world)) {
      this.clearDraft()
      return
    }
    const same = draft.worldId && draft.worldId === this.worldId
    const answer = await this.dialog(`Unsaved edits to “${draft.world.name}” from ${ago(draft.at)}${same ? '' : ' (a different world from the one open now)'}. Pick them up?`, [
      { label: 'Pick up', value: 'ok', primary: true },
      { label: 'Discard', value: 'drop', danger: true },
    ])
    if (answer === 'ok') {
      this.setWorld(draft.world, draft.worldId)
      if (this.world.tracks.some((t) => t.id === draft.trackId)) this.trackId = draft.trackId
      this.unsaved = true
      this.buildPalette()
      this.dirty = true
      this.flash('Picked up where you left off — Save when you are happy with it')
    } else this.clearDraft()
  }

  private undo(): void {
    const prev = this.undoStack.pop()
    if (!prev) return this.flash('Nothing to undo')
    this.redoStack.push(JSON.stringify(this.world))
    this.world = JSON.parse(prev) as WorldData
    if (!this.world.tracks.some((t) => t.id === this.trackId)) this.trackId = this.world.tracks[0]?.id ?? ''
    this.sel = null
    this.titleEl.textContent = this.world.name
    this.changed()
  }

  private redo(): void {
    const next = this.redoStack.pop()
    if (!next) return this.flash('Nothing to redo')
    this.undoStack.push(JSON.stringify(this.world))
    this.world = JSON.parse(next) as WorldData
    if (!this.world.tracks.some((t) => t.id === this.trackId)) this.trackId = this.world.tracks[0]?.id ?? ''
    this.sel = null
    this.titleEl.textContent = this.world.name
    this.changed()
  }

  private freeTrackId(): string {
    for (let n = 1; ; n++) if (!this.world.tracks.some((t) => t.id === `t${n}`)) return `t${n}`
  }

  // --- palette --------------------------------------------------------------

  private applyPalette(): void {
    this.paletteEl.classList.toggle('collapsed', this.paletteCollapsed)
    if (!this.paletteCollapsed) this.paletteEl.style.width = `${this.paletteW}px`
    else this.paletteEl.style.removeProperty('width')
    localStorage.setItem('apex-coast.editor.paletteW', String(this.paletteW))
    localStorage.setItem('apex-coast.editor.paletteCollapsed', this.paletteCollapsed ? '1' : '0')
    this.dirty = true
  }

  private buildPalette(): void {
    const p = this.paletteEl
    p.innerHTML = ''
    const head = (text: string) => {
      const h = document.createElement('h3')
      h.textContent = text
      p.appendChild(h)
    }
    const item = (label: string, colour: string, desc: string, active: boolean, onPick: () => void) => {
      const b = document.createElement('button')
      b.className = `tool${active ? ' selected' : ''}`
      b.title = desc
      b.innerHTML = `<span class="swatch" style="background:${colour}"></span><span>${label}</span>`
      b.addEventListener('click', () => {
        onPick()
        this.buildPalette()
        this.dirty = true
      })
      p.appendChild(b)
    }
    if (this.mode === 'set') {
      head('Tracks')
      for (const t of this.world.tracks) {
        const isStart = t.id === this.world.start
        const ends = !t.next.length
        item(`${isStart ? '▶ ' : ''}${t.name}${ends ? ' ⚑' : ''}`, t.id === this.trackId ? '#ff8a3c' : '#3a2a5a', `${t.nodes.length} waypoints · ${t.next.length ? `leads to ${t.next.join(', ')}` : 'a finish line'}`, t.id === this.trackId, () => {
          this.trackId = t.id
          this.sel = { kind: 'track', id: t.id }
          this.centreOnTrack(t.id)
        })
      }
      head('Add')
      item('New track', '#3f9a3a', 'Add another track to this world.', false, () => this.addTrack())
      return
    }
    const roll = this.track.roll ?? { amp: 3.2, period: 52 }
    head('Hills')
    item(`Swell ${roll.amp.toFixed(1)} m`, '#5cc8ff', 'How much the road rolls under everything, even where you drew it flat. Click to cycle.', false, () => {
      this.pushUndo()
      const steps = [0, 1.5, 3.2, 5, 8]
      const next = steps[(steps.findIndex((v) => Math.abs(v - roll.amp) < 0.01) + 1) % steps.length]
      this.track.roll = { ...roll, amp: next }
      this.changed()
      this.flash(next ? `Swell ${next.toFixed(1)} m` : 'Swell off — only the hills you drew')
    })
    item(`Swell every ${roll.period} seg`, '#3a7a9a', `One crest every ${roll.period} segments (${roll.period * SEG_LENGTH} m). Click to cycle.`, false, () => {
      this.pushUndo()
      const steps = [30, 40, 52, 70, 100]
      const next = steps[(steps.indexOf(roll.period) + 1) % steps.length]
      this.track.roll = { ...roll, period: next }
      this.changed()
      this.flash(`A crest every ${next * SEG_LENGTH} m`)
    })
    head('Clock')
    {
      const secs = this.track.seconds
      const est = Math.round(this.report().seconds)
      item(
        secs ? `Time ${secs} s` : 'Time · game default',
        '#ffb03c',
        `Seconds this stage puts on the clock: the start time when it is first, the checkpoint bonus when you reach it. Flat out this track takes about ${est} s. Click to cycle; the default is the shipped route's own timings.`,
        secs !== undefined,
        () => {
          this.pushUndo()
          const steps = [undefined, 30, 40, 50, 60, 75, 90, 120]
          const next = steps[(steps.findIndex((v) => v === secs) + 1) % steps.length]
          if (next === undefined) delete this.track.seconds
          else this.track.seconds = next
          this.changed()
          this.flash(next === undefined ? 'Clock: the game\u2019s own timings' : `Clock: ${next} s on this stage (about ${est} s of road)`)
        },
      )
    }
    head('Tools')
    item('Select / move', '#c0c8d0', 'Pick things up. Drag a waypoint to move it, its handles to bend the road.', this.tool.kind === 'select', () => (this.tool = { kind: 'select' }))
    item('Add waypoint', '#ffd45f', 'Click past either end to extend the road; click on it to insert.', this.tool.kind === 'node', () => (this.tool = { kind: 'node' }))
    item('Crossroads', '#f0e8c0', 'An intersection with traffic crossing it.', this.tool.kind === 'crossing', () => (this.tool = { kind: 'crossing' }))
    head('Scenes')
    for (const g of sceneGroups()) {
      for (const s of g.scenes) {
        const pal = PALETTES[s.theme.palette] ?? PALETTES.coast
        item(s.name, hex(pal.grassA), `${g.group} · ${s.desc}`, this.tool.kind === 'scene' && this.tool.id === s.id, () => (this.tool = { kind: 'scene', id: s.id }))
      }
    }
    head('Vibes')
    for (const v of Object.values(VIBES)) item(v.name, hex(v.skyBottom), `${v.name}: night ${Math.round(v.night * 100)}%, rain ${Math.round(v.rain * 100)}%. Drop two or three along a track and it will slide between them.`, this.tool.kind === 'vibe' && this.tool.id === v.id, () => (this.tool = { kind: 'vibe', id: v.id }))
    head('Macro elements')
    for (const s of SPAN_TOOLS) item(s.name, s.colour, `${s.desc} Drag along the road to set how far it runs.`, this.tool.kind === 'span' && this.tool.id === s.id && this.tool.side === s.side, () => (this.tool = { kind: 'span', id: s.id, side: s.side }))
    for (const g of PROP_GROUPS) {
      head(g.group)
      for (const k of g.kinds) item(k.name, '#8a7aa8', `Place a ${k.name.toLowerCase()} beside the road.`, this.tool.kind === 'prop' && this.tool.id === k.kind, () => (this.tool = { kind: 'prop', id: k.kind }))
    }
  }

  private refreshLoadList(): void {
    const sel = this.loadSelect
    sel.innerHTML = '<option value="">Open…</option>'
    for (const w of this.store.list()) {
      if (w.builtin) continue
      const o = document.createElement('option')
      o.value = w.id
      o.textContent = `${w.name} · ${w.tracks} track${w.tracks === 1 ? '' : 's'}`
      sel.appendChild(o)
    }
  }

  // --- toolbar actions ------------------------------------------------------

  private async action(act: string): Promise<void> {
    switch (act) {
      case 'exit':
        this.cb.onExit()
        break
      case 'mode-set':
        this.mode = 'set'
        this.sel = null
        this.buildPalette()
        this.fit()
        break
      case 'mode-track':
        this.mode = 'track'
        this.sel = null
        this.buildPalette()
        this.fit()
        break
      case 'undo':
        this.undo()
        break
      case 'redo':
        this.redo()
        break
      case 'zoom+':
        this.zoomBy(1.3)
        break
      case 'zoom-':
        this.zoomBy(1 / 1.3)
        break
      case 'fit':
        this.fit()
        break
      case 'save':
        this.worldId = this.store.save(this.world, this.worldId ?? undefined)
        this.refreshLoadList()
        this.clearDraft()
        this.flash(`Saved “${this.world.name}”`)
        break
      case 'save-as': {
        const name = await this.dialog('Save this world as…', [{ label: 'Save', value: 'ok', primary: true }, { label: 'Cancel', value: 'cancel' }], { placeholder: 'World name', value: this.store.freeName(this.world.name) })
        if (name === 'cancel' || !name.trim()) break
        this.world.name = name.trim()
        this.titleEl.textContent = this.world.name
        this.worldId = this.store.save(this.world)
        this.refreshLoadList()
        this.clearDraft()
        this.flash(`Saved “${this.world.name}”`)
        break
      }
      case 'rename-world': {
        const name = await this.dialog('Rename this world', [{ label: 'Rename', value: 'ok', primary: true }, { label: 'Cancel', value: 'cancel' }], { placeholder: 'World name', value: this.world.name })
        if (name === 'cancel' || !name.trim()) break
        this.pushUndo()
        this.world.name = name.trim()
        this.titleEl.textContent = this.world.name
        if (this.worldId) this.store.save(this.world, this.worldId)
        this.refreshLoadList()
        this.changed()
        break
      }
      case 'new-world': {
        const go = await this.dialog('Start a new, empty world? Anything unsaved is lost.', [{ label: 'New world', value: 'ok', primary: true }, { label: 'Cancel', value: 'cancel' }])
        if (go !== 'ok') break
        const t = emptyTrack('t1', 'Stage 1')
        this.setWorld({ v: 1, name: this.store.freeName('New World'), start: t.id, tracks: [t] }, null)
        break
      }
      case 'delete-world': {
        if (!this.worldId) {
          this.flash('This world has never been saved')
          break
        }
        const go = await this.dialog(`Delete “${this.world.name}”?`, [{ label: 'Delete', value: 'ok', danger: true }, { label: 'Cancel', value: 'cancel', primary: true }])
        if (go !== 'ok') break
        this.store.remove(this.worldId)
        this.worldId = null
        this.refreshLoadList()
        this.flash('Deleted')
        break
      }
      case 'fork-builtin': {
        const go = await this.dialog('Trace the built-in coast-to-coast route into this world? Its thirteen stages arrive as editable waypoints. Anything unsaved is lost.', [{ label: 'Fork it', value: 'ok', primary: true }, { label: 'Cancel', value: 'cancel' }])
        if (go !== 'ok') break
        this.setWorld(builtinAsWorld(this.store.freeName('Coast to Coast (copy)')), null)
        this.flash('Traced the built-in route — every stage is now waypoints')
        break
      }
      case 'export': {
        const blob = new Blob([JSON.stringify(this.world, null, 2)], { type: 'application/json' })
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = `${this.world.name.replace(/[^\w-]+/g, '-').toLowerCase()}.json`
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 1000)
        break
      }
      case 'stretch':
        this.cycleStretch()
        break
      case 'smooth':
        this.smooth()
        break
      case 'check':
        await this.check()
        break
      case 'test':
        this.cb.onTest(this.world, this.mode === 'track' ? this.trackId : this.world.start)
        break
      default:
        break
    }
    this.dirty = true
  }

  private open(id: string): void {
    const data = this.store.get(id)
    if (!data) return this.flash('That world has gone')
    this.setWorld(data, id)
    this.flash(`Opened “${data.name}”`)
  }

  private addTrack(): void {
    this.pushUndo()
    const id = this.freeTrackId()
    const t = emptyTrack(id, `Stage ${this.world.tracks.length + 1}`)
    // Lay it to the right of everything, on a free row.
    const maxX = Math.max(0, ...this.world.tracks.map((x) => x.ui?.x ?? 0))
    const rows = this.world.tracks.filter((x) => (x.ui?.x ?? 0) === maxX).length
    t.ui = { x: maxX + 1, y: rows - 1 }
    this.world.tracks.push(t)
    this.trackId = id
    this.sel = { kind: 'track', id }
    this.buildPalette()
    this.changed()
    this.flash(`Added “${t.name}” — drag a link into it to put it on the route`)
  }

  /**
   * Open out the corners the car could never hold.
   *
   * The pseudo-3D road is gentler than it looks: full lock only buys back so much
   * against the centrifugal push, so a corner under about EASY_RADIUS has to be braked
   * for and one under MIN_RADIUS cannot be held at all. Freehand waypoints routinely
   * land inside that, so this relaxes the offenders toward the line between their
   * neighbours — Laplacian smoothing, applied only where it is needed, so the shape you
   * drew survives everywhere it was already drivable.
   */
  private smooth(): void {
    if (this.mode !== 'track') return this.flash('Smoothing works on one track — switch to the track view')
    const nodes = this.track.nodes
    if (nodes.length < 3) return this.flash('Nothing to smooth')
    const before = this.report().minRadius
    this.pushUndo()
    const target = EASY_RADIUS
    // A handle longer than half the gap to its neighbour folds the road back on itself, and
    // that is the usual cause of a corner nothing can hold. Let those go back to automatic.
    let freed = 0
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      const next = nodes[i + 1]
      const prev = nodes[i - 1]
      if (n.outX !== undefined && next && Math.hypot(n.outX, n.outZ ?? 0) > 0.5 * Math.hypot(next.x - n.x, next.z - n.z)) {
        delete n.outX
        delete n.outZ
        freed++
      }
      if (n.inX !== undefined && prev && Math.hypot(n.inX, n.inZ ?? 0) > 0.5 * Math.hypot(prev.x - n.x, prev.z - n.z)) {
        delete n.inX
        delete n.inZ
        freed++
      }
    }
    // Then relax the offenders, measuring the road the compiler will actually build rather
    // than the triangle the waypoints make (a Bézier can be far tighter than its hull).
    for (let pass = 0; pass < 60; pass++) {
      const path = buildPath(nodes)
      let worst = Infinity
      const bad: number[] = []
      for (let i = 1; i < nodes.length - 1; i++) {
        const r = worstRadius(path, path.nodeS[i - 1], path.nodeS[i + 1])
        worst = Math.min(worst, r)
        if (r < target) bad.push(i)
      }
      if (!bad.length || worst >= target) break
      for (const i of bad) {
        const a = nodes[i - 1]
        const b = nodes[i]
        const cN = nodes[i + 1]
        const k = 0.3
        b.x += ((a.x + cN.x) / 2 - b.x) * k
        b.z += ((a.z + cN.z) / 2 - b.z) * k
      }
    }
    for (const n of nodes) {
      n.x = Math.round(n.x * 10) / 10
      n.z = Math.round(n.z * 10) / 10
    }
    this.changed()
    const after = this.report().minRadius
    this.flash(`Smoothed: tightest corner ${Math.round(before)} m → ${Math.round(after)} m${freed ? ` · ${freed} over-long handle${freed === 1 ? '' : 's'} back to automatic` : ''}`)
  }

  private async check(): Promise<void> {
    const lines: string[] = []
    for (const p of checkWorld(this.world)) lines.push(`${p.level === 'error' ? '<span class="err">✕</span>' : '<span class="warn">!</span>'} ${p.text}`)
    for (const t of this.world.tracks) {
      const r = compileTrack(t, 1).report
      lines.push(`<b>${t.name}</b> — ${(r.metres / 1000).toFixed(2)} km, ${r.seconds.toFixed(0)} s flat out, ${r.minRadius === Infinity ? 'no corners' : `tightest ${Math.round(r.minRadius)} m`}, ${Math.round(r.climb)} m climbed at up to ${Math.round(r.maxGrade * 100)} %`)
      for (const p of r.problems) lines.push(`<span class="warn">!</span> ${p}`)
    }
    const ends = reachable(this.world).filter((t) => !t.next.length)
    lines.push(`<b>Route</b> — ${routeLengthOf(this.world, this.world.start)} stages deep, ${ends.length} finish${ends.length === 1 ? '' : 'es'}: ${ends.map((t) => t.name).join(', ') || '—'}`)
    await this.dialog('World check', [{ label: 'Close', value: 'ok', primary: true }], undefined, lines)
  }

  // --- dialogs --------------------------------------------------------------

  private dialog(message: string, buttons: DialogButton[], input?: { placeholder: string; value: string }, lines?: string[]): Promise<string> {
    return new Promise((resolve) => {
      const back = document.createElement('div')
      back.className = 'editor-dialog-back'
      const box = document.createElement('div')
      box.className = 'editor-dialog'
      box.innerHTML = `<p></p>${lines ? `<ul class="report">${lines.map((l) => `<li>${l}</li>`).join('')}</ul>` : ''}${input ? `<input type="text" />` : ''}<div class="buttons"></div>`
      box.querySelector('p')!.textContent = message
      const field = box.querySelector<HTMLInputElement>('input')
      if (field && input) {
        field.placeholder = input.placeholder
        field.value = input.value
      }
      const finish = (v: string) => {
        back.remove()
        resolve(v)
      }
      for (const b of buttons) {
        const btn = document.createElement('button')
        btn.textContent = b.label
        if (b.primary) btn.className = 'primary'
        if (b.danger) btn.style.color = 'var(--danger)'
        btn.addEventListener('click', () => finish(b.value === 'ok' && field ? field.value : b.value))
        box.querySelector('.buttons')!.appendChild(btn)
      }
      back.appendChild(box)
      back.addEventListener('pointerdown', (e) => {
        if (e.target === back) finish('cancel')
      })
      box.addEventListener('keydown', (e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(field ? field.value : 'ok')
        if (e.key === 'Escape') finish('cancel')
      })
      this.el.appendChild(back)
      field?.focus()
      field?.select()
    })
  }

  private flash(text: string): void {
    this.statusInfo.textContent = text
    this.el.querySelector('.status')!.classList.add('flash')
    setTimeout(() => this.el.querySelector('.status')?.classList.remove('flash'), 1600)
    this.dirty = true
  }

  // --- view transforms ------------------------------------------------------

  private canvasPoint(e: PointerEvent | WheelEvent | MouseEvent, canvas: HTMLCanvasElement): { px: number; py: number } {
    const r = canvas.getBoundingClientRect()
    return { px: e.clientX - r.left, py: e.clientY - r.top }
  }

  /** Pixels per metre across the road: the along-road scale times the lateral stretch. */
  private get lateralScale(): number {
    return this.view.scale * this.view.stretch
  }

  private toPx(x: number, z: number): { x: number; y: number } {
    const w = this.plan.clientWidth
    const h = this.plan.clientHeight
    return { x: (x - this.view.cx) * this.lateralScale + w / 2, y: h / 2 - (z - this.view.cz) * this.view.scale }
  }

  private toWorld(px: number, py: number): { x: number; z: number } {
    const w = this.plan.clientWidth
    const h = this.plan.clientHeight
    return { x: (px - w / 2) / this.lateralScale + this.view.cx, z: (h / 2 - py) / this.view.scale + this.view.cz }
  }

  private setToPx(x: number, y: number): { x: number; y: number } {
    const w = this.plan.clientWidth
    const h = this.plan.clientHeight
    return { x: (x * SET_CELL - this.setView.cx) * this.setView.scale + w / 2, y: (y * SET_CELL - this.setView.cy) * this.setView.scale + h / 2 }
  }

  private setToWorld(px: number, py: number): { x: number; y: number } {
    const w = this.plan.clientWidth
    const h = this.plan.clientHeight
    return { x: ((px - w / 2) / this.setView.scale + this.setView.cx) / SET_CELL, y: ((py - h / 2) / this.setView.scale + this.setView.cy) / SET_CELL }
  }

  private fit(): void {
    const w = this.plan.clientWidth
    const h = this.plan.clientHeight
    if (w < 8 || h < 8) {
      // Not laid out yet (this happens on the frame the editor is un-hidden).
      this.needFit = true
      this.dirty = true
      return
    }
    this.needFit = false
    if (this.mode === 'set') {
      const xs = this.world.tracks.map((t) => t.ui?.x ?? 0)
      const ys = this.world.tracks.map((t) => t.ui?.y ?? 0)
      const x0 = Math.min(...xs, 0) * SET_CELL - 40
      const x1 = Math.max(...xs, 0) * SET_CELL + BOX_W + 40
      const y0 = Math.min(...ys, 0) * SET_CELL - 40
      const y1 = Math.max(...ys, 0) * SET_CELL + BOX_H + 40
      this.setView.scale = Math.max(0.15, Math.min(1.6, Math.min(w / (x1 - x0), h / (y1 - y0))))
      this.setView.cx = (x0 + x1) / 2
      this.setView.cy = (y0 + y1) / 2
    } else {
      const nodes = this.track.nodes
      if (!nodes.length) return
      const x0 = Math.min(...nodes.map((n) => n.x))
      const x1 = Math.max(...nodes.map((n) => n.x))
      const z0 = Math.min(...nodes.map((n) => n.z))
      const z1 = Math.max(...nodes.map((n) => n.z))
      const pad = 220
      this.view.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, h / (z1 - z0 + pad)))
      if (this.stretchAuto) {
        // Fill about four fifths of the width with however far the road wanders.
        const across = Math.max(80, x1 - x0)
        this.view.stretch = Math.max(1, Math.min(MAX_STRETCH, (w * 0.8) / across / this.view.scale))
      }
      this.view.cx = (x0 + x1) / 2
      this.view.cz = (z0 + z1) / 2
      this.syncStretchButton()
    }
    this.dirty = true
  }

  /** Walk the lateral exaggeration through its steps: fit-to-track, then 1× (the honest one) and up. */
  private cycleStretch(): void {
    if (this.mode !== 'track') return this.flash('The lateral stretch is for the track view')
    const now = this.stretchAuto ? 0 : this.view.stretch
    const i = STRETCHES.findIndex((s) => s === now)
    const next = STRETCHES[(i + 1) % STRETCHES.length]
    this.stretchAuto = next === 0
    if (this.stretchAuto) this.fit()
    else this.view.stretch = next
    this.syncStretchButton()
    this.flash(this.stretchAuto ? 'Lateral stretch: fitted to the track' : next === 1 ? 'Lateral stretch off — true scale, both axes' : `Lateral stretch ×${next}`)
    this.dirty = true
  }

  private syncStretchButton(): void {
    const b = this.el.querySelector<HTMLElement>('[data-stretch]')
    if (!b) return
    b.textContent = this.stretchAuto ? `⇔ Auto ×${this.view.stretch.toFixed(this.view.stretch < 10 ? 1 : 0)}` : `⇔ ×${this.view.stretch}`
    b.classList.toggle('active', this.view.stretch > 1.05)
  }

  private centreOnTrack(id: string): void {
    const t = this.world.tracks.find((x) => x.id === id)
    if (!t) return
    this.trackId = id
    this.mode = 'track'
    this.sel = null
    this.buildPalette()
    this.fit()
  }

  private zoomBy(f: number, at?: { px: number; py: number }): void {
    if (this.mode === 'set') {
      const before = at ? this.setToWorld(at.px, at.py) : null
      this.setView.scale = Math.max(0.12, Math.min(2.5, this.setView.scale * f))
      if (before && at) {
        const after = this.setToWorld(at.px, at.py)
        this.setView.cx += (before.x - after.x) * SET_CELL
        this.setView.cy += (before.y - after.y) * SET_CELL
      }
    } else {
      const before = at ? this.toWorld(at.px, at.py) : null
      this.view.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.view.scale * f))
      if (before && at) {
        const after = this.toWorld(at.px, at.py)
        this.view.cx += before.x - after.x
        this.view.cz += before.z - after.z
      }
    }
    this.dirty = true
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault()
    const p = this.canvasPoint(e, this.plan)
    if (e.shiftKey) {
      if (this.mode === 'set') this.setView.cx += e.deltaY / this.setView.scale
      else this.view.cx += e.deltaY / this.lateralScale
      this.dirty = true
      return
    }
    this.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, p)
  }

  // --- plan-view pointer ----------------------------------------------------

  private updateHover(e: PointerEvent | MouseEvent): void {
    const p = this.canvasPoint(e, this.plan)
    const w = this.toWorld(p.px, p.py)
    this.hover.x = w.x
    this.hover.z = w.z
    const path = this.path()
    const near = path.nearest(w.x, w.z)
    this.hover.s = near.s
    this.hover.lateral = near.lateral
    // In pixels: with the lateral axis stretched, a distance in metres means different things by axis.
    path.at(near.s, this.hoverSample)
    const q = this.toPx(this.hoverSample.x, this.hoverSample.z)
    this.hover.near = Math.hypot(q.x - p.px, q.y - p.py) < 90
  }

  private onPlanDown(e: PointerEvent): void {
    this.closeMenu()
    this.plan.setPointerCapture(e.pointerId)
    const p = this.canvasPoint(e, this.plan)
    if (e.button === 1 || this.spaceHeld) {
      this.pan = this.mode === 'set' ? { px: p.px, py: p.py, cx: this.setView.cx, cy: this.setView.cy } : { px: p.px, py: p.py, cx: this.view.cx, cy: this.view.cz }
      return
    }
    if (e.button !== 0) return
    if (this.mode === 'set') return this.onSetDown(e, p)
    this.updateHover(e)
    const alt = e.altKey
    const t = this.track
    const path = this.path()
    // With a stamp primed (a scene, a vibe, a prop, a macro element) the click is a
    // placement, not a selection: clipping a waypoint dot must not steal it.
    const stamping = this.tool.kind !== 'select' && this.tool.kind !== 'node'

    // Handles first: they sit on top of the node they belong to.
    const handle = stamping ? null : this.handleAt(p.px, p.py)
    if (handle) {
      if (alt) {
        this.pushUndo()
        const n = t.nodes[handle.i]
        if (handle.which === 'out') {
          delete n.outX
          delete n.outZ
        } else {
          delete n.inX
          delete n.inZ
        }
        this.changed()
        this.flash('Handle back to automatic')
        return
      }
      this.pushUndo()
      this.sel = { kind: 'handle', i: handle.i, which: handle.which }
      this.drag = { kind: 'handle', i: handle.i, which: handle.which }
      return
    }
    const ni = stamping ? -1 : this.nodeAt(p.px, p.py)
    if (ni >= 0) {
      if (alt) {
        this.deleteNode(ni)
        return
      }
      if (e.shiftKey) {
        this.pushUndo()
        t.nodes[ni].cusp = !t.nodes[ni].cusp
        this.changed()
        this.flash(t.nodes[ni].cusp ? 'Cusp: the handles move on their own' : 'Smooth: the handles stay in line')
        return
      }
      this.pushUndo()
      this.sel = { kind: 'node', i: ni }
      this.drag = { kind: 'node', i: ni }
      return
    }
    const marker = stamping ? null : this.markerAt(p.px, p.py)
    if (marker) {
      if (alt) {
        this.deleteSel(marker)
        return
      }
      this.sel = marker
      this.pushUndo()
      if (marker.kind === 'prop') this.drag = { kind: 'prop', i: marker.i }
      else if (marker.kind === 'scene') this.drag = { kind: 'stop', which: 'scene', i: marker.i }
      else if (marker.kind === 'vibe') this.drag = { kind: 'stop', which: 'vibe', i: marker.i }
      return
    }

    // Nothing under the pointer: the primed tool decides.
    const at = path.length > 0 ? this.hover.s / path.length : 0
    switch (this.tool.kind) {
      case 'node':
        this.pushUndo()
        this.addNodeAt(this.hover.x, this.hover.z)
        break
      case 'prop':
        if (!this.hover.near) return this.flash('Props go beside the road — click nearer it')
        this.pushUndo()
        this.placeProp(this.tool.id, at, this.hover.lateral / ROAD_HALF_WIDTH)
        break
      case 'scene':
        if (!this.hover.near) return this.flash('Click on the road to change the scene from there on')
        this.pushUndo()
        this.putSceneStop(at, this.tool.id)
        break
      case 'vibe':
        if (!this.hover.near) return this.flash('Click on the road to change the vibe from there on')
        this.pushUndo()
        this.putVibeStop(at, this.tool.id)
        break
      case 'crossing':
        if (!this.hover.near) return this.flash('Click on the road to put a crossroads there')
        this.pushUndo()
        t.crossings.push({ at })
        this.sel = { kind: 'crossing', i: t.crossings.length - 1 }
        this.changed()
        break
      case 'span':
        if (!this.hover.near) return this.flash('Drag along the road to lay this down')
        this.drag = { kind: 'newspan', from: at, to: at }
        break
      default:
        this.sel = null
        this.dirty = true
        break
    }
  }

  private onPlanMove(e: PointerEvent): void {
    const p = this.canvasPoint(e, this.plan)
    if (this.pan) {
      if (this.mode === 'set') {
        this.setView.cx = this.pan.cx - (p.px - this.pan.px) / this.setView.scale
        this.setView.cy = this.pan.cy - (p.py - this.pan.py) / this.setView.scale
      } else {
        this.view.cx = this.pan.cx - (p.px - this.pan.px) / this.lateralScale
        this.view.cz = this.pan.cy + (p.py - this.pan.py) / this.view.scale
      }
      this.dirty = true
      return
    }
    if (this.mode === 'set') {
      const d = this.drag
      if (d?.kind === 'box') {
        const w = this.setToWorld(p.px, p.py)
        const box = this.world.tracks.find((x) => x.id === d.id)
        if (box) box.ui = { x: Math.round(w.x - d.dx), y: Math.round(w.y - d.dy) }
        this.dirty = true
      } else if (d?.kind === 'link') {
        d.px = p.px
        d.py = p.py
        this.dirty = true
      }
      return
    }
    this.updateHover(e)
    const t = this.track
    const path = this.path()
    const at = path.length > 0 ? this.hover.s / path.length : 0
    const d = this.drag
    if (d) {
      switch (d.kind) {
        case 'node': {
          const n = t.nodes[d.i]
          n.x = Math.round(this.hover.x)
          n.z = Math.round(this.hover.z)
          this.changed()
          break
        }
        case 'handle': {
          const n = t.nodes[d.i]
          const dx = Math.round(this.hover.x - n.x)
          const dz = Math.round(this.hover.z - n.z)
          if (d.which === 'out') {
            n.outX = dx
            n.outZ = dz
            if (!n.cusp) {
              delete n.inX
              delete n.inZ
            }
          } else {
            n.inX = dx
            n.inZ = dz
            if (!n.cusp) {
              delete n.outX
              delete n.outZ
            }
          }
          this.changed()
          break
        }
        case 'prop': {
          const prop = t.props[d.i]
          prop.at = at
          prop.offset = Math.round((this.hover.lateral / ROAD_HALF_WIDTH) * 100) / 100
          this.changed()
          break
        }
        case 'stop': {
          const list = d.which === 'scene' ? t.scenes : t.vibes
          const stop = list[d.i]
          if (stop) stop.at = Math.max(0, Math.min(1, at))
          this.changed()
          break
        }
        case 'newspan':
          d.to = at
          this.dirty = true
          break
        default:
          break
      }
      return
    }
    this.dirty = true
  }

  private onPlanDouble(e: MouseEvent): void {
    const p = this.canvasPoint(e, this.plan)
    if (this.mode === 'set') {
      const box = this.boxAt(p.px, p.py)
      if (box) this.centreOnTrack(box)
      return
    }
    this.updateHover(e)
    if (!this.hover.near) return
    this.pushUndo()
    this.insertNodeAtS(this.hover.s)
  }

  private onPointerUp(e: PointerEvent): void {
    const d = this.drag
    this.pan = null
    this.drag = null
    if (!d) return
    if (d.kind === 'newspan') {
      const t = this.track
      const from = Math.min(d.from, d.to)
      const to = Math.max(d.from, d.to)
      const tool = this.tool
      if (tool.kind === 'span') {
        this.pushUndo()
        // A click rather than a drag still means something: lay a default length.
        const span = to - from < 0.008 ? { from, to: Math.min(1, from + 300 / Math.max(1, this.path().length)) } : { from, to }
        t.spans.push({ kind: tool.id, from: span.from, to: span.to, side: tool.side })
        this.sel = { kind: 'span', i: t.spans.length - 1 }
        this.changed()
        this.flash(`${SPAN_NAME[tool.id]} laid over ${Math.round((span.to - span.from) * this.path().length)} m`)
      }
    }
    if (d.kind === 'link') {
      const p = this.canvasPoint(e, this.plan)
      const target = this.boxAt(p.px, p.py)
      if (target && target !== d.from) this.link(d.from, target)
      else if (!target) this.flash('Drop the link on another track')
    }
    if (d.kind === 'link' || d.kind === 'box') this.buildPalette()
    this.dirty = true
  }

  // --- set view -------------------------------------------------------------

  private boxAt(px: number, py: number): string | null {
    for (const t of this.world.tracks) {
      const o = this.setToPx(t.ui?.x ?? 0, t.ui?.y ?? 0)
      const w = BOX_W * this.setView.scale
      const h = BOX_H * this.setView.scale
      if (px >= o.x && px <= o.x + w && py >= o.y && py <= o.y + h) return t.id
    }
    return null
  }

  /** The exit port of a box: a dot on its right edge you drag links out of. */
  private portAt(px: number, py: number): string | null {
    for (const t of this.world.tracks) {
      const o = this.setToPx(t.ui?.x ?? 0, t.ui?.y ?? 0)
      const cx = o.x + BOX_W * this.setView.scale
      const cy = o.y + (BOX_H / 2) * this.setView.scale
      if (Math.hypot(px - cx, py - cy) < 12) return t.id
    }
    return null
  }

  private linkAt(px: number, py: number): { kind: 'link'; from: string; slot: number } | null {
    for (const t of this.world.tracks) {
      for (let slot = 0; slot < t.next.length; slot++) {
        const pts = this.linkPoints(t, slot)
        if (!pts) continue
        for (let k = 0; k <= 24; k++) {
          const p = bezierAt(pts, k / 24)
          if (Math.hypot(px - p.x, py - p.y) < 8) return { kind: 'link', from: t.id, slot }
        }
      }
    }
    return null
  }

  private linkPoints(t: CoastTrack, slot: number): [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }] | null {
    const target = this.world.tracks.find((x) => x.id === t.next[slot])
    if (!target) return null
    const a = this.setToPx(t.ui?.x ?? 0, t.ui?.y ?? 0)
    const b = this.setToPx(target.ui?.x ?? 0, target.ui?.y ?? 0)
    const s = this.setView.scale
    const p0 = { x: a.x + BOX_W * s, y: a.y + (BOX_H / 2) * s }
    const p3 = { x: b.x, y: b.y + (BOX_H / 2) * s }
    const bend = Math.max(40, Math.abs(p3.x - p0.x) * 0.5) * 1
    return [p0, { x: p0.x + bend, y: p0.y }, { x: p3.x - bend, y: p3.y }, p3]
  }

  private onSetDown(e: PointerEvent, p: { px: number; py: number }): void {
    const port = this.portAt(p.px, p.py)
    if (port) {
      const t = this.world.tracks.find((x) => x.id === port)!
      if (t.next.length >= 2) return this.flash(`${t.name} already forks two ways — remove a link first`)
      this.drag = { kind: 'link', from: port, px: p.px, py: p.py }
      return
    }
    const link = this.linkAt(p.px, p.py)
    if (link) {
      if (e.altKey) {
        this.pushUndo()
        const from = this.world.tracks.find((x) => x.id === link.from)!
        from.next.splice(link.slot, 1)
        this.sel = null
        this.buildPalette()
        this.changed()
        return
      }
      this.sel = link
      this.dirty = true
      return
    }
    const box = this.boxAt(p.px, p.py)
    if (box) {
      if (e.altKey) {
        void this.removeTrack(box)
        return
      }
      this.pushUndo()
      const t = this.world.tracks.find((x) => x.id === box)!
      const w = this.setToWorld(p.px, p.py)
      this.trackId = box
      this.sel = { kind: 'track', id: box }
      this.drag = { kind: 'box', id: box, dx: w.x - (t.ui?.x ?? 0), dy: w.y - (t.ui?.y ?? 0) }
      this.buildPalette()
      return
    }
    this.sel = null
    this.dirty = true
  }

  private link(from: string, to: string): void {
    const a = this.world.tracks.find((x) => x.id === from)!
    if (a.next.includes(to)) return this.flash('Already linked')
    if (a.next.length >= 2) return this.flash('A track can only fork two ways')
    // Would this close a loop? A run has to reach a finish.
    const probe = structuredClone(this.world)
    probe.tracks.find((x) => x.id === from)!.next.push(to)
    if (checkWorld(probe).some((p) => p.text.includes('loops'))) return this.flash('That would loop the route back on itself')
    this.pushUndo()
    a.next.push(to)
    this.buildPalette()
    this.changed()
    this.flash(a.next.length === 2 ? `${a.name} now forks: left → ${this.nameOf(a.next[0])}, right → ${this.nameOf(a.next[1])}` : `${a.name} → ${this.nameOf(to)}`)
  }

  private nameOf(id: string): string {
    return this.world.tracks.find((t) => t.id === id)?.name ?? id
  }

  private async removeTrack(id: string): Promise<void> {
    const t = this.world.tracks.find((x) => x.id === id)
    if (!t) return
    if (this.world.tracks.length === 1) return this.flash('A world needs at least one track')
    const go = await this.dialog(`Delete “${t.name}” and every link to it?`, [{ label: 'Delete', value: 'ok', danger: true }, { label: 'Cancel', value: 'cancel', primary: true }])
    if (go !== 'ok') return
    this.pushUndo()
    this.world.tracks = this.world.tracks.filter((x) => x.id !== id)
    for (const other of this.world.tracks) other.next = other.next.filter((n) => n !== id)
    if (this.world.start === id) this.world.start = this.world.tracks[0].id
    if (this.trackId === id) this.trackId = this.world.tracks[0].id
    this.sel = null
    this.buildPalette()
    this.changed()
  }

  // --- track edits ----------------------------------------------------------

  private nodeAt(px: number, py: number): number {
    const nodes = this.track.nodes
    for (let i = 0; i < nodes.length; i++) {
      const p = this.toPx(nodes[i].x, nodes[i].z)
      if (Math.hypot(px - p.x, py - p.y) < 9) return i
    }
    return -1
  }

  /** Handles are only shown (and only hit) for the selected node and its neighbours. */
  private handleNodes(): number[] {
    const s = this.sel
    const i = s && (s.kind === 'node' || s.kind === 'handle') ? s.i : -1
    if (i < 0) return []
    return [i]
  }

  private handleAt(px: number, py: number): { i: number; which: 'in' | 'out' } | null {
    const nodes = this.track.nodes
    for (const i of this.handleNodes()) {
      const n = nodes[i]
      if (!n) continue
      for (const which of ['out', 'in'] as const) {
        const h = which === 'out' ? handleOut(nodes, i) : handleIn(nodes, i)
        const p = this.toPx(n.x + h.x, n.z + h.z)
        if (Math.hypot(px - p.x, py - p.y) < 8) return { i, which }
      }
    }
    return null
  }

  /** How far off the road the scene and vibe flags stand, in metres — a fixed 40 px at any zoom. */
  private markerStalk(): number {
    return Math.max(ROAD_HALF_WIDTH * 2, 40 / this.lateralScale)
  }

  private markerAt(px: number, py: number): Sel {
    const t = this.track
    const path = this.path()
    const s: PathSample = { s: 0, x: 0, z: 0, y: 0, heading: 0, bank: 0 }
    const hit = (at: number, lateral: number) => {
      path.at(Math.max(0, Math.min(path.length, at * path.length)), s)
      const hx = Math.sin(s.heading)
      const hz = Math.cos(s.heading)
      const p = this.toPx(s.x + hz * lateral, s.z - hx * lateral)
      return Math.hypot(px - p.x, py - p.y) < 8
    }
    for (let i = t.props.length - 1; i >= 0; i--) if (hit(t.props[i].at, t.props[i].offset * ROAD_HALF_WIDTH)) return { kind: 'prop', i }
    for (let i = t.crossings.length - 1; i >= 0; i--) if (hit(t.crossings[i].at, 0)) return { kind: 'crossing', i }
    const stalk = this.markerStalk()
    for (let i = t.vibes.length - 1; i >= 0; i--) if (hit(t.vibes[i].at, -stalk)) return { kind: 'vibe', i }
    for (let i = t.scenes.length - 1; i >= 0; i--) if (hit(t.scenes[i].at, stalk)) return { kind: 'scene', i }
    return null
  }

  /** Extend the road: a click past one end appends there, whichever end is nearer. */
  private addNodeAt(x: number, z: number): void {
    const t = this.track
    const first = t.nodes[0]
    const last = t.nodes[t.nodes.length - 1]
    const dFirst = Math.hypot(x - first.x, z - first.z)
    const dLast = Math.hypot(x - last.x, z - last.z)
    if (dLast <= dFirst) {
      t.nodes.push({ x: Math.round(x), z: Math.round(z), y: last.y })
      this.sel = { kind: 'node', i: t.nodes.length - 1 }
    } else {
      t.nodes.unshift({ x: Math.round(x), z: Math.round(z), y: first.y })
      this.sel = { kind: 'node', i: 0 }
    }
    this.changed()
  }

  /** Insert a waypoint on the road at arc length `s`, keeping the shape. */
  private insertNodeAtS(s: number): void {
    const t = this.track
    const path = this.path()
    const p = path.at(Math.max(0, Math.min(path.length, s)))
    let i = 0
    while (i < path.nodeS.length - 1 && path.nodeS[i + 1] < s) i++
    t.nodes.splice(i + 1, 0, { x: Math.round(p.x), z: Math.round(p.z), y: Math.round(p.y * 10) / 10, bank: p.bank > 0.02 ? Math.round(p.bank * 100) / 100 : undefined })
    this.sel = { kind: 'node', i: i + 1 }
    this.changed()
    this.flash('Waypoint inserted')
  }

  private deleteNode(i: number): void {
    const t = this.track
    if (t.nodes.length <= 2) return this.flash('A track needs at least two waypoints')
    this.pushUndo()
    t.nodes.splice(i, 1)
    this.sel = null
    this.changed()
  }

  private placeProp(kind: string, at: number, offset: number): void {
    const info = PROP_INFO[kind]
    const t = this.track
    let off = Math.max(-4, Math.min(4, offset))
    // Anything but an arch or a gantry is pushed clear of the tarmac: a tree in the
    // carriageway is an instant crash, which is never what a click on the road meant.
    if (info?.offset !== 0 && Math.abs(off) < 1.06) off = 1.06 * (off < 0 ? -1 : 1)
    t.props.push({ kind, at, offset: Math.round(off * 100) / 100, scale: info?.scale })
    this.sel = { kind: 'prop', i: t.props.length - 1 }
    this.changed()
  }

  private putSceneStop(at: number, scene: string): void {
    const t = this.track
    // A stop close to an existing one replaces it rather than stacking up.
    const near = t.scenes.findIndex((s) => Math.abs(s.at - at) < 0.02)
    if (near >= 0) t.scenes[near] = { ...t.scenes[near], scene }
    else t.scenes.push({ at, scene })
    t.scenes.sort((a, b) => a.at - b.at)
    if (t.scenes.length && t.scenes[0].at > 0) t.scenes[0].at = 0
    this.sel = { kind: 'scene', i: t.scenes.findIndex((s) => s.scene === scene && Math.abs(s.at - at) < 0.03) }
    this.changed()
    this.flash(`${sceneDef(scene).name} from ${Math.round(at * 100)}% on`)
  }

  private putVibeStop(at: number, vibe: string): void {
    const t = this.track
    const near = t.vibes.findIndex((s) => Math.abs(s.at - at) < 0.02)
    if (near >= 0) t.vibes[near] = { ...t.vibes[near], vibe }
    else t.vibes.push({ at, vibe, fade: VIBE_FADE })
    t.vibes.sort((a, b) => a.at - b.at)
    if (t.vibes.length && t.vibes[0].at > 0) t.vibes[0].at = 0
    this.sel = { kind: 'vibe', i: t.vibes.findIndex((s) => s.vibe === vibe && Math.abs(s.at - at) < 0.03) }
    this.changed()
    this.flash(`${vibeDef(vibe).name} from ${Math.round(at * 100)}% on${t.vibes.length > 1 ? ' — it will slide in over the fade' : ''}`)
  }

  private deleteSel(sel: Sel = this.sel): void {
    if (!sel) return
    const t = this.track
    switch (sel.kind) {
      case 'node':
        this.deleteNode(sel.i)
        return
      case 'prop':
        this.pushUndo()
        t.props.splice(sel.i, 1)
        break
      case 'span':
        this.pushUndo()
        t.spans.splice(sel.i, 1)
        break
      case 'crossing':
        this.pushUndo()
        t.crossings.splice(sel.i, 1)
        break
      case 'scene':
        if (t.scenes.length <= 1) return this.flash('A track needs one scene at least')
        if (sel.i === 0) return this.flash('The first scene sets the start — change it instead of deleting it')
        this.pushUndo()
        t.scenes.splice(sel.i, 1)
        break
      case 'vibe':
        if (t.vibes.length <= 1) return this.flash('A track needs one vibe at least')
        if (sel.i === 0) return this.flash('The first vibe sets the start — change it instead of deleting it')
        this.pushUndo()
        t.vibes.splice(sel.i, 1)
        break
      case 'link': {
        this.pushUndo()
        const from = this.world.tracks.find((x) => x.id === sel.from)
        from?.next.splice(sel.slot, 1)
        this.buildPalette()
        break
      }
      case 'track':
        void this.removeTrack(sel.id)
        return
      default:
        return
    }
    this.sel = null
    this.changed()
  }

  // --- keys -----------------------------------------------------------------

  private onKey(e: KeyboardEvent): void {
    if (!this.visible) return
    if (this.el.querySelector('.editor-dialog')) return
    const mod = e.metaKey || e.ctrlKey
    if (e.code === 'Space') this.spaceHeld = true
    if (mod && e.code === 'KeyZ') {
      e.preventDefault()
      if (e.shiftKey) this.redo()
      else this.undo()
      return
    }
    if (mod && e.code === 'KeyS') {
      e.preventDefault()
      void this.action('save')
      return
    }
    switch (e.code) {
      case 'Escape':
        if (this.menu) this.closeMenu()
        else this.cb.onExit()
        break
      case 'Delete':
      case 'Backspace':
        e.preventDefault()
        this.deleteSel()
        break
      case 'KeyT':
        void this.action('test')
        break
      case 'KeyV':
        void this.check()
        break
      case 'Tab':
        e.preventDefault()
        void this.action(this.mode === 'set' ? 'mode-track' : 'mode-set')
        break
      case 'Digit0':
        this.fit()
        break
      case 'Equal':
        this.zoomBy(1.3)
        break
      case 'Minus':
        this.zoomBy(1 / 1.3)
        break
      case 'KeyB': {
        const s = this.sel
        if (this.mode !== 'track' || !s || s.kind !== 'node') break
        this.pushUndo()
        const n = this.track.nodes[s.i]
        n.bank = n.bank ? 0 : 1
        this.changed()
        this.flash(n.bank ? 'Bank in here — set the next waypoint back to flat to bank out again' : 'Flat here')
        break
      }
      case 'KeyQ':
      case 'KeyE': {
        const s = this.sel
        if (this.mode !== 'track' || !s || s.kind !== 'node') break
        this.pushUndo()
        this.setNodeHeight(s.i, this.track.nodes[s.i].y + (e.code === 'KeyE' ? 4 : -4))
        break
      }
      case 'Comma':
      case 'Period': {
        const s = this.sel
        if (!s) break
        const d = e.code === 'Period' ? 1 : -1
        this.pushUndo()
        if (s.kind === 'vibe') {
          const v = this.track.vibes[s.i]
          v.fade = Math.max(0.02, Math.min(0.9, (v.fade ?? VIBE_FADE) + d * 0.03))
          this.flash(`Fade over ${Math.round((v.fade ?? VIBE_FADE) * this.path().length)} m`)
        } else if (s.kind === 'prop') {
          const pr = this.track.props[s.i]
          pr.scale = Math.max(0.3, Math.min(4, (pr.scale ?? 1) + d * 0.1))
          this.flash(`Scale ${(pr.scale ?? 1).toFixed(1)}×`)
        } else if (s.kind === 'span') {
          const sp = this.track.spans[s.i]
          sp.side = (sp.side === -1 ? 0 : sp.side === 0 ? 1 : -1) as -1 | 0 | 1
          this.flash(`Side: ${sp.side === 0 ? 'both' : sp.side < 0 ? 'left' : 'right'}`)
        }
        this.changed()
        break
      }
      default:
        break
    }
  }

  // --- context menu ---------------------------------------------------------

  private openMenu(e: MouseEvent): void {
    this.closeMenu()
    const p = this.canvasPoint(e, this.plan)
    const items: { label: string; hint?: string; danger?: boolean; run: () => void }[] = []
    if (this.mode === 'set') {
      const box = this.boxAt(p.px, p.py)
      if (box) {
        const t = this.world.tracks.find((x) => x.id === box)!
        items.push({ label: `— ${t.name} —`, run: () => {} })
        items.push({ label: 'Edit this track', hint: 'dbl-click', run: () => this.centreOnTrack(box) })
        items.push({
          label: 'Rename…',
          run: () => {
            void this.dialog('Rename this track', [{ label: 'Rename', value: 'ok', primary: true }, { label: 'Cancel', value: 'cancel' }], { placeholder: 'Track name', value: t.name }).then((v) => {
              if (v === 'cancel' || !v.trim()) return
              this.pushUndo()
              t.name = v.trim()
              this.buildPalette()
              this.changed()
            })
          },
        })
        items.push({
          label: 'Make this the start',
          run: () => {
            this.pushUndo()
            this.world.start = box
            this.buildPalette()
            this.changed()
          },
        })
        items.push({
          label: 'Duplicate',
          run: () => {
            this.pushUndo()
            const copy = structuredClone(t)
            copy.id = this.freeTrackId()
            copy.name = `${t.name} copy`
            copy.next = []
            copy.ui = { x: (t.ui?.x ?? 0), y: (t.ui?.y ?? 0) + 1 }
            this.world.tracks.push(copy)
            this.buildPalette()
            this.changed()
          },
        })
        if (t.next.length) items.push({ label: 'Clear its links', run: () => { this.pushUndo(); t.next = []; this.buildPalette(); this.changed() } })
        items.push({ label: 'Delete track', danger: true, run: () => void this.removeTrack(box) })
      } else {
        items.push({ label: 'New track', run: () => this.addTrack() })
        items.push({ label: 'Fit', hint: '0', run: () => this.fit() })
      }
    } else {
      const ni = this.nodeAt(p.px, p.py)
      const marker = this.markerAt(p.px, p.py)
      if (ni >= 0) {
        const n = this.track.nodes[ni]
        items.push({ label: `— waypoint ${ni + 1} of ${this.track.nodes.length} —`, run: () => {} })
        items.push({ label: n.cusp ? 'Make it smooth' : 'Make it a cusp', hint: '⇧click', run: () => { this.pushUndo(); n.cusp = !n.cusp; this.changed() } })
        items.push({ label: n.bank ? 'Bank out here' : 'Bank in here', hint: 'B', run: () => { this.pushUndo(); n.bank = n.bank ? 0 : 1; this.changed() } })
        items.push({ label: 'Reset its handles', run: () => { this.pushUndo(); delete n.inX; delete n.inZ; delete n.outX; delete n.outZ; this.changed() } })
        items.push({ label: 'Delete waypoint', danger: true, hint: '⌥click', run: () => this.deleteNode(ni) })
      } else if (marker) {
        items.push({ label: 'Delete', danger: true, hint: '⌥click', run: () => this.deleteSel(marker) })
      } else {
        items.push({ label: 'Insert waypoint here', hint: 'dbl-click', run: () => { if (this.hover.near) { this.pushUndo(); this.insertNodeAtS(this.hover.s) } } })
        items.push({ label: 'Back to the set view', hint: 'Tab', run: () => void this.action('mode-set') })
        items.push({ label: 'Fit', hint: '0', run: () => this.fit() })
      }
    }
    const menu = document.createElement('div')
    menu.className = 'editor-menu'
    for (const it of items) {
      const row = document.createElement('div')
      row.className = `item${it.label.startsWith('—') ? ' head' : ''}${it.danger ? ' danger' : ''}`
      row.innerHTML = `<span></span>${it.hint ? `<kbd>${it.hint}</kbd>` : ''}`
      row.querySelector('span')!.textContent = it.label
      if (!it.label.startsWith('—')) row.addEventListener('click', () => { it.run(); this.closeMenu(); this.dirty = true })
      menu.appendChild(row)
    }
    const r = this.el.getBoundingClientRect()
    menu.style.left = `${e.clientX - r.left}px`
    menu.style.top = `${e.clientY - r.top}px`
    this.el.appendChild(menu)
    this.menu = menu
  }

  private closeMenu(): void {
    this.menu?.remove()
    this.menu = null
  }

  private hideTip(): void {
    this.tip.classList.add('hidden')
  }

  // --- strips ---------------------------------------------------------------

  private stripX(at: number, canvas: HTMLCanvasElement): number {
    const w = canvas.clientWidth
    return STRIP_MARGIN + at * Math.max(1, w - 2 * STRIP_MARGIN)
  }
  private stripAt(px: number, canvas: HTMLCanvasElement): number {
    const w = canvas.clientWidth
    return Math.max(0, Math.min(1, (px - STRIP_MARGIN) / Math.max(1, w - 2 * STRIP_MARGIN)))
  }

  private onProfileDown(e: PointerEvent): void {
    if (this.mode !== 'track') return
    this.profile.setPointerCapture(e.pointerId)
    const p = this.canvasPoint(e, this.profile)
    const path = this.path()
    const nodes = this.track.nodes
    let best = -1
    let bestD = 12
    for (let i = 0; i < nodes.length; i++) {
      const x = this.stripX(path.length ? path.nodeS[i] / path.length : 0, this.profile)
      const y = this.profileY(nodes[i].y)
      const d = Math.hypot(p.px - x, p.py - y)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    if (best < 0) return
    this.pushUndo()
    this.sel = { kind: 'node', i: best }
    this.drag = { kind: 'height', i: best, py: p.py, y0: nodes[best].y }
    this.dirty = true
  }

  private onStripMove(e: PointerEvent): void {
    const d = this.drag
    if (!d) return
    if (d.kind === 'height') {
      const p = this.canvasPoint(e, this.profile)
      this.setNodeHeight(d.i, d.y0 - (p.py - d.py) / this.profileScale())
      return
    }
    if (d.kind === 'span') {
      const at = this.stripAt(this.canvasPoint(e, this.timeline).px, this.timeline)
      const sp = this.track.spans[d.i]
      if (!sp) return
      if (d.grab === 'from') sp.from = Math.min(at, sp.to - 0.005)
      else if (d.grab === 'to') sp.to = Math.max(at, sp.from + 0.005)
      else {
        const len = sp.to - sp.from
        const from = Math.max(0, Math.min(1 - len, at - d.at))
        sp.from = from
        sp.to = from + len
      }
      this.changed()
      return
    }
    if (d.kind === 'stop') {
      const at = this.stripAt(this.canvasPoint(e, this.timeline).px, this.timeline)
      const list = d.which === 'scene' ? this.track.scenes : this.track.vibes
      const stop = list[d.i]
      if (stop && d.i > 0) stop.at = Math.max(0.005, Math.min(1, at))
      this.changed()
      return
    }
    if (d.kind === 'prop') {
      const at = this.stripAt(this.canvasPoint(e, this.timeline).px, this.timeline)
      const pr = this.track.props[d.i]
      if (pr) pr.at = at
      this.changed()
    }
  }

  private onTimelineDown(e: PointerEvent): void {
    if (this.mode !== 'track') return
    this.timeline.setPointerCapture(e.pointerId)
    const p = this.canvasPoint(e, this.timeline)
    const at = this.stripAt(p.px, this.timeline)
    const t = this.track
    const lane = this.laneAt(p.py)
    if (lane === 'scene' || lane === 'vibe') {
      const list = lane === 'scene' ? t.scenes : t.vibes
      let best = -1
      let bestD = 10
      for (let i = 0; i < list.length; i++) {
        const d = Math.abs(this.stripX(list[i].at, this.timeline) - p.px)
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
      if (best >= 0) {
        if (e.altKey) return this.deleteSel({ kind: lane, i: best } as Sel)
        this.sel = { kind: lane, i: best } as Sel
        this.pushUndo()
        this.drag = { kind: 'stop', which: lane, i: best }
        this.dirty = true
        return
      }
      // Empty lane: the primed tool can drop a stop here.
      if (this.tool.kind === 'scene' && lane === 'scene') {
        this.pushUndo()
        this.putSceneStop(at, this.tool.id)
        return
      }
      if (this.tool.kind === 'vibe' && lane === 'vibe') {
        this.pushUndo()
        this.putVibeStop(at, this.tool.id)
        return
      }
      this.sel = null
      this.dirty = true
      return
    }
    if (lane === 'spans') {
      const row = this.spanRows()
      for (let i = t.spans.length - 1; i >= 0; i--) {
        const y = this.spanRowY(row[i])
        if (Math.abs(p.py - y) > 9) continue
        const x0 = this.stripX(t.spans[i].from, this.timeline)
        const x1 = this.stripX(t.spans[i].to, this.timeline)
        if (p.px < x0 - 5 || p.px > x1 + 5) continue
        if (e.altKey) return this.deleteSel({ kind: 'span', i })
        this.sel = { kind: 'span', i }
        this.pushUndo()
        const grab = Math.abs(p.px - x0) < 6 ? 'from' : Math.abs(p.px - x1) < 6 ? 'to' : 'both'
        this.drag = { kind: 'span', i, grab, at: at - t.spans[i].from }
        this.dirty = true
        return
      }
      if (this.tool.kind === 'span') {
        this.pushUndo()
        const len = 300 / Math.max(1, this.path().length)
        t.spans.push({ kind: this.tool.id, from: at, to: Math.min(1, at + len), side: this.tool.side })
        this.sel = { kind: 'span', i: t.spans.length - 1 }
        this.changed()
        return
      }
    }
    if (lane === 'points') {
      for (let i = t.props.length - 1; i >= 0; i--) {
        if (Math.abs(this.stripX(t.props[i].at, this.timeline) - p.px) > 6) continue
        if (e.altKey) return this.deleteSel({ kind: 'prop', i })
        this.sel = { kind: 'prop', i }
        this.pushUndo()
        this.drag = { kind: 'prop', i }
        this.dirty = true
        return
      }
      for (let i = t.crossings.length - 1; i >= 0; i--) {
        if (Math.abs(this.stripX(t.crossings[i].at, this.timeline) - p.px) > 6) continue
        if (e.altKey) return this.deleteSel({ kind: 'crossing', i })
        this.sel = { kind: 'crossing', i }
        this.dirty = true
        return
      }
      if (this.tool.kind === 'crossing') {
        this.pushUndo()
        t.crossings.push({ at })
        this.changed()
        return
      }
    }
    this.sel = null
    this.dirty = true
  }

  private laneAt(py: number): 'scene' | 'vibe' | 'spans' | 'points' {
    if (py < 30) return 'scene'
    if (py < 56) return 'vibe'
    if (py < 100) return 'spans'
    return 'points'
  }

  /** Which row of the spans lane each span is drawn on (overlapping spans stack). */
  private spanRows(): number[] {
    const spans = this.track.spans
    const rows: number[] = []
    const ends: number[] = []
    for (const s of spans) {
      let r = 0
      while (r < ends.length && ends[r] > Math.min(s.from, s.to) + 1e-6) r++
      rows.push(r)
      ends[r] = Math.max(s.from, s.to)
    }
    return rows
  }
  private spanRowY(row: number): number {
    return 66 + Math.min(2, row) * 14
  }

  /**
   * The band the profile strip shows, from the road as it will actually be built rather
   * than from the heights that were asked for — a waypoint dragged into orbit must not
   * squash the hills you can see into a flat line.
   */
  private profileBand(): { lo: number; hi: number } {
    const ys = this.report().profile
    let lo = 0
    let hi = 20
    for (const y of ys) {
      lo = Math.min(lo, y)
      hi = Math.max(hi, y)
    }
    return { lo, hi: Math.max(hi, lo + 30) }
  }
  private profileScale(): number {
    const b = this.profileBand()
    return (PROFILE_H - 26) / (b.hi - b.lo)
  }
  private profileY(y: number): number {
    const b = this.profileBand()
    return Math.max(4, Math.min(PROFILE_H - 4, PROFILE_H - 13 - (y - b.lo) * this.profileScale()))
  }

  /**
   * Set a waypoint's height, held to a gradient the road can actually climb.
   *
   * The limit is against its neighbours, so the way to climb higher is to space the
   * waypoints further apart — which is what the message says, because being stopped
   * without being told why is the worst version of this.
   */
  private setNodeHeight(i: number, y: number): void {
    const n = this.track.nodes[i]
    if (!n) return
    const range = this.path().heightRange(i)
    const clamped = Math.max(range.lo, Math.min(range.hi, y))
    n.y = Math.round(clamped * 10) / 10
    if (Math.abs(clamped - y) > 0.5) {
      const gap = Math.round(Math.min(...[i - 1, i + 1].filter((j) => j >= 0 && j < this.path().nodeCount).map((j) => Math.abs(this.path().nodeS[j] - this.path().nodeS[i]))))
      this.flash(`${Math.round(NODE_GRADE * 100)} % is as steep as the road climbs — ${gap} m of road buys ${Math.round(gap * NODE_GRADE)} m of height. Space the waypoints further apart.`)
    }
    this.changed()
  }

  // --- drawing --------------------------------------------------------------

  private sizeCanvas(c: HTMLCanvasElement, cssH?: number): CanvasRenderingContext2D {
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    if (cssH !== undefined) c.style.height = `${cssH}px`
    const w = Math.max(1, c.clientWidth)
    const h = Math.max(1, c.clientHeight)
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr)
      c.height = Math.round(h * dpr)
    }
    const ctx = c.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    return ctx
  }

  private draw(): void {
    this.el.querySelector('[data-mode-set]')!.classList.toggle('active', this.mode === 'set')
    this.el.querySelector('[data-mode-track]')!.classList.toggle('active', this.mode === 'track')
    const trackMode = this.mode === 'track'
    this.profile.classList.toggle('hidden', !trackMode)
    this.timeline.classList.toggle('hidden', !trackMode)
    this.titleEl.textContent = `${this.unsaved ? '• ' : ''}${this.world.name}`
    this.titleEl.title = this.unsaved ? 'Unsaved edits — parked in this browser, but Save to keep them' : this.world.name
    this.crumbEl.textContent = trackMode ? `${this.track.name}` : `${this.world.tracks.length} tracks · start ${this.nameOf(this.world.start)}`
    if (trackMode) {
      this.drawPlan()
      this.drawProfile()
      this.drawTimeline()
      this.statusHints.textContent = 'drag waypoints · drag handles to bend · dbl-click the road to insert · ⌥click delete · ⇧click cusp · B bank · Q/E height · Tab set view'
    } else {
      this.drawSet()
      this.statusHints.textContent = 'drag boxes · drag the ● on a box onto another to link · two links out = a fork · ⌥click a link to cut it · dbl-click to edit · Tab track view'
    }
    const info = this.statusText()
    this.statusInfo.textContent = info
    // The bar is one line, and a warning is exactly the thing that gets cut off it. Keep the whole
    // sentence reachable, and say so when there is more to read.
    this.statusInfo.title = info
    this.statusInfo.classList.toggle('warn', info.startsWith('⚠') || info.startsWith('✕'))
  }

  private statusText(): string {
    if (this.mode === 'set') {
      const problems = checkWorld(this.world)
      const errs = problems.filter((p) => p.level === 'error')
      if (errs.length) return `✕ ${errs[0].text}`
      const ends = reachable(this.world).filter((t) => !t.next.length)
      const warn = problems.find((p) => p.level === 'warn')
      return `${this.world.tracks.length} tracks · ${routeLengthOf(this.world, this.world.start)} stages a run · ${ends.length} finish${ends.length === 1 ? '' : 'es'}${warn ? `  ⚠ ${warn.text}` : ''}`
    }
    const r = this.report()
    const t = this.track
    const bits = [`${(r.metres / 1000).toFixed(2)} km`, `${r.seconds.toFixed(0)} s flat out`, `${t.nodes.length} waypoints`]
    bits.push(r.minRadius === Infinity ? 'straight' : `tightest ${Math.round(r.minRadius)} m`)
    if (r.clamped) bits.push(`⚠ ${r.clamped} segments too tight`)
    bits.push(`${Math.round(r.climb)} m climbed, steepest ${Math.round(r.maxGrade * 100)} %`)
    if (r.waypointsFlattened) bits.push(`⚠ ${r.waypointsFlattened} waypoint${r.waypointsFlattened === 1 ? '' : 's'} too high`)
    if (r.gradeScale < 1) bits.push(`⚠ hills flattened to ${Math.round(r.gradeScale * 100)} %`)
    bits.push(`${t.scenes.length} scene${t.scenes.length === 1 ? '' : 's'}`, `${t.vibes.length} vibe${t.vibes.length === 1 ? '' : 's'}`)
    if (t.props.length) bits.push(`${t.props.length} props`)
    const s = this.sel
    if (s?.kind === 'node') {
      const n = t.nodes[s.i]
      if (n) bits.push(`· waypoint ${s.i + 1}: ${Math.round(n.y)} m up${n.bank ? ', banked' : ''}${n.cusp ? ', cusp' : ''}`)
    } else if (s?.kind === 'vibe') bits.push(`· ${vibeDef(t.vibes[s.i]?.vibe ?? 'day').name}`)
    else if (s?.kind === 'scene') bits.push(`· ${sceneDef(t.scenes[s.i]?.scene ?? 'coast').name}`)
    return bits.join(' · ')
  }

  private drawSet(): void {
    const c = this.sizeCanvas(this.plan)
    const w = this.plan.clientWidth
    const h = this.plan.clientHeight
    c.fillStyle = '#120820'
    c.fillRect(0, 0, w, h)
    // Grid.
    const s = this.setView.scale
    c.strokeStyle = 'rgba(255,255,255,0.05)'
    c.lineWidth = 1
    const step = SET_CELL * s
    if (step > 12) {
      const o = this.setToPx(0, 0)
      for (let x = o.x % step; x < w; x += step) {
        c.beginPath()
        c.moveTo(x, 0)
        c.lineTo(x, h)
        c.stroke()
      }
      for (let y = o.y % step; y < h; y += step) {
        c.beginPath()
        c.moveTo(0, y)
        c.lineTo(w, y)
        c.stroke()
      }
    }
    // Links behind the boxes.
    for (const t of this.world.tracks) {
      for (let slot = 0; slot < t.next.length; slot++) {
        const pts = this.linkPoints(t, slot)
        if (!pts) continue
        const selected = this.sel?.kind === 'link' && this.sel.from === t.id && this.sel.slot === slot
        c.strokeStyle = selected ? '#ffd45f' : t.next.length === 2 ? (slot === 0 ? '#5cc8ff' : '#ff8ad0') : 'rgba(255,255,255,0.5)'
        c.lineWidth = selected ? 3.5 : 2.2
        c.beginPath()
        c.moveTo(pts[0].x, pts[0].y)
        c.bezierCurveTo(pts[1].x, pts[1].y, pts[2].x, pts[2].y, pts[3].x, pts[3].y)
        c.stroke()
        // Arrow head, and L/R on a fork so you know which way the split reads.
        const tip = bezierAt(pts, 1)
        const before = bezierAt(pts, 0.94)
        arrowHead(c, before, tip, c.strokeStyle as string)
        if (t.next.length === 2 && s > 0.42) {
          const mid = bezierAt(pts, 0.5)
          c.fillStyle = c.strokeStyle as string
          c.font = '600 12px system-ui, sans-serif'
          c.textAlign = 'center'
          c.textBaseline = 'middle'
          c.fillText(slot === 0 ? 'LEFT' : 'RIGHT', mid.x, mid.y - 10)
        }
      }
    }
    // Boxes.
    for (const t of this.world.tracks) {
      const o = this.setToPx(t.ui?.x ?? 0, t.ui?.y ?? 0)
      const bw = BOX_W * s
      const bh = BOX_H * s
      const isStart = t.id === this.world.start
      const isEnd = !t.next.length
      const selected = this.sel?.kind === 'track' && this.sel.id === t.id
      const seq = <T,>(xs: T[], name: (x: T) => string) => (xs.length > 2 ? `${name(xs[0])} → … → ${name(xs[xs.length - 1])}` : xs.map(name).join(' → ') || '—')
      const sceneSeq = seq([...t.scenes].sort((a, b) => a.at - b.at), (x) => sceneDef(x.scene).name)
      const vibeSeq = seq([...t.vibes].sort((a, b) => a.at - b.at), (x) => vibeDef(x.vibe).name)
      const vibe = vibeDef(t.vibes[0]?.vibe ?? 'day')
      c.fillStyle = hex(vibe.skyBottom)
      roundRect(c, o.x, o.y, bw, bh, 6 * s)
      c.fill()
      c.fillStyle = 'rgba(0,0,0,0.45)'
      roundRect(c, o.x, o.y, bw, bh, 6 * s)
      c.fill()
      c.strokeStyle = selected ? '#ffd45f' : t.id === this.trackId ? '#ff8a3c' : 'rgba(255,255,255,0.28)'
      c.lineWidth = selected ? 3 : 1.6
      roundRect(c, o.x, o.y, bw, bh, 6 * s)
      c.stroke()
      // A ribbon of the track's own shape inside the box.
      const path = buildPath(t.nodes)
      const poly = path.polyline(Math.max(6, path.length / 60))
      if (poly.length > 1) {
        const xs = poly.map((p) => p.x)
        const zs = poly.map((p) => p.z)
        const x0 = Math.min(...xs)
        const x1 = Math.max(...xs)
        const z0 = Math.min(...zs)
        const z1 = Math.max(...zs)
        const k = Math.min((bw - 16 * s) / Math.max(1, x1 - x0), (bh - 30 * s) / Math.max(1, z1 - z0))
        c.strokeStyle = 'rgba(255,255,255,0.55)'
        c.lineWidth = 1.6
        c.beginPath()
        poly.forEach((pt, i) => {
          const px = o.x + bw / 2 + (pt.x - (x0 + x1) / 2) * k
          const py = o.y + bh / 2 + 6 * s - (pt.z - (z0 + z1) / 2) * k
          if (i) c.lineTo(px, py)
          else c.moveTo(px, py)
        })
        c.stroke()
      }
      if (s > 0.34) {
        c.fillStyle = '#ffffff'
        c.font = `600 ${Math.round(13 * Math.min(1.2, s))}px system-ui, sans-serif`
        c.textAlign = 'left'
        c.textBaseline = 'top'
        c.fillText(`${isStart ? '▶ ' : ''}${t.name}${isEnd ? ' ⚑' : ''}`, o.x + 8 * s, o.y + 6 * s)
        c.fillStyle = 'rgba(255,255,255,0.55)'
        c.font = `${Math.round(10 * Math.min(1.2, s))}px system-ui, sans-serif`
        c.fillText(`${sceneSeq} · ${vibeSeq} · ${(path.length / 1000).toFixed(1)} km`, o.x + 8 * s, o.y + bh - 14 * s)
      }
      // Exit port.
      c.fillStyle = t.next.length >= 2 ? 'rgba(255,255,255,0.3)' : '#3f9a3a'
      c.beginPath()
      c.arc(o.x + bw, o.y + bh / 2, 6, 0, Math.PI * 2)
      c.fill()
      c.strokeStyle = 'rgba(0,0,0,0.6)'
      c.lineWidth = 1
      c.stroke()
    }
    // A link being dragged.
    const d = this.drag
    if (d?.kind === 'link') {
      const src = this.world.tracks.find((t) => t.id === d.from)
      if (src) {
        const o = this.setToPx(src.ui?.x ?? 0, src.ui?.y ?? 0)
        c.strokeStyle = '#ffd45f'
        c.lineWidth = 2.5
        c.setLineDash([6, 4])
        c.beginPath()
        c.moveTo(o.x + BOX_W * s, o.y + (BOX_H / 2) * s)
        c.lineTo(d.px, d.py)
        c.stroke()
        c.setLineDash([])
      }
    }
  }

  private drawPlan(): void {
    const c = this.sizeCanvas(this.plan)
    const w = this.plan.clientWidth
    const h = this.plan.clientHeight
    const t = this.track
    const path = this.path()
    c.fillStyle = '#101a14'
    c.fillRect(0, 0, w, h)
    // Grid, brighter every kilometre. The two axes pick their own step: with the lateral axis stretched
    // a squared-off grid would be a lie, and a grid of the right size across is what makes the stretch
    // readable — you can see at a glance that the squares are long and thin.
    const stepFor = (perMetre: number) => (100 * perMetre > 14 ? 100 : 100 * perMetre > 4 ? 500 : 1000)
    const gridStep = stepFor(this.view.scale)
    const gridStepX = stepFor(this.lateralScale)
    const o = this.toPx(0, 0)
    const stepPxX = gridStepX * this.lateralScale
    const stepPxZ = gridStep * this.view.scale
    for (let i = Math.floor(-o.x / stepPxX) - 1; i * stepPxX + o.x < w; i++) {
      const x = i * stepPxX + o.x
      c.strokeStyle = (i * gridStepX) % 1000 === 0 ? 'rgba(255,255,255,0.11)' : 'rgba(255,255,255,0.045)'
      c.beginPath()
      c.moveTo(x, 0)
      c.lineTo(x, h)
      c.stroke()
    }
    for (let i = Math.floor(-(h - o.y) / stepPxZ) - 1; o.y - i * stepPxZ > 0; i++) {
      const y = o.y - i * stepPxZ
      c.strokeStyle = (i * gridStep) % 1000 === 0 ? 'rgba(255,255,255,0.11)' : 'rgba(255,255,255,0.045)'
      c.beginPath()
      c.moveTo(0, y)
      c.lineTo(w, y)
      c.stroke()
    }

    if (path.length < 1) return
    // The road as a ribbon, coloured by the scene it is in and the vibe over it.
    const stops = [...t.scenes].sort((a, b) => a.at - b.at)
    const sceneAt = (at: number) => {
      let id = stops[0]?.scene ?? 'coast'
      for (const s of stops) if (at >= s.at) id = s.scene
      return id
    }
    const step = Math.max(3, 20 / Math.max(0.05, this.view.scale))
    const halfPx = Math.max(1.6, ROAD_HALF_WIDTH * this.view.scale)
    const sample: PathSample = { s: 0, x: 0, z: 0, y: 0, heading: 0, bank: 0 }
    const prev: PathSample = { s: 0, x: 0, z: 0, y: 0, heading: 0, bank: 0 }
    path.at(0, prev)
    for (let s = step; s <= path.length; s += step) {
      path.at(Math.min(s, path.length), sample)
      const pal = PALETTES[sceneDef(sceneAt(s / path.length)).theme.palette] ?? PALETTES.coast
      const tight = Math.abs(sample.heading - prev.heading) / Math.max(1e-6, sample.s - prev.s)
      const radius = tight > 1e-9 ? 1 / tight : Infinity
      const a = this.toPx(prev.x, prev.z)
      const b = this.toPx(sample.x, sample.z)
      c.strokeStyle = radius < MIN_RADIUS ? '#ff3b5c' : radius < EASY_RADIUS ? '#ffb03c' : hex(pal.roadA)
      c.lineWidth = halfPx * 2
      c.lineCap = 'butt'
      c.beginPath()
      c.moveTo(a.x, a.y)
      c.lineTo(b.x, b.y)
      c.stroke()
      // Banked stretches get a hatched high side.
      if (sample.bank > 0.05) {
        const hx = Math.sin(sample.heading)
        const hz = Math.cos(sample.heading)
        const side = sample.heading > prev.heading ? -1 : 1
        const e0 = this.toPx(sample.x + hz * side * ROAD_HALF_WIDTH * 1.5, sample.z - hx * side * ROAD_HALF_WIDTH * 1.5)
        c.strokeStyle = `rgba(255,212,95,${0.25 + 0.5 * sample.bank})`
        c.lineWidth = 1.5
        c.beginPath()
        c.moveTo(b.x, b.y)
        c.lineTo(e0.x, e0.y)
        c.stroke()
      }
      prev.s = sample.s
      prev.x = sample.x
      prev.z = sample.z
      prev.heading = sample.heading
      prev.bank = sample.bank
    }
    // Macro elements drawn along the road edge.
    for (let i = 0; i < t.spans.length; i++) {
      const sp = t.spans[i]
      const selected = this.sel?.kind === 'span' && this.sel.i === i
      const from = Math.min(sp.from, sp.to) * path.length
      const to = Math.max(sp.from, sp.to) * path.length
      for (const side of sp.side ? [sp.side] : [-1, 1]) {
        c.strokeStyle = SPAN_COLOUR[sp.kind]
        c.lineWidth = Math.max(1.5, halfPx * (selected ? 0.9 : 0.55))
        c.beginPath()
        let first = true
        for (let s = from; s <= to; s += Math.max(4, step / 2)) {
          path.at(Math.min(s, path.length), sample)
          const hx = Math.sin(sample.heading)
          const hz = Math.cos(sample.heading)
          const off = ROAD_HALF_WIDTH * (sp.kind === 'facades' ? 1.55 : sp.kind === 'tunnel' ? 1.6 : 1.25) * side
          const p = this.toPx(sample.x + hz * off, sample.z - hx * off)
          if (first) {
            c.moveTo(p.x, p.y)
            first = false
          } else c.lineTo(p.x, p.y)
        }
        c.stroke()
      }
    }
    // Hand-placed props.
    for (let i = 0; i < t.props.length; i++) {
      const pr = t.props[i]
      path.at(pr.at * path.length, sample)
      const hx = Math.sin(sample.heading)
      const hz = Math.cos(sample.heading)
      const lat = pr.offset * ROAD_HALF_WIDTH
      const p = this.toPx(sample.x + hz * lat, sample.z - hx * lat)
      const selected = this.sel?.kind === 'prop' && this.sel.i === i
      c.fillStyle = selected ? '#ffd45f' : '#b89aff'
      c.beginPath()
      c.arc(p.x, p.y, selected ? 5.5 : 3.5, 0, Math.PI * 2)
      c.fill()
    }
    // Crossroads.
    for (let i = 0; i < t.crossings.length; i++) {
      path.at(t.crossings[i].at * path.length, sample)
      const p = this.toPx(sample.x, sample.z)
      const hx = Math.sin(sample.heading)
      const hz = Math.cos(sample.heading)
      const arm = Math.max(ROAD_HALF_WIDTH * 2.4, 18 / this.lateralScale)
      const a = this.toPx(sample.x + hz * arm, sample.z - hx * arm)
      const b = this.toPx(sample.x - hz * arm, sample.z + hx * arm)
      c.strokeStyle = this.sel?.kind === 'crossing' && this.sel.i === i ? '#ffd45f' : '#f0e8c0'
      c.lineWidth = Math.max(2, halfPx * 0.9)
      c.beginPath()
      c.moveTo(a.x, a.y)
      c.lineTo(b.x, b.y)
      c.stroke()
      void p
    }
    // Scene and vibe markers, stood off to either side on little stalks.
    const marker = (at: number, lateral: number, colour: string, label: string, selected: boolean) => {
      path.at(Math.max(0, Math.min(path.length, at * path.length)), sample)
      const hx = Math.sin(sample.heading)
      const hz = Math.cos(sample.heading)
      const root = this.toPx(sample.x, sample.z)
      const p = this.toPx(sample.x + hz * lateral, sample.z - hx * lateral)
      c.strokeStyle = 'rgba(255,255,255,0.3)'
      c.lineWidth = 1
      c.beginPath()
      c.moveTo(root.x, root.y)
      c.lineTo(p.x, p.y)
      c.stroke()
      c.fillStyle = colour
      c.beginPath()
      c.arc(p.x, p.y, selected ? 7 : 5, 0, Math.PI * 2)
      c.fill()
      c.strokeStyle = selected ? '#ffd45f' : 'rgba(0,0,0,0.6)'
      c.lineWidth = selected ? 2.5 : 1
      c.stroke()
      if (this.view.scale > 0.06) {
        c.fillStyle = 'rgba(255,255,255,0.85)'
        c.font = '600 11px system-ui, sans-serif'
        c.textAlign = lateral > 0 ? 'left' : 'right'
        c.textBaseline = 'middle'
        c.fillText(label, p.x + (lateral > 0 ? 10 : -10), p.y)
      }
    }
    const stalk = this.markerStalk()
    for (let i = 0; i < t.vibes.length; i++) marker(t.vibes[i].at, -stalk, hex(vibeDef(t.vibes[i].vibe).skyBottom), vibeDef(t.vibes[i].vibe).name, this.sel?.kind === 'vibe' && this.sel.i === i)
    for (let i = 0; i < t.scenes.length; i++) marker(t.scenes[i].at, stalk, hex((PALETTES[sceneDef(t.scenes[i].scene).theme.palette] ?? PALETTES.coast).grassA), sceneDef(t.scenes[i].scene).name, this.sel?.kind === 'scene' && this.sel.i === i)

    // Start and finish.
    path.at(0, sample)
    const start = this.toPx(sample.x, sample.z)
    c.fillStyle = '#3f9a3a'
    c.beginPath()
    c.arc(start.x, start.y, 7, 0, Math.PI * 2)
    c.fill()
    path.at(path.length, sample)
    const end = this.toPx(sample.x, sample.z)
    c.fillStyle = t.next.length ? '#5cc8ff' : '#ffd45f'
    c.beginPath()
    c.arc(end.x, end.y, 7, 0, Math.PI * 2)
    c.fill()
    c.fillStyle = 'rgba(255,255,255,0.8)'
    c.font = '600 11px system-ui, sans-serif'
    c.textAlign = 'center'
    c.textBaseline = 'bottom'
    c.fillText('START', start.x, Math.max(24, start.y - 10))
    c.fillText(t.next.length === 2 ? 'FORK' : t.next.length ? 'ON' : 'FINISH', end.x, Math.max(24, end.y - 10))

    // Waypoints, then the selected node's handles on top.
    for (let i = 0; i < t.nodes.length; i++) {
      const n = t.nodes[i]
      const p = this.toPx(n.x, n.z)
      const selected = (this.sel?.kind === 'node' || this.sel?.kind === 'handle') && this.sel.i === i
      c.fillStyle = n.bank ? '#ffd45f' : n.cusp ? '#ff8a3c' : '#ffffff'
      c.beginPath()
      if (n.cusp) {
        c.rect(p.x - 4.5, p.y - 4.5, 9, 9)
      } else c.arc(p.x, p.y, selected ? 6 : 4.5, 0, Math.PI * 2)
      c.fill()
      c.strokeStyle = selected ? '#ffd45f' : 'rgba(0,0,0,0.55)'
      c.lineWidth = selected ? 2.5 : 1
      c.stroke()
    }
    for (const i of this.handleNodes()) {
      const n = t.nodes[i]
      if (!n) continue
      const root = this.toPx(n.x, n.z)
      for (const which of ['out', 'in'] as const) {
        const hv = which === 'out' ? handleOut(t.nodes, i) : handleIn(t.nodes, i)
        const p = this.toPx(n.x + hv.x, n.z + hv.z)
        const explicit = which === 'out' ? n.outX !== undefined : n.inX !== undefined
        c.strokeStyle = explicit ? '#25e8ff' : 'rgba(37,232,255,0.45)'
        c.lineWidth = 1.5
        c.beginPath()
        c.moveTo(root.x, root.y)
        c.lineTo(p.x, p.y)
        c.stroke()
        c.fillStyle = explicit ? '#25e8ff' : '#0f4a58'
        c.beginPath()
        c.rect(p.x - 4, p.y - 4, 8, 8)
        c.fill()
        c.strokeStyle = '#25e8ff'
        c.stroke()
      }
    }
    // A span being dragged out along the road.
    if (this.drag?.kind === 'newspan' && this.tool.kind === 'span') {
      const d = this.drag
      c.strokeStyle = SPAN_COLOUR[this.tool.id]
      c.lineWidth = 7
      c.globalAlpha = 0.6
      c.beginPath()
      let first = true
      const from = Math.min(d.from, d.to) * path.length
      const to = Math.max(d.from, d.to) * path.length
      for (let s = from; s <= to + 1; s += Math.max(4, step / 2)) {
        path.at(Math.min(s, path.length), sample)
        const p = this.toPx(sample.x, sample.z)
        if (first) {
          c.moveTo(p.x, p.y)
          first = false
        } else c.lineTo(p.x, p.y)
      }
      c.stroke()
      c.globalAlpha = 1
    }
    // A scale bar per axis, because everything here is in real metres and the two axes are not the
    // same size. The corner they share is the origin of both.
    const label = (m: number) => (m >= 1000 ? `${m / 1000} km` : `${m} m`)
    const alongM = gridStep * (gridStep * this.view.scale < 60 ? 5 : 1)
    const acrossM = gridStepX * (gridStepX * this.lateralScale < 60 ? 5 : 1)
    c.strokeStyle = 'rgba(255,255,255,0.6)'
    c.lineWidth = 2
    c.beginPath()
    c.moveTo(14, h - 16)
    c.lineTo(14 + acrossM * this.lateralScale, h - 16)
    c.moveTo(14, h - 16)
    c.lineTo(14, h - 16 - alongM * this.view.scale)
    c.stroke()
    c.fillStyle = 'rgba(255,255,255,0.7)'
    c.font = '11px system-ui, sans-serif'
    c.textAlign = 'left'
    c.textBaseline = 'bottom'
    c.fillText(`${label(acrossM)} across`, 14, h - 20)
    c.textBaseline = 'top'
    c.fillText(`${label(alongM)} along`, 20, h - 16 - alongM * this.view.scale)
    if (this.view.stretch > 1.05) {
      c.fillStyle = 'rgba(255,212,95,0.75)'
      c.textAlign = 'right'
      c.textBaseline = 'bottom'
      c.fillText(`across ×${this.view.stretch.toFixed(this.view.stretch < 10 ? 1 : 0)}`, w - 14, h - 14)
    }
    if (this.hover.near && this.hover.s >= 0) {
      c.textAlign = 'right'
      c.fillText(`${Math.round(this.hover.s)} m · ${(this.hover.lateral / ROAD_HALF_WIDTH).toFixed(2)} road widths out`, w - 14, h - 20)
    }
  }

  private drawProfile(): void {
    const c = this.sizeCanvas(this.profile, PROFILE_H)
    const w = this.profile.clientWidth
    const path = this.path()
    const t = this.track
    c.fillStyle = '#0e1420'
    c.fillRect(0, 0, w, PROFILE_H)
    c.fillStyle = 'rgba(255,255,255,0.4)'
    c.font = '10px system-ui, sans-serif'
    c.textAlign = 'left'
    c.textBaseline = 'top'
    c.fillText('ELEVATION — drag a waypoint up or down (Q / E too)', STRIP_MARGIN, 3)
    if (path.length < 1) return
    // Grade line at zero.
    const zeroY = this.profileY(0)
    c.strokeStyle = 'rgba(255,255,255,0.18)'
    c.setLineDash([4, 4])
    c.beginPath()
    c.moveTo(STRIP_MARGIN, zeroY)
    c.lineTo(w - STRIP_MARGIN, zeroY)
    c.stroke()
    c.setLineDash([])
    // The road the car will actually drive — swell, end levelling and gradient guarantee
    // included — coloured by how steep each stretch is: amber past STEEP_GRADE, red at the
    // limit. Taken straight from the compiler so the strip cannot lie about the game.
    const ys = this.report().profile
    const roadAt = (at: number) => ys[Math.max(0, Math.min(ys.length - 1, Math.round(at * (ys.length - 1))))]
    const steps = Math.min(360, Math.max(60, ys.length - 1))
    c.lineWidth = 2
    let prevPx = this.stripX(0, this.profile)
    let prevPy = this.profileY(roadAt(0))
    for (let i = 1; i <= steps; i++) {
      const at = i / steps
      const px = this.stripX(at, this.profile)
      const py = this.profileY(roadAt(at))
      const grade = Math.abs(roadAt(at) - roadAt(at - 1 / steps)) / Math.max(0.001, path.length / steps)
      c.strokeStyle = grade >= MAX_GRADE * 0.95 ? '#ff3b5c' : grade > STEEP_GRADE ? '#ffb03c' : '#5cc8ff'
      c.beginPath()
      c.moveTo(prevPx, prevPy)
      c.lineTo(px, py)
      c.stroke()
      prevPx = px
      prevPy = py
    }
    // Waypoint handles, drawn where the road ended up. A ring means the height asked for
    // was steeper than the road climbs and had to be pulled back (only a pasted file can
    // get here — dragging is held to the limit as you go).
    for (let i = 0; i < t.nodes.length; i++) {
      const at = path.length > 0 ? path.nodeS[i] / path.length : 0
      const px = this.stripX(at, this.profile)
      const road = roadAt(at)
      const py = this.profileY(road)
      const asked = path.requestedY(i)
      const selected = (this.sel?.kind === 'node' || this.sel?.kind === 'handle') && this.sel.i === i
      // A ring means this waypoint asked for a climb the road cannot make. It deliberately
      // does not fire for the uniform flattening, which affects every waypoint equally and
      // is reported in the status line instead.
      if (Math.abs(asked - path.nodeY(i)) > 0.5) {
        c.strokeStyle = '#ff3b5c'
        c.lineWidth = 1.5
        c.setLineDash([3, 3])
        c.beginPath()
        c.moveTo(px, py)
        c.lineTo(px, this.profileY(asked))
        c.stroke()
        c.setLineDash([])
        c.beginPath()
        c.arc(px, py, 7.5, 0, Math.PI * 2)
        c.stroke()
      }
      c.fillStyle = selected ? '#ffd45f' : '#ffffff'
      c.beginPath()
      c.arc(px, py, selected ? 5.5 : 4, 0, Math.PI * 2)
      c.fill()
      if (selected) {
        c.fillStyle = '#ffd45f'
        c.font = '600 10px system-ui, sans-serif'
        c.textAlign = 'center'
        c.textBaseline = 'bottom'
        c.fillText(`${Math.round(road)} m`, px, py - 7)
      }
    }
  }

  private drawTimeline(): void {
    const c = this.sizeCanvas(this.timeline, TIMELINE_H)
    const w = this.timeline.clientWidth
    const t = this.track
    const path = this.path()
    c.fillStyle = '#0e1420'
    c.fillRect(0, 0, w, TIMELINE_H)
    const x0 = STRIP_MARGIN
    const x1 = w - STRIP_MARGIN
    const label = (text: string, y: number) => {
      c.fillStyle = 'rgba(255,255,255,0.35)'
      c.font = '9px system-ui, sans-serif'
      c.textAlign = 'left'
      c.textBaseline = 'top'
      c.fillText(text, 3, y)
    }
    // Scenes.
    const scenes = [...t.scenes].sort((a, b) => a.at - b.at)
    for (let i = 0; i < scenes.length; i++) {
      const from = this.stripX(i === 0 ? 0 : scenes[i].at, this.timeline)
      const to = i + 1 < scenes.length ? this.stripX(scenes[i + 1].at, this.timeline) : x1
      const pal = PALETTES[sceneDef(scenes[i].scene).theme.palette] ?? PALETTES.coast
      c.fillStyle = hex(pal.grassA)
      c.fillRect(from, 6, Math.max(1, to - from), 18)
      c.fillStyle = 'rgba(0,0,0,0.55)'
      c.fillRect(from, 6, Math.max(1, to - from), 18)
      c.fillStyle = '#ffffff'
      c.font = '10px system-ui, sans-serif'
      c.textAlign = 'left'
      c.textBaseline = 'middle'
      if (to - from > 40) c.fillText(sceneDef(scenes[i].scene).name, from + 4, 15)
      const selected = this.sel?.kind === 'scene' && t.scenes[this.sel.i] === scenes[i]
      c.strokeStyle = selected ? '#ffd45f' : 'rgba(255,255,255,0.35)'
      c.lineWidth = selected ? 3 : 1
      c.beginPath()
      c.moveTo(from, 4)
      c.lineTo(from, 26)
      c.stroke()
    }
    label('SCENE', 7)
    // Vibes, as a gradient of their sky colours so a slide reads at a glance.
    const vibes = [...t.vibes].sort((a, b) => a.at - b.at)
    const grad = c.createLinearGradient(x0, 0, x1, 0)
    const vibeColourAt = (at: number): VibeDef => {
      let cur = vibeDef(vibes[0]?.vibe ?? 'day')
      for (let i = 1; i < vibes.length; i++) {
        const fade = Math.max(0.001, vibes[i].fade ?? VIBE_FADE)
        if (at <= vibes[i].at - fade / 2) break
        if (at >= vibes[i].at + fade / 2) cur = vibeDef(vibes[i].vibe)
        else {
          const k = (at - (vibes[i].at - fade / 2)) / fade
          const a = cur
          const b = vibeDef(vibes[i].vibe)
          return { ...b, skyBottom: mix(a.skyBottom, b.skyBottom, k) }
        }
      }
      return cur
    }
    for (let k = 0; k <= 20; k++) grad.addColorStop(k / 20, hex(vibeColourAt(k / 20).skyBottom))
    c.fillStyle = grad
    c.fillRect(x0, 32, x1 - x0, 18)
    for (let i = 0; i < vibes.length; i++) {
      const x = this.stripX(vibes[i].at, this.timeline)
      const selected = this.sel?.kind === 'vibe' && t.vibes[this.sel.i] === vibes[i]
      c.strokeStyle = selected ? '#ffd45f' : 'rgba(0,0,0,0.7)'
      c.lineWidth = selected ? 3 : 1.5
      c.beginPath()
      c.moveTo(x, 30)
      c.lineTo(x, 52)
      c.stroke()
      c.fillStyle = '#ffffff'
      c.font = '10px system-ui, sans-serif'
      c.textAlign = 'left'
      c.textBaseline = 'middle'
      c.fillText(vibeDef(vibes[i].vibe).name, x + 4, 41)
      // The fade window.
      const fade = (vibes[i].fade ?? VIBE_FADE) * (x1 - x0)
      if (i > 0) {
        c.strokeStyle = 'rgba(255,255,255,0.5)'
        c.lineWidth = 1
        c.beginPath()
        c.moveTo(x - fade / 2, 52)
        c.lineTo(x + fade / 2, 52)
        c.stroke()
      }
    }
    label('VIBE', 33)
    // Macro elements.
    const rows = this.spanRows()
    for (let i = 0; i < t.spans.length; i++) {
      const sp = t.spans[i]
      const from = this.stripX(Math.min(sp.from, sp.to), this.timeline)
      const to = this.stripX(Math.max(sp.from, sp.to), this.timeline)
      const y = this.spanRowY(rows[i])
      const selected = this.sel?.kind === 'span' && this.sel.i === i
      c.fillStyle = SPAN_COLOUR[sp.kind]
      c.fillRect(from, y - 5, Math.max(3, to - from), 10)
      if (selected) {
        c.strokeStyle = '#ffd45f'
        c.lineWidth = 2
        c.strokeRect(from - 1, y - 6, Math.max(3, to - from) + 2, 12)
      }
      if (to - from > 46) {
        c.fillStyle = 'rgba(0,0,0,0.8)'
        c.font = '9px system-ui, sans-serif'
        c.textAlign = 'left'
        c.textBaseline = 'middle'
        c.fillText(`${SPAN_NAME[sp.kind]}${sp.side ? (sp.side < 0 ? ' L' : ' R') : ''}`, from + 3, y)
      }
    }
    label('MACRO', 58)
    // Points: crossings and props.
    for (const cr of t.crossings) {
      const x = this.stripX(cr.at, this.timeline)
      c.strokeStyle = '#f0e8c0'
      c.lineWidth = 2
      c.beginPath()
      c.moveTo(x, 104)
      c.lineTo(x, 116)
      c.stroke()
    }
    for (let i = 0; i < t.props.length; i++) {
      const x = this.stripX(t.props[i].at, this.timeline)
      const selected = this.sel?.kind === 'prop' && this.sel.i === i
      c.fillStyle = selected ? '#ffd45f' : '#b89aff'
      c.fillRect(x - 1.5, t.props[i].offset < 0 ? 104 : 110, 3, 6)
    }
    label('PLACED', 104)
    // Ruler.
    c.strokeStyle = 'rgba(255,255,255,0.2)'
    c.lineWidth = 1
    for (let k = 0; k <= 10; k++) {
      const x = this.stripX(k / 10, this.timeline)
      c.beginPath()
      c.moveTo(x, TIMELINE_H - 4)
      c.lineTo(x, TIMELINE_H)
      c.stroke()
    }
    c.fillStyle = 'rgba(255,255,255,0.35)'
    c.font = '9px system-ui, sans-serif'
    c.textAlign = 'right'
    c.textBaseline = 'bottom'
    c.fillText(`${(path.length / 1000).toFixed(2)} km`, x1, TIMELINE_H - 5)
  }
}

/** Tightest radius the compiled road would have between two arc positions. */
function worstRadius(path: TrackPath, from: number, to: number): number {
  let worst = Infinity
  let prev = path.headingAt(from)
  for (let s = from + SEG_LENGTH; s <= to; s += SEG_LENGTH) {
    const h = path.headingAt(Math.min(s, path.length))
    const d = Math.abs(h - prev)
    if (d > 1e-9) worst = Math.min(worst, SEG_LENGTH / d)
    prev = h
  }
  return worst
}

function mix(a: number, b: number, t: number): number {
  const r = Math.round(((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * t)
  const g = Math.round(((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * t)
  const bl = Math.round((a & 255) + ((b & 255) - (a & 255)) * t)
  return (r << 16) | (g << 8) | bl
}

function bezierAt(p: readonly { x: number; y: number }[], t: number): { x: number; y: number } {
  const u = 1 - t
  const b0 = u * u * u
  const b1 = 3 * u * u * t
  const b2 = 3 * u * t * t
  const b3 = t * t * t
  return { x: p[0].x * b0 + p[1].x * b1 + p[2].x * b2 + p[3].x * b3, y: p[0].y * b0 + p[1].y * b1 + p[2].y * b2 + p[3].y * b3 }
}

function arrowHead(c: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }, colour: string): void {
  const a = Math.atan2(to.y - from.y, to.x - from.x)
  c.fillStyle = colour
  c.beginPath()
  c.moveTo(to.x, to.y)
  c.lineTo(to.x - Math.cos(a - 0.4) * 11, to.y - Math.sin(a - 0.4) * 11)
  c.lineTo(to.x - Math.cos(a + 0.4) * 11, to.y - Math.sin(a + 0.4) * 11)
  c.closePath()
  c.fill()
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2))
  c.beginPath()
  c.moveTo(x + rr, y)
  c.arcTo(x + w, y, x + w, y + h, rr)
  c.arcTo(x + w, y + h, x, y + h, rr)
  c.arcTo(x, y + h, x, y, rr)
  c.arcTo(x, y, x + w, y, rr)
  c.closePath()
}

/** Re-exported so the menus can talk about the curvature limit without importing the compiler. */
export const EDITOR_LIMITS = { MAX_CURVE, MIN_RADIUS, EASY_RADIUS, radiusToCurve, curveToRadius }
