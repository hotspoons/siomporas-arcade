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

/** The one open dialog, if any — so Escape and the scrim know what they are closing. */
let openDialog: Dialog | null = null

/** A tiny registry, so opening a dialog does not read as assigning `this` to a loose variable. */
function registerOpen(d: Dialog | null) {
  openDialog = d
}

export interface DialogOpts {
  title: string
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

  private o: DialogOpts

  constructor(o: DialogOpts) {
    this.o = o
    this.panel.classList.add(`size-${o.size ?? 'md'}`)
    this.panel.setAttribute('role', 'dialog')
    this.panel.setAttribute('aria-modal', 'true')
    this.panel.setAttribute('aria-label', o.title)

    const head = el('header', 'dialog-head')
    if (o.icon) head.append(icon(o.icon, 18))
    head.append(el('h2', '', o.title))
    head.append(button({ icon: 'x-mark', variant: 'ghost', title: 'close', key: 'Esc', onClick: () => this.close() }))
    this.panel.append(head, this.body, this.foot)
    this.foot.hidden = true
    this.root.append(this.panel)

    // A click on the backdrop closes; a click that started inside and ended outside does not,
    // which is what makes dragging a slider to the edge of the dialog survivable.
    this.root.addEventListener('pointerdown', (e) => {
      if (e.target === this.root) this.close()
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
    const focusable = this.panel.querySelector<HTMLElement>('button, [href], input, select, textarea')
    focusable?.focus()
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
      if (openDialog) {
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
