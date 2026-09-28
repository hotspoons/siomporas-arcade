// The shell: the handful of containers both corridor UIs are built out of.
//
// No framework. This is a 3D viewer whose UI is a drawer, a dialog, some tabs and about two
// hundred fields — a framework would be the largest thing in the bundle and would buy a re-render
// loop nothing here needs, because the scene is the thing that redraws and it does so itself.
//
// What this file *does* buy is that every panel behaves the same way: one Escape key handler, one
// focus trap, one place that knows a dialog is open, one transition curve. That consistency is
// what the old panel did not have, and it is most of what "atrocious" meant.
import { icon, type IconName } from './icons'

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text) n.textContent = text
  return n
}

export interface ButtonOpts {
  label?: string
  icon?: IconName
  /** 'primary' fills with the accent, 'danger' is destructive, 'ghost' has no border */
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
  /** shown in the tooltip after the label, e.g. 'Tab' */
  key?: string
  title?: string
  /**
   * Greyed out and unclickable.
   *
   * On the element rather than left to the handler: a button that looks pressable and does nothing
   * reads as a broken button, and "push" during a push is exactly the case — the second click is
   * a second push, not a no-op.
   */
  disabled?: boolean
  onClick?: (ev: MouseEvent) => void
}

export function button(o: ButtonOpts): HTMLButtonElement {
  const b = el('button', `btn${o.variant && o.variant !== 'default' ? ` ${o.variant}` : ''}`)
  if (o.icon) b.append(icon(o.icon, 16))
  if (o.label) b.append(el('span', 'btn-label', o.label))
  if (!o.label && o.icon) b.classList.add('icon-only')
  const tip = [o.title ?? o.label, o.key ? `(${o.key})` : ''].filter(Boolean).join(' ')
  if (tip) b.title = tip
  if (!o.label) b.setAttribute('aria-label', o.title ?? o.icon ?? 'button')
  if (o.disabled) b.disabled = true
  if (o.onClick) b.onclick = o.onClick
  return b
}

/* ------------------------------------------------------------------------------------------- */

export interface Tab {
  id: string
  label: string
  icon?: IconName
  /** built once, the first time the tab is shown — some of these are hundreds of fields */
  build: (host: HTMLElement) => void
}

/**
 * A tab strip over a body, with the panels built lazily.
 *
 * Lazily matters here: the tuning tabs together are ~200 sliders, and building all of them to show
 * one is the difference between a dialog that opens instantly and one that hitches.
 */
export class Tabs {
  root = el('div', 'tabs')
  private strip = el('div', 'tab-strip')
  private body = el('div', 'tab-body')
  private built = new Set<string>()
  private panels = new Map<string, HTMLElement>()
  private buttons = new Map<string, HTMLButtonElement>()
  current = ''

  private tabs: Tab[]

  constructor(tabs: Tab[], onChange?: (id: string) => void) {
    this.tabs = tabs
    this.strip.setAttribute('role', 'tablist')
    for (const t of tabs) {
      const b = el('button', 'tab')
      b.setAttribute('role', 'tab')
      if (t.icon) b.append(icon(t.icon, 16))
      b.append(el('span', '', t.label))
      b.onclick = () => {
        this.show(t.id)
        onChange?.(t.id)
      }
      this.buttons.set(t.id, b)
      this.strip.append(b)
      const panel = el('div', 'tab-panel')
      panel.setAttribute('role', 'tabpanel')
      panel.hidden = true
      this.panels.set(t.id, panel)
      this.body.append(panel)
    }
    this.root.append(this.strip, this.body)
    if (tabs.length) this.show(tabs[0].id)
  }

  show(id: string) {
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab) return
    const panel = this.panels.get(id)!
    if (!this.built.has(id)) {
      tab.build(panel)
      this.built.add(id)
    }
    for (const [k, p] of this.panels) p.hidden = k !== id
    for (const [k, b] of this.buttons) {
      b.classList.toggle('on', k === id)
      b.setAttribute('aria-selected', String(k === id))
    }
    this.current = id
  }

  /** Throw away a built panel so it is rebuilt next time it is shown (site changed, say). */
  invalidate(id?: string) {
    for (const k of id ? [id] : [...this.built]) {
      this.built.delete(k)
      this.panels.get(k)?.replaceChildren()
    }
    if (this.current && !this.built.has(this.current)) this.show(this.current)
  }
}

