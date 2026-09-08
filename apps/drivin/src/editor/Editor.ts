// The track editor: an unbounded grid you pan and zoom, a palette of pieces,
// click to place with the current rotation and level, modern selection and
// modifier conventions (see HINTS below), a right-click menu, undo, and a
// Test Drive button that hands the track to the game.
//
// Conventions (⌘ on a Mac, Ctrl elsewhere):
//   click empty      place the primed piece      click piece        select (drag to move)
//   ⌘ click          add / remove from selection ⇧ click            select the run between the last pick and this one
//   ⌥ click / Del    delete under the pointer    ⌘⇧ click           force-insert over whatever is there
//   ⌘⌥ click         rotate the piece            ⇧⌥ click / ⇧⌥ right-click   raise / lower its level
//   right-click      menu                        Z / X (or R)       rotate the primed piece or the selection
//   Q / E            level − / +                 ⌘Z / ⌘⇧Z          undo / redo
//   wheel            zoom under the pointer      middle-drag, space-drag, ⇧wheel   pan
//   click outside    grow the grid to reach that cell (the world is as big as you make it)
//   G                landscape mode: drag to raise, ⌥/right-drag to lower, ⇧-drag to flatten; [ ] brush size

import { PIECES, PIECE_BY_TYPE, makePathPoint, rotateLocal, rotatedSize, type PieceDef } from '../sim/pieces'
import { CELL } from '../sim/Tuning'
import { Track, portStatus, type PlacedPiece, type TrackData } from '../sim/Track'
import type { TrackStore } from '../app/TrackStore'
import { brushTerrain, flatTerrain, flattenUnderPieces, resizeTerrain, sampleHeight, terrainIndex } from '../sim/terrain'
import { LEVEL_H } from '../sim/Tuning'

const GROUP_COLORS: Record<PieceDef['group'], string> = { basic: '#2f6b8a', curves: '#3b8a5c', stunts: '#a3552a', flow: '#7a4aa0', scenery: '#4a7a3a' }
const DECOR_COLORS: Record<string, string> = { water: '#2f7fbf', trees: '#2f7a2c', building: '#8a8a94', gas: '#c0703a' }
const LEVEL_TINT = ['', '#ffc857', '#ff9a3c', '#ff6a5c', '#ff5fd2', '#b08cff', '#6ab8ff']
const MAX_SIZE = 200
const MIN_SCALE = 6
const MAX_SCALE = 160
const UNDO_DEPTH = 60
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = IS_MAC ? '⌘' : 'Ctrl'
const TERRAIN_HINTS = 'drag raise · ⌥-drag / right-drag lower · ⇧-drag flatten to the primed level · [ ] brush · G back to pieces'
const HINTS = `${MOD}-click multi · ⇧-click range · ⌥-click delete · ${MOD}⇧ force insert · ${MOD}⌥ rotate · ⇧⌥ click/right-click raise/lower · Z X rotate · Q E level · wheel zoom · middle-drag pan · right-click menu`

export interface EditorCallbacks {
  onTest(data: TrackData): void
  onExit(): void
}

interface Cell {
  x: number
  z: number
}

interface DialogButton {
  label: string
  value: string
  primary?: boolean
}

export class Editor {
  readonly el: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly status: HTMLElement
  private readonly title: HTMLElement
  private readonly palette: HTMLElement
  private readonly loadSelect: HTMLSelectElement
  private data: TrackData = { name: 'Untitled', size: 16, pieces: [] }
  private currentId: string | null = null
  private selectedType = 'straight'
  private rot = 0
  private level = 0
  /** World cell under the pointer (may be outside the grid), or null when the pointer left the canvas. */
  private hover: Cell | null = null
  private selection = new Set<number>()
  /** Last piece picked by a plain or ⌘ click: the start of a ⇧-click run. */
  private anchor = -1
  private dirty = true
  private visible = false
  private spaceHeld = false
  // View: world cell coordinates at the canvas centre and pixels per cell.
  private view = { cx: 8, cz: 8, scale: 40 }
  private pan: { px: number; py: number; cx: number; cz: number } | null = null
  private drag: { start: Cell; indices: number[]; origin: { x: number; z: number }[]; dx: number; dz: number; moved: boolean } | null = null
  private undoStack: string[] = []
  private redoStack: string[] = []
  private menu: HTMLElement | null = null
  /** Landscape sculpting instead of piece placement. */
  private mode: 'pieces' | 'terrain' = 'pieces'
  private brush = 2
  private sculpt: { kind: 'raise' | 'lower' | 'flatten' } | null = null
  private readonly store: TrackStore
  private readonly cb: EditorCallbacks

