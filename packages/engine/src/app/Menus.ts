// DOM menus with keyboard/gamepad/mouse navigation. One MenuStack, screens are
// data: a title, a list of items (action / toggle / choice / slider / remap),
// and an optional footer. No framework: the whole app has one canvas and a
// handful of overlays.

import type { UiEdges } from '../input/UiEdges'
import { isPrefix, planMenuSync, type RoutePath, type Router } from './Router'

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
  /** Which row we last scrolled to, so the list only moves when the selection does. */
  private scrolled = -1
  private suppressed = false
  onNavigate: (() => void) | null = null
  onSelect: (() => void) | null = null

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div')
    this.el.className = 'menu hidden'
    parent.appendChild(this.el)
    window.addEventListener('mousemove', this.onMouseMove)
  }

  /** A real move of the mouse — not the pointer merely being somewhere — hands control back to it. */
  private readonly onMouseMove = (e: MouseEvent): void => {
    if (e.movementX === 0 && e.movementY === 0) return
    this.pointerLive = true
  }

  /** Whether the mouse has moved since the last time the keyboard or pad drove the menu. */
  private pointerLive = false

  // --- URL binding ---------------------------------------------------------
  // Each screen below the root is one history entry, so Back escapes one menu. The root screen (a
  // title or pause menu) is the game's own URL and adds no segment.

  private router: Router | null = null
  private routePrefix: RoutePath = []
  /** True while the router is driving us, so we don't navigate in response to navigation. */
  private syncing = false
  /** Screens popped by a Back, kept so the browser's Forward can put them back. */
  private forward: MenuScreen[] = []
  private unbindRouter: (() => void) | null = null

  /**
   * Give the stack a URL. `prefix` is the path the root screen sits at — `['radrun']` for a game in
   * the arcade — and nested screens append their `id` beneath it.
   */
  bindRouter(router: Router, prefix: RoutePath): void {
    this.unbindRouter?.()
    this.router = router
    this.routePrefix = [...prefix]
    this.unbindRouter = router.subscribe((path) => this.syncToRoute(path))
  }

  /** The path this stack's current screen corresponds to. */
  private get routeForStack(): string[] {
    return [...this.routePrefix, ...this.stack.slice(1).map((s) => s.id)]
  }

  private navigate(): void {
    if (!this.router || this.syncing) return
    this.router.push(this.routeForStack)
  }

  /**
   * Make the stack match the URL. Idempotent by design: a Back we initiated ourselves has already
   * popped the screen by the time the `popstate` lands here, and this then finds nothing to do.
   */
  private syncToRoute(path: RoutePath): void {
    if (!this.router) return
    if (!isPrefix(this.routePrefix, path)) return // a different part of the app owns this URL now
    const want = path.slice(this.routePrefix.length)
    const plan = planMenuSync(
      this.stack.slice(1).map((s) => s.id),
      this.forward.map((s) => s.id),
      want,
    )
    this.syncing = true
    // Back: shed screens. Each pop puts its screen at the front of the trail, which is what makes
    // the pushes below able to find them again.
    for (let i = 0; i < plan.pops; i++) this.pop()
    // Forward: put back the screens we kept.
    for (const id of plan.pushes) {
      const i = this.forward.findIndex((s) => s.id === id)
      if (i < 0) break
      this.push(this.forward.splice(i, 1)[0])
    }
    this.syncing = false
    if (plan.clamped) this.router.replace(this.routeForStack)
  }

  get open(): boolean {
    return this.stack.length > 0
  }

  /**
   * Put the panel aside without losing it (the title screen's attract mode). The stack is untouched,
   * so bringing it back shows the same screen with the same selection.
   */
  setSuppressed(v: boolean): void {
    this.suppressed = v
    this.syncVisibility()
  }

  get isSuppressed(): boolean {
    return this.suppressed
  }

  private syncVisibility(): void {
    this.el.classList.toggle('hidden', this.suppressed || this.stack.length === 0)
  }

  get current(): MenuScreen | null {
    return this.stack[this.stack.length - 1] ?? null
  }

  push(screen: MenuScreen): void {
    // Retracing the step we just came back from keeps the rest of the trail; going anywhere else
    // invalidates all of it, exactly as Forward dies in a browser once you navigate.
    if (!this.syncing) {
      if (this.forward[0]?.id === screen.id) this.forward.shift()
      else this.forward = []
    }
    this.stack.push(screen)
    this.cursor = 0
    this.scrolled = -1
    this.el.scrollTop = 0
    this.dirty = true
    this.syncVisibility()
    this.render()
    this.navigate()
  }

  replace(screen: MenuScreen): void {
    this.stack.length = 0
    this.forward = []
    this.stack.push(screen)
    this.cursor = 0
    this.scrolled = -1
    this.el.scrollTop = 0
    this.dirty = true
    this.syncVisibility()
    this.render()
    // Resetting to the root screen is not a move forward — it lands on the path we are already at,
    // so it corrects the URL rather than leaving another entry behind.
    if (this.router && !this.syncing) this.router.replace(this.routePrefix)
  }

  pop(): void {
    const wasNested = this.stack.length >= 2
    const gone = this.stack.pop()
    if (gone && wasNested) this.forward.unshift(gone)
    this.cursor = 0
    this.scrolled = -1
    this.dirty = true
    if (this.stack.length === 0) this.el.classList.add('hidden')
    else this.render()
    // Only a nested screen has a history entry of its own. Popping the root leaves the URL alone —
    // going back from there is leaving the game, which is the shell's business, not ours.
    if (wasNested && !this.syncing) this.router?.back()
  }

  closeAll(): void {
    this.stack.length = 0
    this.forward = []
    this.suppressed = false
    this.syncVisibility()
    if (this.router && !this.syncing) this.router.replace(this.routePrefix)
  }

  /** Detach from the DOM, the window and the URL. Mounting a different game must leave nothing behind. */
  dispose(): void {
    window.removeEventListener('mousemove', this.onMouseMove)
    this.unbindRouter?.()
    this.unbindRouter = null
    this.router = null
    this.stack.length = 0
    this.forward = []
    this.rows = []
    this.el.remove()
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
    // Keys and pads take the selection away from the mouse until the mouse moves again.
    if (ui.menuDown || ui.menuUp || ui.confirm || ui.menuLeft || ui.menuRight) this.pointerLive = false
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
          // Only when the mouse has actually moved. Re-rendering the list fires mouseenter on whatever
          // is under a stationary pointer, so arrowing down the menu kept snapping back to wherever the
          // mouse happened to be resting.
          if (item.kind !== 'info' && this.pointerLive) {
            this.cursor = i
            this.render()
          }
        })
        row.addEventListener('click', (e) => {
          if (item.kind === 'info') return
          this.cursor = i
          // ‹ and › are real buttons: they step back and forward. Clicking the row itself steps forward.
          const step = Number((e.target as HTMLElement).closest<HTMLElement>('.step')?.dataset.step ?? 1)
          if (item.kind === 'toggle' || item.kind === 'choice' || item.kind === 'slider') {
            this.adjust(item, step >= 0 ? 1 : -1)
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
          value = String(item.options[item.get()] ?? '')
          break
        case 'slider':
          value = item.format ? item.format(item.get()) : String(item.get())
          break
        case 'remap':
          value = item.get()
          break
        case 'info':
          value = item.value ? item.value() : ''
          break
      }
      const hint = 'hint' in item && item.hint ? `<span class="hint">${item.hint}</span>` : ''
      // Steppable rows get arrows you can actually click; the rest just show their value.
      const steppable = item.kind === 'choice' || item.kind === 'slider'
      const cell = steppable
        ? `<button class="step" data-step="-1" tabindex="-1">‹</button><span class="v">${value}</span><button class="step" data-step="1" tabindex="-1">›</button>`
        : value
      row.innerHTML = `<span class="label">${item.label}${hint}</span><span class="value">${cell}</span>`
    })
    if (this.cursor !== this.scrolled) {
      this.scrolled = this.cursor
      this.scrollToCursor()
    }
  }

  /**
   * Keep the selection in view on a list too long for the screen. Done against the menu's own
   * scrollTop rather than scrollIntoView(), which would also drag whatever is behind the menu.
   */
  private scrollToCursor(): void {
    const row = this.rows[this.cursor]
    const box = this.el
    if (!row || box.scrollHeight <= box.clientHeight) return
    const margin = row.offsetHeight * 0.75 // show a neighbour, so there is somewhere to go
    const top = row.offsetTop - margin
    const bottom = row.offsetTop + row.offsetHeight + margin
    if (top < box.scrollTop) box.scrollTop = Math.max(0, top)
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight
  }
}