/* ------------------------------------------------------------------------------------------- */

/**
 * The open lightbox, if any. It sits ON TOP of a dialog, so Escape belongs to it first.
 *
 * Registered here rather than handled in the lightbox's own listener, because the app's Escape
 * handler is installed on `window` in the CAPTURE phase at start-up — and two capture listeners
 * on the same target run in REGISTRATION order, so a listener added later cannot get in front of
 * it. `stopImmediatePropagation` from the second one is too late: the first has already closed
 * the dialog. One handler that knows what is on top is the design this file already claims.
 */
let openLightbox: (() => void) | null = null

/** The one open dialog, if any — so Escape and the scrim know what they are closing. */
let openDialog: Dialog | null = null

/** A tiny registry, so opening a dialog does not read as assigning `this` to a loose variable. */
function registerOpen(d: Dialog | null) {
  openDialog = d
}

export interface DialogOpts {
  title: string
  /** can be dragged, resized and docked to a side (Dialog.dock) — for panels you work WITH, not modals */
  movable?: boolean
  icon?: IconName
  /** 'md' is the common settings size; 'lg' is for the tuning wall of sliders */
  size?: 'sm' | 'md' | 'lg'
  onClose?: () => void
}

export class Dialog {
  root = el('div', 'dialog-scrim')
  panel = el('section', 'dialog')
  body = el('div', 'dialog-body')
  private foot = el('footer', 'dialog-foot')
  private lastFocus: Element | null = null
  /** float over a scrim, or a column at one side with the scene live beside it */
  private docked: 'float' | 'left' | 'right' = 'float'
  private size: { w: number; h: number } | null = null
  private at: { x: number; y: number } | null = null
  private prefKey: string

  private o: DialogOpts

  constructor(o: DialogOpts) {
    this.o = o
    this.prefKey = `apex-dialog.${o.title.toLowerCase().replace(/\W+/g, '-')}.v1`
    this.panel.classList.add(`size-${o.size ?? 'md'}`)
    this.panel.setAttribute('role', 'dialog')
    this.panel.setAttribute('aria-modal', 'true')
    this.panel.setAttribute('aria-label', o.title)

    const head = el('header', 'dialog-head')
    if (o.icon) head.append(icon(o.icon, 18))
    head.append(el('h2', '', o.title))
    if (o.movable) {
      // DOCK, DON'T CLOSE. Tuning is a loop — move a slider, look at the world, move it again —
      // and a modal over a dimmed scene breaks the looking half of it (Rich, 2026-09-26). Docked,
      // the panel is a column at one side, the scrim goes away entirely and the scene is live
      // beside it. Floating, it can be dragged by its title bar and resized from its corner.
      head.append(
        button({ icon: 'chevron-left', variant: 'ghost', title: 'dock to the left', onClick: () => this.dock('left') }),
        button({ icon: 'squares-2x2', variant: 'ghost', title: 'float over the scene', onClick: () => this.dock('float') }),
        button({ icon: 'chevron-right', variant: 'ghost', title: 'dock to the right', onClick: () => this.dock('right') }),
      )
      head.classList.add('draggable')
      this.makeDraggable(head)
    }
    head.append(button({ icon: 'x-mark', variant: 'ghost', title: 'close', key: 'Esc', onClick: () => this.close() }))
    this.panel.append(head, this.body, this.foot)
    if (o.movable) {
      const grip = el('div', 'dialog-grip')
      grip.title = 'drag to resize'
      this.panel.append(grip)
      this.makeResizable(grip)
    }
    this.foot.hidden = true
    this.root.append(this.panel)

    // A click on the backdrop closes; a click that started inside and ended outside does not,
    // which is what makes dragging a slider to the edge of the dialog survivable.
    this.root.addEventListener('pointerdown', (e) => {
      // a docked panel has no backdrop to click: the rest of the screen is the scene, and clicks
      // belong to it
      if (e.target === this.root && this.docked === 'float') this.close()
    })
    if (o.movable) {
      try {
        const pref = JSON.parse(localStorage.getItem(this.prefKey) ?? 'null') as { dock?: 'float' | 'left' | 'right'; size?: { w: number; h: number } | null; at?: { x: number; y: number } | null } | null
        if (pref) {
          this.size = pref.size ?? null
          this.at = pref.at ?? null
          if (this.at) { this.panel.style.left = `${this.at.x}px`; this.panel.style.top = `${this.at.y}px`; this.panel.classList.add('placed') }
          this.dock(pref.dock ?? 'float')
        }
      } catch { /* a fresh or blocked browser just gets the default */ }
    }
  }