  constructor(parent: HTMLElement, store: TrackStore, cb: EditorCallbacks) {
    this.store = store
    this.cb = cb
    this.el = document.createElement('div')
    this.el.className = 'editor hidden'
    this.el.innerHTML = `
      <div class="toolbar">
        <span class="title" data-title>Untitled</span>
        <button data-act="rename" title="Rename this track">Rename</button>
        <button data-act="new">New</button>
        <button data-act="save" title="${MOD}S">Save</button>
        <select data-load><option value="">Load…</option></select>
        <button data-act="delete-track" title="Delete the loaded user track">Delete</button>
        <span class="sep"></span>
        <button data-act="undo" title="${MOD}Z">↶</button><button data-act="redo" title="${MOD}⇧Z">↷</button>
        <span class="sep"></span>
        <button data-act="zoom-" title="−">−</button><button data-act="zoom-fit" title="0">Fit</button><button data-act="zoom+" title="+">+</button>
        <span class="sep"></span>
        <button data-act="rotate-" title="Z">↺</button><button data-act="rotate" title="X / R">↻</button>
        <button data-act="level-" title="Q">Level −</button><span data-level>L0</span><button data-act="level+" title="E">Level +</button>
        <span class="sep"></span>
        <button data-act="mode" data-mode title="G">⛰ Landscape</button>
        <button data-act="brush-" title="[">[</button><span data-brush>brush 2</span><button data-act="brush+" title="]">]</button>
        <span class="sep"></span>
        <button data-act="export">Export JSON</button>
        <label class="import">Import<input type="file" accept="application/json" hidden /></label>
        <span class="sep"></span>
        <button data-act="test" class="primary" title="T">▶ Test drive</button>
        <button data-act="exit" title="Esc">Menu</button>
      </div>
      <div class="body">
        <div class="palette"></div>
        <canvas class="grid"></canvas>
      </div>
      <div class="status"></div>
    `
    parent.appendChild(this.el)
    this.canvas = this.el.querySelector('canvas')!
    this.ctx = this.canvas.getContext('2d')!
    this.status = this.el.querySelector('.status')!
    this.title = this.el.querySelector('[data-title]')!
    this.palette = this.el.querySelector('.palette')!
    this.loadSelect = this.el.querySelector('[data-load]')!
    this.buildPalette()
    this.el.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act
      if (act) void this.action(act)
    })
    this.loadSelect.addEventListener('change', () => {
      const id = this.loadSelect.value
      if (id) this.load(id)
      this.loadSelect.value = ''
    })
    const file = this.el.querySelector<HTMLInputElement>('.import input')!
    file.addEventListener('change', () => {
      const f = file.files?.[0]
      if (!f) return
      f.text().then((txt) => {
        try {
          const d = JSON.parse(txt) as TrackData
          if (!Array.isArray(d.pieces)) throw new Error('bad')
          this.setData(d, null)
        } catch {
          this.flash('Not a track file')
        }
        file.value = ''
      })
    })
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e))
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e))
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e))
    this.canvas.addEventListener('pointerleave', () => {
      this.hover = null
      this.dirty = true
    })
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false })
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      if (this.mode === 'terrain') return
      if (!(e.shiftKey && e.altKey)) this.openMenu(e)
    })
    window.addEventListener('keydown', (e) => this.onKey(e))
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') this.spaceHeld = false
    })
    window.addEventListener('resize', () => (this.dirty = true))
    window.addEventListener('pointerdown', (e) => {
      if (this.menu && !this.menu.contains(e.target as Node)) this.closeMenu()
    })
  }

  show(): void {
    this.visible = true
    this.el.classList.remove('hidden')
    this.refreshLoadList()
    this.fit()
    this.dirty = true
  }

  hide(): void {
    this.visible = false
    this.closeMenu()
    this.el.classList.add('hidden')
  }

  get isVisible(): boolean {
    return this.visible
  }

  get current(): TrackData {
    return this.data
  }

  setData(d: TrackData, id: string | null): void {
    this.data = structuredClone(d)
    this.currentId = id
    this.title.textContent = this.data.name
    this.selection.clear()
    this.anchor = -1
    this.undoStack = []
    this.redoStack = []
    this.fit()
    this.dirty = true
  }

  /** Called every frame; redraws only when something changed. */
  tick(): void {
    if (!this.visible || !this.dirty) return
    this.dirty = false
    this.draw()
  }

  // --- palette / load / save ------------------------------------------------------

  private buildPalette(): void {
    const groups: PieceDef['group'][] = ['basic', 'curves', 'stunts', 'flow', 'scenery']
    for (const g of groups) {
      const h = document.createElement('h3')
      h.textContent = g.toUpperCase()
      this.palette.appendChild(h)
      for (const def of PIECES.filter((p) => p.group === g)) {
        const b = document.createElement('button')
        b.className = 'piece' + (def.type === this.selectedType ? ' selected' : '')
        b.dataset.type = def.type
        const icon = document.createElement('canvas')
        icon.width = 48
        icon.height = 48
        drawPieceIcon(icon, def)
        b.appendChild(icon)
        const label = document.createElement('span')
        label.textContent = def.label
        b.appendChild(label)
        b.addEventListener('click', () => {
          this.selectedType = def.type
          this.rot = 0
          for (const x of this.palette.querySelectorAll('.piece')) x.classList.toggle('selected', x === b)
          this.dirty = true
        })
        this.palette.appendChild(b)
      }
    }
  }

  private refreshLoadList(): void {
    this.loadSelect.innerHTML = '<option value="">Load…</option>'
    for (const t of this.store.list()) {
      const o = document.createElement('option')
      o.value = t.id
      o.textContent = (t.builtin ? '★ ' : '') + t.name
      this.loadSelect.appendChild(o)
    }
  }

  private load(id: string): void {
    const d = this.store.get(id)
    if (d) this.setData(d, id.startsWith('user') ? id : null)
  }

  private nameTaken(name: string): boolean {
    const n = name.trim().toLowerCase()
    return this.store.list().some((t) => t.name.trim().toLowerCase() === n && t.id !== this.currentId)
  }

  private async save(): Promise<void> {
    if (this.currentId) {
      const choice = await this.dialog(`Save changes to “${this.data.name}”?`, [
        { label: 'Save over', value: 'over', primary: true },
        { label: 'Save as…', value: 'as' },
        { label: 'Cancel', value: 'cancel' },
      ])
      if (choice === 'cancel') return
      if (choice === 'over') {
        this.store.save(this.data, this.currentId)
        this.refreshLoadList()
        this.flash(new Track(this.data).valid ? 'Saved' : 'Saved (track has errors)')
        return
      }
    }
    await this.saveAs()
  }

  private async saveAs(): Promise<void> {
    let name = this.data.name === 'Untitled' ? '' : this.data.name
    for (;;) {
      const r = await this.dialog('Save as', [{ label: 'Save', value: 'ok', primary: true }, { label: 'Cancel', value: 'cancel' }], { placeholder: 'Track title', value: name })
      if (r === 'cancel') return
      name = (this.dialogText ?? '').trim()
      if (!name) {
        this.flash('A title is needed')
        continue
      }
      // Titles are unique: a new save with a taken title is refused rather than silently duplicated.
      if (this.store.list().some((t) => t.name.trim().toLowerCase() === name.toLowerCase())) {
        this.flash(`“${name}” already exists — pick another title`)
        continue
      }
      break
    }
    this.data.name = name
    this.title.textContent = name
    this.currentId = this.store.save(this.data)
    this.refreshLoadList()
    this.flash(new Track(this.data).valid ? `Saved “${name}”` : `Saved “${name}” (track has errors)`)
  }

  private async rename(): Promise<void> {
    const r = await this.dialog('Rename track', [{ label: 'Rename', value: 'ok', primary: true }, { label: 'Cancel', value: 'cancel' }], { placeholder: 'Track title', value: this.data.name })
    if (r === 'cancel') return
    const name = (this.dialogText ?? '').trim()
    if (!name) return
    if (this.nameTaken(name)) {
      this.flash(`“${name}” already exists`)
      return
    }
    this.data.name = name
    this.title.textContent = name
    if (this.currentId) {
      this.store.save(this.data, this.currentId)
      this.refreshLoadList()
    }
  }

  private dialogText: string | null = null

  /** A small modal with buttons (and optionally a text field); resolves with the chosen button's value. */
  private dialog(message: string, buttons: DialogButton[], input?: { placeholder: string; value: string }): Promise<string> {
    this.closeMenu()
    return new Promise((resolve) => {
      const back = document.createElement('div')
      back.className = 'editor-dialog-back'
      const box = document.createElement('div')
      box.className = 'editor-dialog'
      const msg = document.createElement('p')
      msg.textContent = message
      box.appendChild(msg)
      let field: HTMLInputElement | null = null
      if (input) {
        field = document.createElement('input')
        field.type = 'text'
        field.placeholder = input.placeholder
        field.value = input.value
        field.spellcheck = false
        field.addEventListener('keydown', (e) => {
          e.stopPropagation()
          if (e.key === 'Enter') finish(buttons.find((b) => b.primary)?.value ?? buttons[0].value)
          if (e.key === 'Escape') finish('cancel')
        })
        box.appendChild(field)
      }
      const row = document.createElement('div')
      row.className = 'buttons'
      for (const b of buttons) {
        const btn = document.createElement('button')
        btn.textContent = b.label
        if (b.primary) btn.className = 'primary'
        btn.addEventListener('click', () => finish(b.value))
        row.appendChild(btn)
      }
      box.appendChild(row)
      back.appendChild(box)
      this.el.appendChild(back)
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          finish('cancel')
        }
      }
      back.addEventListener('keydown', onKey)
      const finish = (v: string) => {
        this.dialogText = field ? field.value : null
        back.remove()
        resolve(v)
      }
      if (field) {
        field.focus()
        field.select()
      } else (row.querySelector('button.primary') as HTMLButtonElement | null)?.focus()
    })
  }

  // --- actions -----------------------------------------------------------------------

  private async action(act: string): Promise<void> {
    switch (act) {
      case 'new':
        this.setData({ name: 'Untitled', size: 16, pieces: [] }, null)
        break
      case 'save':
        await this.save()
        break
      case 'rename':
        await this.rename()
        break
      case 'delete-track':
        if (this.currentId) {
          const r = await this.dialog(`Delete “${this.data.name}” from your saved tracks?`, [{ label: 'Delete', value: 'ok', primary: true }, { label: 'Cancel', value: 'cancel' }])
          if (r !== 'ok') break
          this.store.remove(this.currentId)
          this.currentId = null
          this.refreshLoadList()
          this.flash('Deleted saved track')
        }
        break
      case 'undo':
        this.undo()
        break
      case 'redo':
        this.redo()
        break
      case 'zoom-':
        this.zoomBy(1 / 1.25)
        break
      case 'zoom+':
        this.zoomBy(1.25)
        break
      case 'zoom-fit':
        this.fit()
        break
      case 'mode':
        this.mode = this.mode === 'pieces' ? 'terrain' : 'pieces'
        if (this.mode === 'terrain') this.ensureTerrain()
        this.selection.clear()
        break
      case 'brush-':
        this.brush = Math.max(1, this.brush - 1)
        break
      case 'brush+':
        this.brush = Math.min(8, this.brush + 1)
        break
      case 'rotate':
        this.rotate(1)
        break
      case 'rotate-':
        this.rotate(-1)
        break
      case 'level-':
        this.changeLevel(-1)
        break
      case 'level+':
        this.changeLevel(1)
        break
      case 'export': {
        const json = JSON.stringify(this.data)
        void navigator.clipboard?.writeText(json).catch(() => {})
        const blob = new Blob([json], { type: 'application/json' })
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = `${this.data.name.replace(/\W+/g, '-').toLowerCase() || 'track'}.json`
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 1000)
        this.flash('Exported (also copied to clipboard)')
        break
      }
      case 'test':
        this.test()
        break
      case 'exit':
        this.cb.onExit()
        break
    }
    this.syncToolbar()
    this.dirty = true
  }

  private syncToolbar(): void {
    ;(this.el.querySelector('[data-level]') as HTMLElement).textContent = `L${this.level}`
    ;(this.el.querySelector('[data-brush]') as HTMLElement).textContent = `brush ${this.brush}`
    const modeBtn = this.el.querySelector('[data-mode]') as HTMLElement
    modeBtn.classList.toggle('active', this.mode === 'terrain')
    modeBtn.textContent = this.mode === 'terrain' ? '⛰ Landscape ✓' : '⛰ Landscape'
  }

  /** The heightmap, created flat on first use. */
  private ensureTerrain(): number[] {
    const n = (this.data.size + 1) * (this.data.size + 1)
    if (!this.data.terrain || this.data.terrain.length !== n) this.data.terrain = flatTerrain(this.data.size)
    return this.data.terrain
  }

  /** Keep the ground pinned under every road piece (call after pieces move). */
  private settleTerrain(): void {
    if (this.data.terrain) flattenUnderPieces(this.data.terrain, this.data.size, this.data.pieces)
  }

  private applyBrush(c: { x: number; z: number }, kind: 'raise' | 'lower' | 'flatten'): void {
    const h = this.ensureTerrain()
    const step = 0.22 * Math.sqrt(this.brush)
    if (kind === 'flatten') brushTerrain(h, this.data.size, c.x, c.z, this.brush, 0, this.level * LEVEL_H)
    else brushTerrain(h, this.data.size, c.x, c.z, this.brush, kind === 'raise' ? step : -step)
    this.settleTerrain()
    this.dirty = true
  }

  private test(): void {
    const t = new Track(this.data)
    if (!t.valid) {
      this.flash('Fix the errors first: ' + t.errors[0])
      return
    }
    this.cb.onTest(this.data)
  }

  private pushUndo(): void {
    this.undoStack.push(JSON.stringify(this.data))
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift()
    this.redoStack = []
  }

  private undo(): void {
    const s = this.undoStack.pop()
    if (!s) return
    this.redoStack.push(JSON.stringify(this.data))
    this.data = JSON.parse(s) as TrackData
    this.title.textContent = this.data.name
    this.selection.clear()
    this.dirty = true
  }

  private redo(): void {
    const s = this.redoStack.pop()
    if (!s) return
    this.undoStack.push(JSON.stringify(this.data))
    this.data = JSON.parse(s) as TrackData
    this.selection.clear()
    this.dirty = true
  }

  /** Rotate the selection (or the hovered piece for the menu) in place, else the primed piece. */
  private rotate(dir: 1 | -1, indices?: number[]): void {
    const targets = indices ?? [...this.selection]
    if (targets.length) {
      this.pushUndo()
      for (const i of targets) {
        const p = this.data.pieces[i]
        const before = rotatedSize(PIECE_BY_TYPE[p.type], p.rot)
        p.rot = (p.rot + dir + 4) % 4
        // Keep the footprint centred where it was.
        const after = rotatedSize(PIECE_BY_TYPE[p.type], p.rot)
        p.x += Math.floor((before.w - after.w) / 2)
        p.z += Math.floor((before.h - after.h) / 2)
      }
    } else this.rot = (this.rot + dir + 4) % 4
    this.dirty = true
  }

  private changeLevel(d: number, indices?: number[]): void {
    const targets = indices ?? [...this.selection]
    if (targets.length) {
      this.pushUndo()
      for (const i of targets) this.data.pieces[i].level = Math.max(0, Math.min(6, this.data.pieces[i].level + d))
      this.level = this.data.pieces[targets[0]].level
    } else this.level = Math.max(0, Math.min(6, this.level + d))
    this.syncToolbar()
    this.dirty = true
  }

  private deletePieces(indices: number[]): void {
    if (!indices.length) return
    this.pushUndo()
    const drop = new Set(indices)
    this.data.pieces = this.data.pieces.filter((_, i) => !drop.has(i))
    this.selection.clear()
    this.anchor = -1
    this.dirty = true
  }

  private duplicate(indices: number[]): void {
    if (!indices.length) return
    this.pushUndo()
    const copies = indices.map((i) => ({ ...this.data.pieces[i] }))
    // Offset by the selection's width so the copy lands beside it.
    const minX = Math.min(...copies.map((p) => p.x))
    const maxX = Math.max(...copies.map((p) => p.x + rotatedSize(PIECE_BY_TYPE[p.type], p.rot).w))
    for (const c of copies) c.x += maxX - minX
    const first = this.data.pieces.length
    this.data.pieces.push(...copies)
    this.selection = new Set(copies.map((_, k) => first + k))
    this.growToFit()
    this.dirty = true
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.visible || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
    const mod = e.metaKey || e.ctrlKey
    if (e.code === 'Space') {
      this.spaceHeld = true
      e.preventDefault()
      return
    }
    if (mod && e.code === 'KeyZ') {
      e.preventDefault()
      if (e.shiftKey) this.redo()
      else this.undo()
      return
    }
    if (mod && e.code === 'KeyS') {
      e.preventDefault()
      void this.save()
      return
    }
    if (mod && e.code === 'KeyA') {
      e.preventDefault()
      this.selection = new Set(this.data.pieces.map((_, i) => i))
      this.dirty = true
      return
    }
    if (mod) return
    switch (e.code) {
      case 'KeyG':
        void this.action('mode')
        break
      case 'BracketLeft':
        void this.action('brush-')
        break
      case 'BracketRight':
        void this.action('brush+')
        break
      case 'KeyR':
      case 'KeyX':
        this.rotate(1)
        break
      case 'KeyZ':
        this.rotate(-1)
        break
      case 'KeyQ':
        this.changeLevel(-1)
        break
      case 'KeyE':
        this.changeLevel(1)
        break
      case 'KeyD':
        this.duplicate([...this.selection])
        break
      case 'Delete':
      case 'Backspace': {
        // Delete the selection, else whatever is under the pointer.
        if (this.selection.size) this.deletePieces([...this.selection])
        else if (this.hover) {
          const i = this.pieceAt(this.hover.x, this.hover.z)
          if (i >= 0) this.deletePieces([i])
        }
        break
      }
      case 'KeyT':
        this.test()
        break
      case 'Equal':
      case 'NumpadAdd':
        this.zoomBy(1.25)
        break
      case 'Minus':
      case 'NumpadSubtract':
        this.zoomBy(1 / 1.25)
        break
      case 'Digit0':
        this.fit()
        break
      case 'Escape':
        if (this.menu) this.closeMenu()
        else if (this.selection.size) {
          this.selection.clear()
          this.dirty = true
        } else this.cb.onExit()
        break
    }
  }

  private flash(text: string): void {
    this.status.textContent = text
    this.status.classList.add('flash')
    setTimeout(() => this.status.classList.remove('flash'), 1600)
  }

  // --- view --------------------------------------------------------------------------

  private toPx(wx: number, wz: number): { x: number; y: number } {
    // World cell units (fractional) → canvas pixels; z runs up the screen.
    return { x: this.canvas.width / 2 + (wx - this.view.cx) * this.view.scale, y: this.canvas.height / 2 - (wz - this.view.cz) * this.view.scale }
  }

  private toWorld(px: number, py: number): { x: number; z: number } {
    return { x: this.view.cx + (px - this.canvas.width / 2) / this.view.scale, z: this.view.cz - (py - this.canvas.height / 2) / this.view.scale }
  }

  private canvasPoint(e: PointerEvent | WheelEvent | MouseEvent): { px: number; py: number } {
    const r = this.canvas.getBoundingClientRect()
    return { px: ((e.clientX - r.left) / r.width) * this.canvas.width, py: ((e.clientY - r.top) / r.height) * this.canvas.height }
  }

  private cellAt(e: PointerEvent | MouseEvent): Cell {
    const { px, py } = this.canvasPoint(e)
    const w = this.toWorld(px, py)
    return { x: Math.floor(w.x), z: Math.floor(w.z) }
  }

  /** Fractional cell coordinates under the pointer (for the brush). */
  private pointerCell(e: PointerEvent): { x: number; z: number } {
    const { px, py } = this.canvasPoint(e)
    return this.toWorld(px, py)
  }

  private inGrid(c: Cell): boolean {
    return c.x >= 0 && c.z >= 0 && c.x < this.data.size && c.z < this.data.size
  }

  private fit(): void {
    this.ensureCanvasSize()
    const w = this.canvas.width
    const h = this.canvas.height
    this.view.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.floor(Math.min(w, h) / (this.data.size + 1))))
    this.view.cx = this.data.size / 2
    this.view.cz = this.data.size / 2
    this.dirty = true
  }

  private zoomBy(f: number, at?: { px: number; py: number }): void {
    const before = at ? this.toWorld(at.px, at.py) : null
    this.view.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.view.scale * f))
    if (before && at) {
      // Keep the world point under the pointer fixed.
      const after = this.toWorld(at.px, at.py)
      this.view.cx += before.x - after.x
      this.view.cz += before.z - after.z
    }
    this.dirty = true
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault()
    const at = this.canvasPoint(e)
    if (e.shiftKey || (Math.abs(e.deltaX) > Math.abs(e.deltaY) && !e.ctrlKey)) {
      // Horizontal (or ⇧) scroll pans.
      this.view.cx += (e.shiftKey ? e.deltaY : e.deltaX) / this.view.scale
      this.dirty = true
      return
    }
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022))
    this.zoomBy(f, at)
  }

  // --- pointer -----------------------------------------------------------------------

  private onMove(e: PointerEvent): void {
    const { px, py } = this.canvasPoint(e)
    if (this.pan) {
      this.view.cx = this.pan.cx - (px - this.pan.px) / this.view.scale
      this.view.cz = this.pan.cz + (py - this.pan.py) / this.view.scale
      this.dirty = true
      return
    }
    const c = this.cellAt(e)
    if (this.sculpt) {
      this.applyBrush(this.pointerCell(e), this.sculpt.kind)
      this.hover = c
      return
    }
    if (this.drag) {
      const dx = c.x - this.drag.start.x
      const dz = c.z - this.drag.start.z
      if (dx !== this.drag.dx || dz !== this.drag.dz) {
        this.drag.dx = dx
        this.drag.dz = dz
        this.drag.moved = this.drag.moved || dx !== 0 || dz !== 0
        this.drag.indices.forEach((i, k) => {
          this.data.pieces[i].x = this.drag!.origin[k].x + dx
          this.data.pieces[i].z = this.drag!.origin[k].z + dz
        })
        this.dirty = true
      }
    }
    if (!this.hover || this.hover.x !== c.x || this.hover.z !== c.z) {
      this.hover = c
      this.dirty = true
    }
  }

  private onDown(e: PointerEvent): void {
    this.closeMenu()
    const { px, py } = this.canvasPoint(e)
    const mod = e.metaKey || e.ctrlKey
    // Pan: middle button, or space + drag.
    if (e.button === 1 || (e.button === 0 && this.spaceHeld)) {
      e.preventDefault()
      this.pan = { px, py, cx: this.view.cx, cz: this.view.cz }
      this.canvas.setPointerCapture(e.pointerId)
      return
    }
    const c = this.cellAt(e)
    this.hover = c
    this.dirty = true
    if (this.mode === 'terrain') {
      if (e.button !== 0 && e.button !== 2) return
      e.preventDefault()
      this.pushUndo()
      this.sculpt = { kind: e.shiftKey ? 'flatten' : e.button === 2 || e.altKey ? 'lower' : 'raise' }
      this.applyBrush(this.pointerCell(e), this.sculpt.kind)
      this.canvas.setPointerCapture(e.pointerId)
      return
    }
    const under = this.pieceAt(c.x, c.z)
    if (e.button === 2) {
      // ⇧⌥ right-click lowers a level; plain right-click is the menu (contextmenu event).
      if (e.shiftKey && e.altKey && under >= 0) this.changeLevel(-1, [under])
      return
    }
    if (e.button !== 0) return
    e.preventDefault()
    if (e.altKey && !mod && !e.shiftKey) {
      if (under >= 0) this.deletePieces([under])
      return
    }
    if (mod && e.altKey) {
      if (under >= 0) this.rotate(1, [under])
      return
    }
    if (e.shiftKey && e.altKey) {
      if (under >= 0) this.changeLevel(1, [under])
      return
    }
    if (mod && e.shiftKey) {
      this.place(c, true)
      return
    }
    if (mod) {
      if (under >= 0) {
        if (this.selection.has(under)) this.selection.delete(under)
        else this.selection.add(under)
        this.anchor = under
      }
      return
    }
    if (e.shiftKey) {
      if (under >= 0) this.selectRun(this.anchor, under)
      return
    }
    if (under >= 0) {
      if (!this.selection.has(under)) {
        this.selection = new Set([under])
      }
      this.anchor = under
      this.level = this.data.pieces[under].level
      this.syncToolbar()
      // Start a drag-move of the selection; it commits on release if everything still fits.
      const indices = [...this.selection]
      this.drag = { start: c, indices, origin: indices.map((i) => ({ x: this.data.pieces[i].x, z: this.data.pieces[i].z })), dx: 0, dz: 0, moved: false }
      this.canvas.setPointerCapture(e.pointerId)
      return
    }
    if (!this.inGrid(c)) {
      this.growTo(c)
      return
    }
    this.selection.clear()
    this.place(c, false)
  }

  private onUp(e: PointerEvent): void {
    if (this.pan) {
      this.pan = null
      return
    }
    if (this.sculpt) {
      this.sculpt = null
      return
    }
    const d = this.drag
    if (!d) return
    this.drag = null
    if (!d.moved) return
    // Commit the move if the pieces fit at their new places (at their own levels), else snap back.
    const moved = new Set(d.indices)
    const ok = d.indices.every((i) => {
      const p = this.data.pieces[i]
      return this.fits(p.type, p.rot, p.x, p.z, p.level, moved)
    })
    const after = d.indices.map((i) => ({ x: this.data.pieces[i].x, z: this.data.pieces[i].z }))
    d.indices.forEach((i, k) => {
      this.data.pieces[i].x = d.origin[k].x
      this.data.pieces[i].z = d.origin[k].z
    })
    if (!ok) {
      this.flash('Doesn’t fit there')
      this.dirty = true
      return
    }
    this.pushUndo()
    d.indices.forEach((i, k) => {
      this.data.pieces[i].x = after[k].x
      this.data.pieces[i].z = after[k].z
    })
    this.growToFit()
    this.settleTerrain()
    this.dirty = true
    void e
  }

  /** Topmost piece covering a cell (highest level wins), or -1. */
  private pieceAt(x: number, z: number, level?: number): number {
    let best = -1
    for (let i = this.data.pieces.length - 1; i >= 0; i--) {
      const p = this.data.pieces[i]
      if (level !== undefined && p.level !== level) continue
      const size = rotatedSize(PIECE_BY_TYPE[p.type], p.rot)
      if (x >= p.x && x < p.x + size.w && z >= p.z && z < p.z + size.h) {
        if (best < 0 || p.level > this.data.pieces[best].level) best = i
      }
    }
    return best
  }

  /** Whether a piece fits: inside the grid and clear of other pieces on the same level (bridges may cross). */
  private fits(type: string, rot: number, x: number, z: number, level: number, ignore: Set<number> = new Set()): boolean {
    const size = rotatedSize(PIECE_BY_TYPE[type], rot)
    if (x < 0 || z < 0 || x + size.w > this.data.size || z + size.h > this.data.size) return false
    for (let dx = 0; dx < size.w; dx++)
      for (let dz = 0; dz < size.h; dz++) {
        const i = this.pieceAt(x + dx, z + dz, level)
        if (i !== -1 && !ignore.has(i)) return false
      }
    return true
  }

  private overlapping(type: string, rot: number, x: number, z: number, level: number): number[] {
    const size = rotatedSize(PIECE_BY_TYPE[type], rot)
    const out = new Set<number>()
    for (let dx = 0; dx < size.w; dx++)
      for (let dz = 0; dz < size.h; dz++) {
        const i = this.pieceAt(x + dx, z + dz, level)
        if (i !== -1) out.add(i)
      }
    return [...out]
  }

  private place(c: Cell, force: boolean): void {
    const def = PIECE_BY_TYPE[this.selectedType]
    const size = rotatedSize(def, this.rot)
    if (c.x + size.w > this.data.size || c.z + size.h > this.data.size || c.x < 0 || c.z < 0) {
      if (!force) return
      this.growTo({ x: c.x + size.w - 1, z: c.z + size.h - 1 })
    }
    const clash = this.overlapping(this.selectedType, this.rot, c.x, c.z, this.level)
    if (clash.length && !force) return
    this.pushUndo()
    if (clash.length) {
      const drop = new Set(clash)
      this.data.pieces = this.data.pieces.filter((_, i) => !drop.has(i))
    }
    // Only one start piece.
    if (def.isStart) this.data.pieces = this.data.pieces.filter((p) => !PIECE_BY_TYPE[p.type].isStart)
    this.data.pieces.push({ type: this.selectedType, x: c.x, z: c.z, rot: this.rot, level: this.level })
    this.selection.clear()
    this.settleTerrain()
    this.dirty = true
  }

  /** Grow the grid so `c` is inside it; cells at negative coordinates shift the whole world over. */
  private growTo(c: Cell): void {
    let shift = 0
    if (c.x < 0 || c.z < 0) shift = Math.max(-c.x, -c.z)
    const need = Math.max(this.data.size, c.x + 1 + shift, c.z + 1 + shift)
    if (need > MAX_SIZE) {
      this.flash(`Grid is capped at ${MAX_SIZE} cells`)
      return
    }
    this.pushUndo()
    if (shift) for (const p of this.data.pieces) {
      p.x += shift
      p.z += shift
    }
    if (this.data.terrain) this.data.terrain = resizeTerrain(this.data.terrain, this.data.size, need, shift)
    this.data.size = need
    if (shift) {
      this.view.cx += shift
      this.view.cz += shift
    }
    this.flash(`Grid grown to ${need} × ${need}`)
    this.dirty = true
  }

  private growToFit(): void {
    let maxX = this.data.size
    let maxZ = this.data.size
    let minX = 0
    let minZ = 0
    for (const p of this.data.pieces) {
      const s = rotatedSize(PIECE_BY_TYPE[p.type], p.rot)
      maxX = Math.max(maxX, p.x + s.w)
      maxZ = Math.max(maxZ, p.z + s.h)
      minX = Math.min(minX, p.x)
      minZ = Math.min(minZ, p.z)
    }
    if (minX < 0 || minZ < 0 || maxX > this.data.size || maxZ > this.data.size) {
      const shift = Math.max(-minX, -minZ, 0)
      for (const p of this.data.pieces) {
        p.x += shift
        p.z += shift
      }
      const size = Math.min(MAX_SIZE, Math.max(maxX, maxZ) + shift)
      if (this.data.terrain) this.data.terrain = resizeTerrain(this.data.terrain, this.data.size, size, shift)
      this.data.size = size
      this.view.cx += shift
      this.view.cz += shift
    }
    this.settleTerrain()
  }

  // --- selection ---------------------------------------------------------------------

  /** Piece adjacency through matched ports (undirected). */
  private adjacency(): Map<number, Set<number>> {
    const byKey = new Map<string, number[]>()
    for (const port of portStatus(this.data.pieces)) {
      const list = byKey.get(port.key) ?? []
      list.push(port.pieceIndex)
      byKey.set(port.key, list)
    }
    const adj = new Map<number, Set<number>>()
    for (const list of byKey.values()) {
      for (const a of list) for (const b of list) {
        if (a === b) continue
        if (!adj.has(a)) adj.set(a, new Set())
        adj.get(a)!.add(b)
      }
    }
    return adj
  }

  /** ⇧-click: the run of connected pieces from the anchor to the target; without a path, everything in their box. */
  private selectRun(from: number, to: number): void {
    if (from < 0 || from >= this.data.pieces.length) {
      this.selection.add(to)
      this.anchor = to
      this.dirty = true
      return
    }
    const adj = this.adjacency()
    const prev = new Map<number, number>([[from, -1]])
    const queue = [from]
    while (queue.length) {
      const cur = queue.shift()!
      if (cur === to) break
      for (const n of adj.get(cur) ?? []) {
        if (!prev.has(n)) {
          prev.set(n, cur)
          queue.push(n)
        }
      }
    }
    if (prev.has(to)) {
      for (let cur = to; cur !== -1; cur = prev.get(cur)!) this.selection.add(cur)
    } else {
      const a = this.data.pieces[from]
      const b = this.data.pieces[to]
      const sa = rotatedSize(PIECE_BY_TYPE[a.type], a.rot)
      const sb = rotatedSize(PIECE_BY_TYPE[b.type], b.rot)
      const x0 = Math.min(a.x, b.x)
      const z0 = Math.min(a.z, b.z)
      const x1 = Math.max(a.x + sa.w, b.x + sb.w)
      const z1 = Math.max(a.z + sa.h, b.z + sb.h)
      this.data.pieces.forEach((p, i) => {
        const s = rotatedSize(PIECE_BY_TYPE[p.type], p.rot)
        if (p.x >= x0 && p.z >= z0 && p.x + s.w <= x1 && p.z + s.h <= z1) this.selection.add(i)
      })
    }
    this.dirty = true
  }

  private selectConnected(i: number): void {
    const adj = this.adjacency()
    const seen = new Set<number>([i])
    const queue = [i]
    while (queue.length) {
      const cur = queue.shift()!
      for (const n of adj.get(cur) ?? []) if (!seen.has(n)) {
        seen.add(n)
        queue.push(n)
      }
    }
    this.selection = seen
    this.dirty = true
  }

  // --- context menu ------------------------------------------------------------------

  private openMenu(e: MouseEvent): void {
    this.closeMenu()
    const c = this.cellAt(e)
    const under = this.pieceAt(c.x, c.z)
    const items: { label: string; key?: string; run: () => void; danger?: boolean }[] = []
    if (under >= 0) {
      const targets = this.selection.has(under) ? [...this.selection] : [under]
      const p = this.data.pieces[under]
      items.push(
        { label: `${PIECE_BY_TYPE[p.type].label}${targets.length > 1 ? ` (+${targets.length - 1} selected)` : ''} · L${p.level}`, run: () => {} },
        { label: 'Rotate ↻', key: 'X', run: () => this.rotate(1, targets) },
        { label: 'Rotate ↺', key: 'Z', run: () => this.rotate(-1, targets) },
        { label: 'Level +', key: 'E', run: () => this.changeLevel(1, targets) },
        { label: 'Level −', key: 'Q', run: () => this.changeLevel(-1, targets) },
        { label: 'Duplicate', key: 'D', run: () => this.duplicate(targets) },
        { label: 'Select connected', run: () => this.selectConnected(under) },
        { label: 'Delete', key: '⌫', danger: true, run: () => this.deletePieces(targets) },
      )
    } else {
      const def = PIECE_BY_TYPE[this.selectedType]
      items.push({ label: `Place ${def.label} here`, run: () => this.place(c, false) })
      if (!this.inGrid(c)) items.push({ label: 'Grow grid to here', run: () => this.growTo(c) })
      if (this.selection.size) items.push({ label: 'Clear selection', key: 'Esc', run: () => this.selection.clear() })
    }
    const m = document.createElement('div')
    m.className = 'editor-menu'
    items.forEach((it, k) => {
      const row = document.createElement('div')
      row.className = 'item' + (k === 0 && under >= 0 ? ' head' : '') + (it.danger ? ' danger' : '')
      row.innerHTML = `<span>${it.label}</span>${it.key ? `<kbd>${it.key}</kbd>` : ''}`
      if (!(k === 0 && under >= 0)) row.addEventListener('click', () => {
        it.run()
        this.closeMenu()
        this.dirty = true
      })
      m.appendChild(row)
    })
    const r = this.el.getBoundingClientRect()
    m.style.left = `${Math.min(e.clientX - r.left, r.width - 230)}px`
    m.style.top = `${Math.min(e.clientY - r.top, r.height - items.length * 30 - 20)}px`
    this.el.appendChild(m)
    this.menu = m
  }

  private closeMenu(): void {
    this.menu?.remove()
    this.menu = null
  }

  // --- drawing -----------------------------------------------------------------------

  private ensureCanvasSize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const rect = this.canvas.getBoundingClientRect()
    const w = Math.max(1, Math.floor(rect.width * dpr))
    const h = Math.max(1, Math.floor(rect.height * dpr))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
  }

  private draw(): void {
    this.ensureCanvasSize()
    const c = this.ctx
    const W = this.canvas.width
    const H = this.canvas.height
    const N = this.data.size
    const cell = this.view.scale
    c.clearRect(0, 0, W, H)
    // Outside the grid: a darker field, so the buildable area reads clearly.
    const o = this.toPx(0, N)
    const e = this.toPx(N, 0)
    c.fillStyle = 'rgba(255,255,255,0.025)'
    c.fillRect(o.x, o.y, e.x - o.x, e.y - o.y)
    // Grid lines (only the ones on screen).
    c.strokeStyle = 'rgba(255,255,255,0.08)'
    c.lineWidth = 1
    const tl = this.toWorld(0, 0)
    const br = this.toWorld(W, H)
    const x0 = Math.max(0, Math.floor(tl.x))
    const x1 = Math.min(N, Math.ceil(br.x))
    const z0 = Math.max(0, Math.floor(br.z))
    const z1 = Math.min(N, Math.ceil(tl.z))
    if (cell >= 8) {
      c.beginPath()
      for (let i = x0; i <= x1; i++) {
        const a = this.toPx(i, 0)
        const b = this.toPx(i, N)
        c.moveTo(a.x, a.y)
        c.lineTo(b.x, b.y)
      }
      for (let i = z0; i <= z1; i++) {
        const a = this.toPx(0, i)
        const b = this.toPx(N, i)
        c.moveTo(a.x, a.y)
        c.lineTo(b.x, b.y)
      }
      c.stroke()
    }
    // Border.
    c.strokeStyle = 'rgba(255,255,255,0.25)'
    c.strokeRect(o.x, o.y, e.x - o.x, e.y - o.y)
    const toPx = (wx: number, wz: number) => this.toPx(wx / CELL, wz / CELL)
    // Landscape: tint each cell by its height (cool below grade, warm above), on-screen cells only.
    const terr = this.data.terrain
    if (terr && terr.length === (N + 1) * (N + 1) && cell >= 4) {
      for (let z = z0; z < z1; z++)
        for (let x = x0; x < x1; x++) {
          const h = (terr[terrainIndex(N, x, z)] + terr[terrainIndex(N, x + 1, z)] + terr[terrainIndex(N, x, z + 1)] + terr[terrainIndex(N, x + 1, z + 1)]) / 4
          if (Math.abs(h) < 0.25) continue
          const a = this.toPx(x, z + 1)
          const t = Math.min(1, Math.abs(h) / 40)
          c.fillStyle = h > 0 ? `rgba(${Math.round(200 + 55 * t)}, ${Math.round(170 - 110 * t)}, ${Math.round(60 - 40 * t)}, ${(0.18 + 0.5 * t).toFixed(2)})` : `rgba(60, 120, 220, ${(0.15 + 0.5 * t).toFixed(2)})`
          c.fillRect(a.x, a.y, cell, cell)
          if (cell >= 34 && this.mode === 'terrain') {
            c.fillStyle = 'rgba(255,255,255,0.7)'
            c.font = `${Math.max(10, cell * 0.26)}px "VT323", ui-monospace, monospace`
            c.fillText(h.toFixed(0), a.x + 3, a.y + cell * 0.3)
          }
        }
    }
    // Pieces, low levels first so bridges draw over what they cross.
    const order = this.data.pieces.map((_, i) => i).sort((a, b) => this.data.pieces[a].level - this.data.pieces[b].level)
    const hoverIdx = this.hover ? this.pieceAt(this.hover.x, this.hover.z) : -1
    for (const i of order) {
      const p = this.data.pieces[i]
      const def = PIECE_BY_TYPE[p.type]
      const size = rotatedSize(def, p.rot)
      const a = toPx(p.x * CELL, (p.z + size.h) * CELL)
      const sel = this.selection.has(i)
      c.fillStyle = (def.decor ? DECOR_COLORS[def.decor] : GROUP_COLORS[def.group]) + (sel ? 'cc' : i === hoverIdx ? '99' : def.decor ? '88' : '66')
      c.fillRect(a.x + 1, a.y + 1, size.w * cell - 2, size.h * cell - 2)
      if (def.decor) drawDecor(c, def, a.x, a.y, size.w * cell, size.h * cell)
      if (p.level > 0) {
        c.strokeStyle = LEVEL_TINT[Math.min(6, p.level)]
        c.lineWidth = 2
        c.strokeRect(a.x + 2, a.y + 2, size.w * cell - 4, size.h * cell - 4)
      }
      drawLanes(c, def, p, toPx, cell / CELL, sel ? '#ffffff' : '#e8f6ff', def.isStart ? '#ff7a1a' : null)
      if (p.level > 0 && cell >= 14) {
        c.fillStyle = LEVEL_TINT[Math.min(6, p.level)]
        c.font = `${Math.max(10, cell * 0.28)}px "VT323", ui-monospace, monospace`
        c.fillText(`L${p.level}`, a.x + 4, a.y + cell * 0.32)
      }
      if (sel) {
        c.strokeStyle = '#ffffff'
        c.lineWidth = 2
        c.setLineDash([6, 4])
        c.strokeRect(a.x + 1, a.y + 1, size.w * cell - 2, size.h * cell - 2)
        c.setLineDash([])
      }
    }
    // Ports.
    if (cell >= 10) {
      for (const port of portStatus(this.data.pieces)) {
        const cx = port.cx * CELL + CELL / 2
        const cz = port.cz * CELL + CELL / 2
        const off = CELL / 2 - 2
        const dx = port.side === 'E' ? off : port.side === 'W' ? -off : 0
        const dz = port.side === 'N' ? off : port.side === 'S' ? -off : 0
        const p = toPx(cx + dx, cz + dz)
        c.fillStyle = port.matched ? '#5cff8a' : '#ff3b5c'
        c.beginPath()
        c.arc(p.x, p.y, Math.max(2, cell * 0.06), 0, Math.PI * 2)
        c.fill()
      }
    }
    // Landscape brush.
    if (this.mode === 'terrain' && this.hover && !this.pan) {
      const p = this.toPx(this.hover.x + 0.5, this.hover.z + 0.5)
      c.strokeStyle = 'rgba(255,200,87,0.9)'
      c.lineWidth = 2
      c.setLineDash([5, 4])
      c.beginPath()
      c.arc(p.x, p.y, this.brush * cell, 0, Math.PI * 2)
      c.stroke()
      c.setLineDash([])
    }
    // Hover: a placement ghost inside the grid, a grow ghost outside it.
    if (this.mode === 'pieces' && this.hover && !this.drag && !this.pan) {
      if (this.inGrid(this.hover)) {
        if (hoverIdx < 0) {
          const def = PIECE_BY_TYPE[this.selectedType]
          const size = rotatedSize(def, this.rot)
          const ok = this.fits(this.selectedType, this.rot, this.hover.x, this.hover.z, this.level)
          const a = toPx(this.hover.x * CELL, (this.hover.z + size.h) * CELL)
          c.fillStyle = ok ? 'rgba(255,255,255,0.12)' : 'rgba(255,59,92,0.25)'
          c.fillRect(a.x, a.y, size.w * cell, size.h * cell)
          drawLanes(c, def, { type: def.type, x: this.hover.x, z: this.hover.z, rot: this.rot, level: this.level }, toPx, cell / CELL, ok ? 'rgba(255,255,255,0.7)' : 'rgba(255,59,92,0.8)', null)
        }
      } else {
        const shift = Math.max(0, -this.hover.x, -this.hover.z)
        const need = Math.max(N, this.hover.x + 1 + shift, this.hover.z + 1 + shift)
        const g0 = this.toPx(-shift, need - shift)
        const g1 = this.toPx(need - shift, -shift)
        c.strokeStyle = 'rgba(255,200,87,0.6)'
        c.setLineDash([8, 6])
        c.lineWidth = 1.5
        c.strokeRect(g0.x, g0.y, g1.x - g0.x, g1.y - g0.y)
        c.setLineDash([])
        c.fillStyle = 'rgba(255,200,87,0.9)'
        c.font = `${Math.max(11, Math.min(18, cell * 0.4))}px "VT323", ui-monospace, monospace`
        c.fillText(`click to grow the grid to ${need} × ${need}`, g0.x + 8, g0.y - 6)
      }
    }
    // Status.
    const t = new Track(this.data)
    const bits = [`${this.data.pieces.length} pieces · ${N}×${N}`, t.closed ? `loop ${t.loopLength.toFixed(0)} m` : 'not closed']
    if (this.selection.size) bits.push(`${this.selection.size} selected`)
    if (t.errors.length) bits.push('⚠ ' + t.errors.slice(0, 2).join(' · '))
    else if (t.warnings.length) bits.push('· ' + t.warnings[0])
    else bits.push('✓ ready to drive')
    if (this.mode === 'terrain' && this.hover && terr) bits.push(`ground ${sampleHeight(terr, N, (this.hover.x + 0.5) * CELL, (this.hover.z + 0.5) * CELL).toFixed(1)} m`)
    if (!this.status.classList.contains('flash')) this.status.innerHTML = `<span>${bits.join('   ')}</span><span class="hints">${this.mode === 'terrain' ? TERRAIN_HINTS : HINTS}</span>`
  }
}

