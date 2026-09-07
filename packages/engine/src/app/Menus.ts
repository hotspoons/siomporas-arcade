// DOM menus with keyboard/gamepad/mouse navigation. One MenuStack, screens are
// data: a title, a list of items (action / toggle / choice / slider / remap),
// and an optional footer. No framework: the whole app has one canvas and a
// handful of overlays.

import type { UiEdges } from '../input/UiEdges'

export type MenuItem =
  | { kind: 'action'; label: string; hint?: string; onSelect: () => void; danger?: boolean }
  | { kind: 'toggle'; label: string; hint?: string; get: () => boolean; set: (v: boolean) => void }
  | { kind: 'choice'; label: string; hint?: string; options: string[]; get: () => number; set: (i: number) => void }
  | { kind: 'slider'; label: string; hint?: string; min: number; max: number; step: number; get: () => number; set: (v: number) => void; format?: (v: number) => string }
  | { kind: 'remap'; label: string; get: () => string; onRemap: () => void; onClear: () => void }
  | { kind: 'info'; label: string; value?: () => string }

export interface MenuScreen {
  id: string
  title: string
  subtitle?: string
  items: MenuItem[]
  footer?: string
  /** Called on Escape/back. Default pops the stack. */
  onBack?: () => void
  wide?: boolean
}

export class MenuStack {
  readonly el: HTMLElement
  private readonly stack: MenuScreen[] = []
  private cursor = 0
  private rows: HTMLElement[] = []
  private dirty = true
  onNavigate: (() => void) | null = null
  onSelect: (() => void) | null = null

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div')
    this.el.className = 'menu hidden'
    parent.appendChild(this.el)
  }

  get open(): boolean {
    return this.stack.length > 0
  }

  get current(): MenuScreen | null {
    return this.stack[this.stack.length - 1] ?? null
  }

  push(screen: MenuScreen): void {
    this.stack.push(screen)
    this.cursor = 0
    this.dirty = true
    this.el.classList.remove('hidden')
    this.render()
  }

  replace(screen: MenuScreen): void {
    this.stack.length = 0
    this.push(screen)
  }

  pop(): void {
    this.stack.pop()
    this.cursor = 0
    this.dirty = true
    if (this.stack.length === 0) this.el.classList.add('hidden')
    else this.render()
  }

  closeAll(): void {
    this.stack.length = 0
    this.el.classList.add('hidden')
  }

  /** Re-render values (toggles etc.) without rebuilding structure. */
  refresh(): void {
    this.render()
  }

  handle(ui: UiEdges): void {
    const screen = this.current
    if (!screen) return
    const selectable = screen.items.map((it, i) => (it.kind === 'info' ? -1 : i)).filter((i) => i >= 0)
    if (selectable.length === 0) return
    if (!selectable.includes(this.cursor)) this.cursor = selectable[0]
    const pos = selectable.indexOf(this.cursor)
    if (ui.menuDown) {
      this.cursor = selectable[(pos + 1) % selectable.length]
      this.onNavigate?.()
      this.render()
    } else if (ui.menuUp) {
      this.cursor = selectable[(pos - 1 + selectable.length) % selectable.length]
      this.onNavigate?.()
      this.render()
    }
    const item = screen.items[this.cursor]
    if (!item) return
    if (ui.menuLeft || ui.menuRight) {
      const dir = ui.menuRight ? 1 : -1
      if (this.adjust(item, dir)) {
        this.onNavigate?.()
        this.render()
      }
    }
    if (ui.confirm) {
      this.activate(item)
    }
    if (ui.back) {
      if (screen.onBack) screen.onBack()
      else this.pop()
      this.onNavigate?.()
    }
  }

  private adjust(item: MenuItem, dir: number): boolean {
    switch (item.kind) {
      case 'toggle':
        item.set(!item.get())
        return true
      case 'choice':
        item.set((item.get() + dir + item.options.length) % item.options.length)
        return true
      case 'slider': {
        const v = Math.min(item.max, Math.max(item.min, item.get() + dir * item.step))
        item.set(Number(v.toFixed(4)))
        return true
      }
      default:
        return false
    }
  }

  private activate(item: MenuItem): void {
    this.onSelect?.()
    switch (item.kind) {
      case 'action':
        item.onSelect()
        break
      case 'toggle':
        item.set(!item.get())
        this.render()
        break
      case 'choice':
        this.adjust(item, 1)
        this.render()
        break
      case 'remap':
        item.onRemap()
        break
      default:
        break
    }
  }

  private render(): void {
    const screen = this.current
    if (!screen) return
    this.el.classList.toggle('wide', Boolean(screen.wide))
    this.el.classList.toggle('title-screen', screen.id === 'title')
    if (this.dirty) {
      this.el.innerHTML = ''
      const h1 = document.createElement('h1')
      h1.textContent = screen.title
      this.el.appendChild(h1)
      if (screen.subtitle) {
        const p = document.createElement('p')
        p.className = 'subtitle'
        p.textContent = screen.subtitle
        this.el.appendChild(p)
      }
      const list = document.createElement('div')
      list.className = 'items'
      this.rows = screen.items.map((item, i) => {
        const row = document.createElement('div')
        row.className = `item ${item.kind}`
        row.addEventListener('mouseenter', () => {
          if (item.kind !== 'info') {
            this.cursor = i
            this.render()
          }
        })
        row.addEventListener('click', (e) => {
          if (item.kind === 'info') return
          this.cursor = i
          const rect = row.getBoundingClientRect()
          const right = e.clientX > rect.left + rect.width * 0.6
          if (item.kind === 'toggle' || item.kind === 'choice' || item.kind === 'slider') {
            this.adjust(item, right ? 1 : -1)
            this.onNavigate?.()
            this.render()
          } else this.activate(item)
        })
        list.appendChild(row)
        return row
      })
      this.el.appendChild(list)
      if (screen.footer) {
        const f = document.createElement('p')
        f.className = 'footer'
        f.textContent = screen.footer
        this.el.appendChild(f)
      }
      this.dirty = false
    }
    screen.items.forEach((item, i) => {
      const row = this.rows[i]
      if (!row) return
      row.classList.toggle('selected', i === this.cursor)
      if (item.kind === 'action') row.classList.toggle('danger', Boolean(item.danger))
      let value = ''
      switch (item.kind) {
        case 'toggle':
          value = item.get() ? 'ON' : 'OFF'
          break
        case 'choice':
          value = `‹ ${item.options[item.get()] ?? ''} ›`
          break
        case 'slider':
          value = item.format ? item.format(item.get()) : `‹ ${item.get()} ›`
          break
        case 'remap':
          value = item.get()
          break
        case 'info':
          value = item.value ? item.value() : ''
          break
      }
      const hint = 'hint' in item && item.hint ? `<span class="hint">${item.hint}</span>` : ''
      row.innerHTML = `<span class="label">${item.label}${hint}</span><span class="value">${value}</span>`
    })
  }
}