  /**
   * Where the panel lives. `float` is the old modal, centred over a scrim; `left` and `right` are
   * a column down that side with NO scrim, so the scene stays visible and live while you work.
   * Remembered per dialog, because it is a working preference and not a mode.
   */
  dock(where: 'float' | 'left' | 'right') {
    this.docked = where
    this.root.classList.toggle('docked', where !== 'float')
    this.panel.classList.toggle('dock-left', where === 'left')
    this.panel.classList.toggle('dock-right', where === 'right')
    if (where !== 'float') {
      // a docked panel drops whatever it was dragged or resized to; the side decides its box
      this.panel.style.left = this.panel.style.top = this.panel.style.width = this.panel.style.height = ''
    } else if (this.size) {
      this.panel.style.width = `${this.size.w}px`
      this.panel.style.height = `${this.size.h}px`
    }
    this.savePrefs()
  }

  private savePrefs() {
    try { localStorage.setItem(this.prefKey, JSON.stringify({ dock: this.docked, size: this.size, at: this.at })) } catch { /* private window */ }
  }

  /**
   * Freeze the panel's current size into an inline one. A floating dialog is `width: 100%` of a
   * full-screen backdrop with a max-width doing the real work, so the moment it is positioned and
   * the caps come off it would fill the window. Called before the first drag or resize.
   */
  private takeOwnBox() {
    if (this.size) return
    const r = this.panel.getBoundingClientRect()
    this.size = { w: Math.round(r.width), h: Math.round(r.height) }
    this.at = this.at ?? { x: Math.round(r.x), y: Math.round(r.y) }
    this.panel.style.width = `${this.size.w}px`
    this.panel.style.height = `${this.size.h}px`
    this.panel.style.left = `${this.at.x}px`
    this.panel.style.top = `${this.at.y}px`
    this.panel.classList.add('placed')
  }

  /** Drag the panel by its title bar; only while floating. */
  private makeDraggable(handle: HTMLElement) {
    handle.addEventListener('pointerdown', (e) => {
      if (this.docked !== 'float' || (e.target as HTMLElement).closest('button')) return
      e.preventDefault()
      handle.setPointerCapture(e.pointerId)
      this.takeOwnBox()
      const r = this.panel.getBoundingClientRect()
      const dx = e.clientX - r.left, dy = e.clientY - r.top
      const move = (m: PointerEvent) => {
        this.at = {
          x: Math.min(innerWidth - 120, Math.max(20 - r.width, m.clientX - dx)),
          y: Math.min(innerHeight - 40, Math.max(0, m.clientY - dy)),
        }
        this.panel.style.left = `${this.at.x}px`
        this.panel.style.top = `${this.at.y}px`
        this.panel.classList.add('placed')
      }
      const up = () => {
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', up)
        this.savePrefs()
      }
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', up)
    })
  }

  /** Resize from the bottom-right grip; only while floating (a docked panel's width is the dock). */
  private makeResizable(grip: HTMLElement) {
    grip.addEventListener('pointerdown', (e) => {
      if (this.docked !== 'float') return
      e.preventDefault()
      e.stopPropagation()
      grip.setPointerCapture(e.pointerId)
      this.takeOwnBox()
      const r = this.panel.getBoundingClientRect()
      const x0 = e.clientX, y0 = e.clientY
      const move = (m: PointerEvent) => {
        this.size = {
          w: Math.round(Math.min(innerWidth - 40, Math.max(320, r.width + (m.clientX - x0)))),
          h: Math.round(Math.min(innerHeight - 40, Math.max(220, r.height + (m.clientY - y0)))),
        }
        this.panel.style.width = `${this.size.w}px`
        this.panel.style.height = `${this.size.h}px`
        this.panel.classList.add('placed')
      }
      const up = () => {
        grip.removeEventListener('pointermove', move)
        grip.removeEventListener('pointerup', up)
        this.savePrefs()
      }
      grip.addEventListener('pointermove', move)
      grip.addEventListener('pointerup', up)
    })
  }