/** Draw a piece's lanes top-down in world→pixel space. */
function drawLanes(c: CanvasRenderingContext2D, def: PieceDef, p: PlacedPiece, toPx: (x: number, z: number) => { x: number; y: number }, scale: number, color: string, startColor: string | null): void {
  const pt = makePathPoint()
  const r = { x: 0, z: 0 }
  c.strokeStyle = color
  c.lineWidth = Math.max(2, 9 * scale)
  c.lineCap = 'round'
  for (const lane of def.lanes) {
    c.beginPath()
    const n = 24
    for (let i = 0; i <= n; i++) {
      lane.path(i / n, pt)
      rotateLocal(def, p.rot, pt.x, pt.z, r)
      const q = toPx(p.x * CELL + r.x, p.z * CELL + r.z)
      if (i === 0) c.moveTo(q.x, q.y)
      else if (pt.surface) c.lineTo(q.x, q.y)
      else c.moveTo(q.x, q.y)
    }
    c.stroke()
  }
  if (startColor) {
    // Start line across the middle of the piece.
    const size = rotatedSize(def, p.rot)
    const mid = toPx((p.x + size.w / 2) * CELL, (p.z + size.h / 2) * CELL)
    c.fillStyle = startColor
    c.fillRect(mid.x - 3 * scale * 4, mid.y - 3 * scale * 4, 6 * scale * 4, 6 * scale * 4)
  }
}

