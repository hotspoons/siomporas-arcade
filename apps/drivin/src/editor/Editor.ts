// The track editor: a grid of cells, a palette of pieces, click to place with
// the current rotation and level, live connectivity feedback, save/load/export,
// and a Test Drive button that hands the track to the game.

import { PIECES, PIECE_BY_TYPE, makePathPoint, rotateLocal, rotatedSize, type PieceDef } from '../sim/pieces'
import { CELL } from '../sim/Tuning'
import { Track, portStatus, type PlacedPiece, type TrackData } from '../sim/Track'
import type { TrackStore } from '../app/TrackStore'

const GROUP_COLORS: Record<PieceDef['group'], string> = { basic: '#2f6b8a', curves: '#3b8a5c', stunts: '#a3552a', flow: '#7a4aa0' }

export interface EditorCallbacks {
  onTest(data: TrackData): void
  onExit(): void
}

export class Editor {
  readonly el: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly status: HTMLElement
  private readonly nameInput: HTMLInputElement
  private readonly palette: HTMLElement
  private readonly loadSelect: HTMLSelectElement
  private data: TrackData = { name: 'Untitled', size: 16, pieces: [] }
  private currentId: string | null = null
  private selectedType = 'straight'
  private rot = 0
  private level = 0
  private hover: { x: number; z: number } | null = null
  private selected = -1
  private dirty = true
  private visible = false
  private readonly store: TrackStore
  private readonly cb: EditorCallbacks