  /** Buttons along the bottom. Called with none, the footer stays hidden. */
  footer(...nodes: (HTMLElement | null)[]): this {
    const real = nodes.filter(Boolean) as HTMLElement[]
    this.foot.replaceChildren(...real)
    this.foot.hidden = real.length === 0
    return this
  }

  open(): this {
    if (openDialog && openDialog !== this) openDialog.close()
    this.lastFocus = document.activeElement
    document.body.append(this.root)
    registerOpen(this)
    // next frame, so the transition has a start state to move from
    requestAnimationFrame(() => this.root.classList.add('in'))
    // a docked panel must not steal focus: the keys belong to the car
    if (this.docked === 'float') this.panel.querySelector<HTMLElement>('button, [href], input, select, textarea')?.focus()
    return this
  }

  close() {
    if (openDialog === this) registerOpen(null)
    this.root.classList.remove('in')
    const done = () => this.root.remove()
    // match --dur-2; if the transition never fires (reduced motion) remove on the next tick
    this.root.addEventListener('transitionend', done, { once: true })
    setTimeout(done, 300)
    this.o.onClose?.()
    ;(this.lastFocus as HTMLElement | null)?.focus?.()
  }

  get isOpen() {
    return openDialog === this
  }

  toggle() {
    if (this.isOpen) this.close()
    else this.open()
  }
}

/* ------------------------------------------------------------------------------------------- */

export interface DrawerItem {
  id: string
  label: string
  icon: IconName
  hint?: string
  key?: string
  onClick: () => void
}

/**
 * The hamburger drawer: the app's front door.
 *
 * Everything that is a *place to go* or a *thing to do to the whole app* lives here. Everything
 * that is a *setting* lives in the settings dialog. That split is the entire information
 * architecture, and keeping to it is why there is no longer a row of eleven unlabelled buttons.
 */
export class Drawer {
  root = el('aside', 'drawer')
  private scrim = el('div', 'drawer-scrim')
  private body = el('div', 'drawer-body')
  open = false

  constructor(title: string, subtitle = '') {
    const head = el('header', 'drawer-head')
    const h = el('div', 'drawer-title')
    h.append(el('h1', '', title))
    if (subtitle) h.append(el('p', 'drawer-sub', subtitle))
    head.append(h, button({ icon: 'x-mark', variant: 'ghost', title: 'close menu', onClick: () => this.set(false) }))
    this.root.append(head, this.body)
    this.scrim.onclick = () => this.set(false)
    document.body.append(this.scrim, this.root)
  }

  section(label: string): HTMLElement {
    const s = el('div', 'drawer-section')
    if (label) s.append(el('h3', '', label))
    this.body.append(s)
    return s
  }

  /** A navigation row. Returns it so a caller can mark it current or update its hint. */
  item(into: HTMLElement, o: DrawerItem): HTMLButtonElement {
    const b = el('button', 'drawer-item')
    b.append(icon(o.icon, 18))
    const t = el('span', 'drawer-item-text')
    t.append(el('span', 'drawer-item-label', o.label))
    if (o.hint) t.append(el('span', 'drawer-item-hint', o.hint))
    b.append(t)
    if (o.key) b.append(el('kbd', '', o.key))
    b.onclick = () => {
      o.onClick()
      this.set(false)
    }
    into.append(b)
    return b
  }

  /** Anything that is not a row — a theme switch, a site picker. */
  custom(into: HTMLElement, node: HTMLElement) {
    into.append(node)
  }

  set(open: boolean) {
    this.open = open
    this.root.classList.toggle('in', open)
    this.scrim.classList.toggle('in', open)
    if (open) this.root.querySelector<HTMLElement>('button')?.focus()
  }

  toggle() {
    this.set(!this.open)
  }
}