/** Scenery glyphs: wave lines for water, tree blobs, a block, a canopy. */
function drawDecor(c: CanvasRenderingContext2D, def: PieceDef, x: number, y: number, w: number, h: number): void {
  c.save()
  c.beginPath()
  c.rect(x, y, w, h)
  c.clip()
  const u = Math.min(w, h)
  switch (def.decor) {
    case 'water':
      c.strokeStyle = 'rgba(255,255,255,0.55)'
      c.lineWidth = Math.max(1, u * 0.03)
      for (let k = 1; k <= 3; k++) {
        c.beginPath()
        for (let i = 0; i <= 8; i++) c.lineTo(x + (w * i) / 8, y + (h * k) / 4 + Math.sin(i * 1.6 + k) * u * 0.04)
        c.stroke()
      }
      break
    case 'trees':
      c.fillStyle = 'rgba(120,220,110,0.9)'
      for (let i = 0; i < 5 * (w / u) * (h / u); i++) {
        const fx = 0.2 + 0.6 * ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1
        const fz = 0.2 + 0.6 * ((Math.sin(i * 78.233) * 43758.5453) % 1 + 1) % 1
        c.beginPath()
        c.arc(x + fx * w, y + fz * h, u * 0.09, 0, Math.PI * 2)
        c.fill()
      }
      break
    case 'building':
      c.fillStyle = 'rgba(230,230,240,0.85)'
      c.fillRect(x + w * 0.2, y + h * 0.2, w * 0.6, h * 0.6)
      c.fillStyle = 'rgba(40,50,70,0.8)'
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) c.fillRect(x + w * (0.27 + i * 0.18), y + h * (0.27 + j * 0.18), w * 0.09, h * 0.09)
      break
    case 'gas':
      c.fillStyle = 'rgba(255,240,200,0.9)'
      c.fillRect(x + w * 0.15, y + h * 0.25, w * 0.7, h * 0.35)
      c.fillStyle = 'rgba(255,80,60,0.9)'
      c.fillRect(x + w * 0.3, y + h * 0.7, w * 0.1, h * 0.15)
      c.fillRect(x + w * 0.6, y + h * 0.7, w * 0.1, h * 0.15)
      break
  }
  c.restore()
}

function drawPieceIcon(canvas: HTMLCanvasElement, def: PieceDef): void {
  const c = canvas.getContext('2d')!
  const cells = Math.max(def.w, def.h)
  const scale = (canvas.width - 8) / (cells * CELL)
  c.fillStyle = (def.decor ? DECOR_COLORS[def.decor] : GROUP_COLORS[def.group]) + '55'
  c.fillRect(4, 4 + (cells - def.h) * CELL * scale, def.w * CELL * scale, def.h * CELL * scale)
  if (def.decor) {
    drawDecor(c, def, 4, 4 + (cells - def.h) * CELL * scale, def.w * CELL * scale, def.h * CELL * scale)
    return
  }
  const toPx = (x: number, z: number) => ({ x: 4 + x * scale, y: canvas.height - 4 - z * scale })
  drawLanes(c, def, { type: def.type, x: 0, z: 0, rot: 0, level: 0 }, toPx, scale, '#e8f6ff', null)
}