  constructor(parent: HTMLElement, store: TrackStore, cb: EditorCallbacks) {
    this.store = store
    this.cb = cb
    this.el = document.createElement('div')
    this.el.className = 'editor hidden'
    this.el.innerHTML = `
      <div class="toolbar">
        <input class="name" value="Untitled" spellcheck="false" />
        <button data-act="new">New</button>
        <button data-act="save">Save</button>
        <select data-load><option value="">Load…</option></select>
        <button data-act="delete-track" title="Delete the loaded user track">Delete</button>
        <span class="sep"></span>
        <button data-act="size-" title="Smaller grid">−</button><span data-size>16</span><button data-act="size+" title="Bigger grid">+</button>
        <span class="sep"></span>
        <button data-act="rotate" title="R">Rotate ↻</button>
        <button data-act="level-" title="Q">Level −</button><span data-level>L0</span><button data-act="level+" title="E">Level +</button>
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
    this.nameInput = this.el.querySelector('input.name')!
    this.palette = this.el.querySelector('.palette')!
    this.loadSelect = this.el.querySelector('[data-load]')!
    this.buildPalette()
    this.el.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act
      if (act) this.action(act)
    })
    this.loadSelect.addEventListener('change', () => {
      const id = this.loadSelect.value
      if (id) this.load(id)
      this.loadSelect.value = ''
    })
    this.nameInput.addEventListener('input', () => (this.data.name = this.nameInput.value || 'Untitled'))
    this.nameInput.addEventListener('keydown', (e) => e.stopPropagation())
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
    this.canvas.addEventListener('pointermove', (e) => this.onPointer(e, false))
    this.canvas.addEventListener('pointerdown', (e) => this.onPointer(e, true))
    this.canvas.addEventListener('pointerleave', () => {
      this.hover = null
      this.dirty = true
    })
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault())
    window.addEventListener('keydown', (e) => this.onKey(e))
    window.addEventListener('resize', () => (this.dirty = true))
  }

  show(): void {
    this.visible = true
    this.el.classList.remove('hidden')
    this.refreshLoadList()
    this.dirty = true
  }

  hide(): void {
    this.visible = false
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
    this.nameInput.value = this.data.name
    this.selected = -1
    this.dirty = true
  }

  /** Called every frame; redraws only when something changed. */
  tick(): void {
    if (!this.visible || !this.dirty) return
    this.dirty = false
    this.draw()
  }

  // ---------------------------------------------------------------------------

  private buildPalette(): void {
    const groups: PieceDef['group'][] = ['basic', 'curves', 'stunts', 'flow']
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

  private action(act: string): void {
    switch (act) {
      case 'new':
        this.setData({ name: 'Untitled', size: 16, pieces: [] }, null)
        break
      case 'save': {
        const t = new Track(this.data)
        this.currentId = this.store.save(this.data, this.currentId ?? undefined)
        this.refreshLoadList()
        this.flash(t.valid ? 'Saved' : 'Saved (track has errors)')
        break
      }
      case 'delete-track':
        if (this.currentId) {
          this.store.remove(this.currentId)
          this.currentId = null
          this.refreshLoadList()
          this.flash('Deleted saved track')
        }
        break
      case 'size-':
        this.data.size = Math.max(6, this.data.size - 2)
        break
      case 'size+':
        this.data.size = Math.min(40, this.data.size + 2)
        break
      case 'rotate':
        this.rotate()
        break
      case 'level-':
        this.level = Math.max(0, this.level - 1)
        if (this.selected >= 0) this.data.pieces[this.selected].level = this.level
        break
      case 'level+':
        this.level = Math.min(6, this.level + 1)
        if (this.selected >= 0) this.data.pieces[this.selected].level = this.level
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
    ;(this.el.querySelector('[data-size]') as HTMLElement).textContent = String(this.data.size)
    ;(this.el.querySelector('[data-level]') as HTMLElement).textContent = `L${this.level}`
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

  private rotate(): void {
    if (this.selected >= 0) {
      const p = this.data.pieces[this.selected]
      p.rot = (p.rot + 1) % 4
    } else this.rot = (this.rot + 1) % 4
    this.dirty = true
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.visible || e.target instanceof HTMLInputElement) return
    switch (e.code) {
      case 'KeyR':
        this.rotate()
        break
      case 'KeyQ':
        this.action('level-')
        break
      case 'KeyE':
        this.action('level+')
        break
      case 'Delete':
      case 'Backspace':
        if (this.selected >= 0) {
          this.data.pieces.splice(this.selected, 1)
          this.selected = -1
          this.dirty = true
        }
        break
      case 'KeyT':
        this.test()
        break
      case 'Escape':
        this.cb.onExit()
        break
    }
  }

  private flash(text: string): void {
    this.status.textContent = text
    this.status.classList.add('flash')
    setTimeout(() => this.status.classList.remove('flash'), 1200)
  }

  private layout(): { ox: number; oy: number; cell: number } {
    const w = this.canvas.width
    const h = this.canvas.height
    const cell = Math.floor(Math.min(w, h) / (this.data.size + 1))
    const ox = Math.floor((w - cell * this.data.size) / 2)
    const oy = Math.floor((h - cell * this.data.size) / 2)
    return { ox, oy, cell }
  }

  private cellAt(e: PointerEvent): { x: number; z: number } | null {
    const r = this.canvas.getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * this.canvas.width
    const py = ((e.clientY - r.top) / r.height) * this.canvas.height
    const { ox, oy, cell } = this.layout()
    const x = Math.floor((px - ox) / cell)
    const z = this.data.size - 1 - Math.floor((py - oy) / cell)
    if (x < 0 || z < 0 || x >= this.data.size || z >= this.data.size) return null
    return { x, z }
  }

  private pieceAt(x: number, z: number): number {
    for (let i = this.data.pieces.length - 1; i >= 0; i--) {
      const p = this.data.pieces[i]
      const size = rotatedSize(PIECE_BY_TYPE[p.type], p.rot)
      if (x >= p.x && x < p.x + size.w && z >= p.z && z < p.z + size.h) return i
    }
    return -1
  }

  private fits(type: string, rot: number, x: number, z: number, ignore = -1): boolean {
    const size = rotatedSize(PIECE_BY_TYPE[type], rot)
    if (x + size.w > this.data.size || z + size.h > this.data.size) return false
    for (let dx = 0; dx < size.w; dx++) for (let dz = 0; dz < size.h; dz++) if (this.pieceAt(x + dx, z + dz) !== -1 && this.pieceAt(x + dx, z + dz) !== ignore) return false
    return true
  }

  private onPointer(e: PointerEvent, down: boolean): void {
    const c = this.cellAt(e)
    this.hover = c
    this.dirty = true
    if (!down || !c) return
    e.preventDefault()
    const existing = this.pieceAt(c.x, c.z)
    if (e.button === 2) {
      if (existing >= 0) this.data.pieces.splice(existing, 1)
      this.selected = -1
      return
    }
    if (existing >= 0) {
      this.selected = existing
      this.level = this.data.pieces[existing].level
      ;(this.el.querySelector('[data-level]') as HTMLElement).textContent = `L${this.level}`
      return
    }
    if (this.fits(this.selectedType, this.rot, c.x, c.z)) {
      // Only one start piece.
      if (PIECE_BY_TYPE[this.selectedType].isStart) this.data.pieces = this.data.pieces.filter((p) => !PIECE_BY_TYPE[p.type].isStart)
      this.data.pieces.push({ type: this.selectedType, x: c.x, z: c.z, rot: this.rot, level: this.level })
      this.selected = -1
    }
  }

  private draw(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const rect = this.canvas.getBoundingClientRect()
    if (this.canvas.width !== Math.floor(rect.width * dpr)) {
      this.canvas.width = Math.floor(rect.width * dpr)
      this.canvas.height = Math.floor(rect.height * dpr)
    }
    const c = this.ctx
    const { ox, oy, cell } = this.layout()
    const N = this.data.size
    c.clearRect(0, 0, this.canvas.width, this.canvas.height)
    // Grid.
    c.strokeStyle = 'rgba(255,255,255,0.08)'
    c.lineWidth = 1
    for (let i = 0; i <= N; i++) {
      c.beginPath()
      c.moveTo(ox + i * cell, oy)
      c.lineTo(ox + i * cell, oy + N * cell)
      c.moveTo(ox, oy + i * cell)
      c.lineTo(ox + N * cell, oy + i * cell)
      c.stroke()
    }
    const toPx = (wx: number, wz: number) => ({ x: ox + (wx / CELL) * cell, y: oy + (N - wz / CELL) * cell })
    // Pieces.
    this.data.pieces.forEach((p, i) => {
      const def = PIECE_BY_TYPE[p.type]
      const size = rotatedSize(def, p.rot)
      const a = toPx(p.x * CELL, (p.z + size.h) * CELL)
      c.fillStyle = GROUP_COLORS[def.group] + (i === this.selected ? 'cc' : '66')
      c.fillRect(a.x + 1, a.y + 1, size.w * cell - 2, size.h * cell - 2)
      drawLanes(c, def, p, toPx, cell / CELL, i === this.selected ? '#ffffff' : '#e8f6ff', def.isStart ? '#ff7a1a' : null)
      if (p.level > 0) {
        c.fillStyle = '#ffc857'
        c.font = `${Math.max(10, cell * 0.28)}px ui-monospace, monospace`
        c.fillText(`L${p.level}`, a.x + 4, a.y + cell * 0.32)
      }
    })
    // Ports.
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
    // Hover ghost.
    if (this.hover && this.pieceAt(this.hover.x, this.hover.z) < 0) {
      const def = PIECE_BY_TYPE[this.selectedType]
      const size = rotatedSize(def, this.rot)
      const ok = this.fits(this.selectedType, this.rot, this.hover.x, this.hover.z)
      const a = toPx(this.hover.x * CELL, (this.hover.z + size.h) * CELL)
      c.fillStyle = ok ? 'rgba(255,255,255,0.12)' : 'rgba(255,59,92,0.25)'
      c.fillRect(a.x, a.y, size.w * cell, size.h * cell)
      drawLanes(c, def, { type: def.type, x: this.hover.x, z: this.hover.z, rot: this.rot, level: this.level }, toPx, cell / CELL, ok ? 'rgba(255,255,255,0.7)' : 'rgba(255,59,92,0.8)', null)
    }
    // Status.
    const t = new Track(this.data)
    const bits = [`${this.data.pieces.length} pieces`, t.closed ? `loop ${t.loopLength.toFixed(0)} m` : 'not closed']
    if (t.errors.length) bits.push('⚠ ' + t.errors.slice(0, 2).join(' · '))
    else if (t.warnings.length) bits.push('· ' + t.warnings[0])
    else bits.push('✓ ready to drive')
    if (!this.status.classList.contains('flash')) this.status.textContent = bits.join('   ')
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

function drawPieceIcon(canvas: HTMLCanvasElement, def: PieceDef): void {
  const c = canvas.getContext('2d')!
  const cells = Math.max(def.w, def.h)
  const scale = (canvas.width - 8) / (cells * CELL)
  c.fillStyle = GROUP_COLORS[def.group] + '55'
  c.fillRect(4, 4 + (cells - def.h) * CELL * scale, def.w * CELL * scale, def.h * CELL * scale)
  const toPx = (x: number, z: number) => ({ x: 4 + x * scale, y: canvas.height - 4 - z * scale })
  drawLanes(c, def, { type: def.type, x: 0, z: 0, rot: 0, level: 0 }, toPx, scale, '#e8f6ff', null)
}