/* ------------------------------------------------------------------------------------------- */

let toastHost: HTMLElement | null = null
let toastTimer = 0

/**
 * A transient line of status over the scene.
 *
 * Replaces `#status`, which was a div that different parts of the app wrote into and then raced
 * each other to clear with their own setTimeout.
 */
/*
 * ASK AND CONFIRM, in the app rather than in the browser chrome.
 *
 * `prompt()` and `confirm()` work, and they look like 1998 — a grey box with the hostname above
 * it, no styling, no validation until you have already pressed OK, and on some browsers a
 * "prevent this page from creating additional dialogs" checkbox that silently disables the app.
 * There was a full Dialog class here the whole time; the native calls were shortcuts
 * (Rich, 2026-09-27: "got hit with this unintuitive mess ... make these more production grade").
 *
 * Both return a Promise, so the call sites read the same way the native ones did.
 */

/** One line of text, validated as it is typed. Resolves null if dismissed. */
export function ask(o: {
  title: string
  label: string
  value?: string
  placeholder?: string
  /** return a message to block OK, or null when the value is usable */
  validate?: (v: string) => string | null
  ok?: string
  icon?: IconName
}): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (v: string | null) => { if (!done) { done = true; resolve(v) } }
    const d = new Dialog({ title: o.title, size: 'sm', icon: o.icon, onClose: () => finish(null) })

    const field = el('label', 'field text')
    field.append(el('span', 'field-label', o.label))
    const input = el('input', 'input wide')
    input.type = 'text'
    input.value = o.value ?? ''
    if (o.placeholder) input.placeholder = o.placeholder
    field.append(input)
    const why = el('p', 'field-error')
    why.hidden = true

    const accept = button({
      label: o.ok ?? 'OK',
      variant: 'primary',
      onClick: () => {
        const v = input.value.trim()
        const bad = o.validate?.(v) ?? (v ? null : `${o.label} is required`)
        if (bad) { why.textContent = bad; why.hidden = false; input.focus(); return }
        finish(v)
        d.close()
      },
    })
    // Validate WHILE TYPING, not after OK. A rule you are told about only once you have committed
    // is a rule you have to guess at.
    input.oninput = () => {
      const bad = o.validate?.(input.value.trim()) ?? null
      why.textContent = bad ?? ''
      why.hidden = !bad
      accept.disabled = !!bad || !input.value.trim()
    }
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); accept.click() }
    }
    accept.disabled = !(o.value ?? '').trim()

    d.body.append(field, why)
    d.footer(button({ label: 'Cancel', onClick: () => d.close() }), accept).open()
    requestAnimationFrame(() => { input.focus(); input.select() })
  })
}

/** A yes/no. `danger` colours the confirming button, for the ones that destroy something. */
export function confirm(o: {
  title: string
  message: string
  ok?: string
  danger?: boolean
  icon?: IconName
}): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (v: boolean) => { if (!done) { done = true; resolve(v) } }
    const d = new Dialog({ title: o.title, size: 'sm', icon: o.icon, onClose: () => finish(false) })
    d.body.append(el('p', 'dialog-message', o.message))
    d.footer(
      button({ label: 'Cancel', onClick: () => d.close() }),
      button({
        label: o.ok ?? 'OK',
        variant: o.danger ? 'danger' : 'primary',
        onClick: () => { finish(true); d.close() },
      }),
    ).open()
  })
}

export function toast(message: string, kind: 'info' | 'ok' | 'warn' | 'danger' = 'info', ms = 3200) {
  if (!toastHost) {
    toastHost = el('div', 'toast')
    document.body.append(toastHost)
  }
  toastHost.className = `toast ${kind} in`
  toastHost.textContent = message
  clearTimeout(toastTimer)
  if (ms > 0) toastTimer = window.setTimeout(() => toastHost!.classList.remove('in'), ms)
}

/** A message that stays until something replaces or clears it — loading, mostly. */
export function status(message: string) {
  toast(message, 'info', 0)
}

export function clearStatus() {
  toastHost?.classList.remove('in')
}

/* ------------------------------------------------------------------------------------------- */

/**
 * One Escape handler for the whole app, and one place that knows whether a text field has focus.
 *
 * Call once at start-up. Returns nothing to unbind because both UIs live for the life of the page.
 */
export function installShellKeys(drawer: () => Drawer | null) {
  addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return
      const d = drawer()
      if (openLightbox) {
        openLightbox()
        e.stopPropagation()
      } else if (openDialog) {
        openDialog.close()
        e.stopPropagation()
      } else if (d?.open) {
        d.set(false)
        e.stopPropagation()
      }
    },
    true, // capture: the scene's own Escape handling must not get there first
  )
}

/** True when the keystroke is going into a text field and the app should keep its hands off. */
export function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null
  if (!t) return false
  return t.isContentEditable || /^(input|select|textarea)$/i.test(t.tagName)
}

/*
 * A LIGHTBOX. Click a thumbnail, see the thing.
 *
 * Rich, 2026-09-28: "clicking a thumbnail should open it in a lightbox from that interface".
 *
 * Thumbnails in these panels are ~90 px wide and the things they stand for are decisions — which
 * of six drawings gets reconstructed into a mesh. You cannot make that decision at 90 px, and the
 * only way to see one properly was to open the file URL in another tab.
 *
 * It takes a LIST and an index rather than one image, because the decision is a comparison: the
 * arrow keys step through the set without going back to the grid between each one.
 */
export interface LightboxItem {
  src: string
  caption?: string
  /** marked as the current choice, whatever "choice" means to the caller */
  current?: boolean
}

export function lightbox(o: {
  items: LightboxItem[]
  index?: number
  /** an action on the item being looked at — "use this one", say. Closes after it runs. */
  action?: { label: string; icon?: IconName; onPick: (index: number) => void }
}): void {
  if (!o.items.length) return
  let i = Math.min(Math.max(0, o.index ?? 0), o.items.length - 1)

  const root = el('div', 'lightbox')
  const figure = el('figure', 'lightbox-figure')
  const img = el('img', 'lightbox-img')
  const cap = el('figcaption', 'lightbox-cap')
  figure.append(img, cap)

  const close = () => {
    removeEventListener('keydown', onKey, true)
    if (openLightbox === close) openLightbox = null
    root.classList.remove('in')
    setTimeout(() => root.remove(), 200)
  }
  const step = (by: number) => {
    i = (i + by + o.items.length) % o.items.length
    show()
  }
  function show() {
    const item = o.items[i]
    img.src = item.src
    img.alt = item.caption ?? ''
    cap.textContent = [item.caption, o.items.length > 1 ? `${i + 1} of ${o.items.length}` : '']
      .filter(Boolean).join(' · ')
    pick?.classList.toggle('hidden', !!item.current)
  }
  function onKey(e: KeyboardEvent) {
    // Escape is NOT handled here — see `openLightbox`. The app's handler runs first whatever this
    // one does, so it is the one that has to know a lightbox is on top.
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1) }
    else return
  }

  const bar = el('div', 'lightbox-bar')
  let pick: HTMLButtonElement | null = null
  if (o.action) {
    pick = button({
      label: o.action.label,
      icon: o.action.icon,
      variant: 'primary',
      onClick: () => { o.action!.onPick(i); close() },
    })
    bar.append(pick)
  }
  bar.append(button({ icon: 'x-mark', variant: 'ghost', title: 'close', key: 'Esc', onClick: close }))

  if (o.items.length > 1) {
    root.append(
      button({ icon: 'chevron-left', variant: 'ghost', title: 'previous', onClick: () => step(-1) }),
    )
  }
  root.append(figure, bar)
  if (o.items.length > 1) {
    root.append(button({ icon: 'chevron-right', variant: 'ghost', title: 'next', onClick: () => step(1) }))
  }
  // A click on the backdrop closes; one on the picture does not, so dragging to compare is safe.
  root.addEventListener('pointerdown', (e) => { if (e.target === root) close() })
  // CAPTURE, because the editors bind their own Escape and arrow handlers on window and the
  // lightbox is on top of whatever raised it — the keys belong to it while it is open.
  addEventListener('keydown', onKey, true)
  openLightbox = close
  document.body.append(root)
  show()
  requestAnimationFrame(() => root.classList.add('in'))
}
