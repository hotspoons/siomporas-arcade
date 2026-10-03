// Form controls. Every field in both corridor UIs is one of these six things.
//
// They all share a shape — label on the left, value on the right, control below or inline — because
// the previous UI had sliders that looked like one thing in the tuning panel and another in the
// editor inspector, and the eye spends its attention learning the difference instead of reading
// the numbers.
import { icon, type IconName } from './icons'
import { el } from './shell'

/** A titled group of fields inside a panel. Collapsible when there are a lot of them. */
export function group(title: string, opts: { collapsed?: boolean; note?: string; actions?: HTMLElement[] } = {}): HTMLElement {
  const g = el('section', 'group')
  const head = el('button', 'group-head')
  head.append(icon('chevron-down', 14), el('span', '', title))
  const bodyEl = el('div', 'group-body')
  if (opts.note) bodyEl.append(el('p', 'group-note', opts.note))
  // A group's own buttons (reset this section, say) sit at the right of its heading — NOT inside
  // the heading, which is itself a button: a button inside a button is invalid, and the click
  // would toggle the group as well as doing whatever it was for.
  if (opts.actions?.length) {
    const bar = el('div', 'group-actions')
    bar.append(...opts.actions)
    bar.addEventListener('click', (e) => e.stopPropagation())
    g.append(bar)
  }
  head.onclick = () => {
    const open = g.classList.toggle('collapsed')
    head.setAttribute('aria-expanded', String(!open))
  }
  if (opts.collapsed) g.classList.add('collapsed')
  g.append(head, bodyEl)
  // the group's children go in the body, not on the group itself
  Object.defineProperty(g, 'body', { value: bodyEl })
  return g
}

/** Where a group's fields go. `group()` returns the wrapper; this is its body. */
export function bodyOf(g: HTMLElement): HTMLElement {
  return (g as unknown as { body: HTMLElement }).body ?? g
}

/**
 * A labelled range with a live readout and a neutral marker.
 *
 * `neutral` is the value the knob has when it is not doing anything. A dot beside a knob that has
 * been moved off neutral is the fastest way to answer "what have I actually changed here", which
 * on a panel of two hundred sliders is the only question that matters. Double-click the label to
 * put it back.
 */
export function slider(o: {
  label: string
  value: number
  min: number
  max: number
  step: number
  neutral?: number
  note?: string
  unit?: string
  onInput: (v: number) => void
  /** show a reset button that puts this one knob back to `neutral` */
  resettable?: boolean
  /**
   * Handed a function that moves the control to a value WITHOUT calling `onInput`.
   *
   * For when something other than this control is the source of truth — a preset tween writing
   * the knob every frame, say. The obvious way to redraw a slider is to set `range.value` and
   * dispatch an `input` event, and that is wrong in two ways at once: the browser snaps the range
   * to `step` first, so a tween through a 0.05-step slider moves in twenty visible jumps; and the
   * dispatch re-enters `onInput`, so every programmatic set is indistinguishable from a drag.
   */
  onSync?: (set: (v: number) => void) => void
}): HTMLElement {
  const wrap = el('label', 'field slider')
  const neutral = o.neutral ?? o.value
  wrap.title = o.note ? `${o.note}. Double-click the label for neutral (${neutral}).` : `Double-click the label for neutral (${neutral}).`

  const head = el('div', 'field-head')
  const name = el('span', 'field-label', o.label)
  const out = el('output', 'field-value')
  head.append(name, out)

  const range = el('input', 'range')
  range.type = 'range'
  range.min = String(o.min)
  range.max = String(o.max)
  range.step = String(o.step)
  range.value = String(o.value)

  const decimals = o.step < 0.01 ? 3 : o.step < 0.1 ? 2 : o.step < 1 ? 1 : 0
  const show = (v: number) => {
    out.textContent = v.toFixed(decimals) + (o.unit ? ` ${o.unit}` : '')
    wrap.classList.toggle('off-neutral', Math.abs(v - neutral) > o.step / 2)
  }
  show(o.value)
  range.oninput = () => {
    const v = Number(range.value)
    show(v)
    o.onInput(v)
  }
  const toNeutral = () => {
    range.value = String(neutral)
    show(neutral)
    o.onInput(neutral)
  }
  name.ondblclick = toNeutral
  // Double-clicking the label has always done this, but a keyboard-free affordance nobody can see
  // is not an affordance (Rich, 2026-09-26: "reset buttons on individual items"). The button shows
  // only when the knob is off neutral, so a panel of two hundred sliders still reads as a list.
  if (o.resettable) {
    const reset = el('button', 'field-reset')
    reset.type = 'button'
    reset.title = `back to ${neutral}`
    reset.append(icon('arrow-uturn-left', 12))
    reset.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      toNeutral()
    })
    head.append(reset)
  }
  o.onSync?.((v) => {
    // the readout shows the REAL value; the range itself can only sit on the step grid
    range.value = String(v)
    show(v)
  })
  wrap.append(head, range)
  return wrap
}

/** A switch. Used for every layer and every boolean setting. */
export function toggle(o: { label: string; value: boolean; note?: string; onChange: (v: boolean) => void }): HTMLElement {
  const wrap = el('label', 'field switch')
  if (o.note) wrap.title = o.note
  const input = el('input')
  input.type = 'checkbox'
  input.checked = o.value
  input.onchange = () => o.onChange(input.checked)
  const track = el('span', 'switch-track')
  track.append(el('span', 'switch-thumb'))
  wrap.append(input, track, el('span', 'field-label', o.label))
  return wrap
}

/** A layer toggle: a switch that reads as an eye, for the long lists of them. */
export function layerToggle(o: { label: string; value: boolean; onChange: (v: boolean) => void }): HTMLElement {
  const wrap = el('label', 'field layer')
  const input = el('input')
  input.type = 'checkbox'
  input.checked = o.value
  const on = icon('eye', 16)
  const off = icon('eye-slash', 16)
  off.classList.add('off')
  const sync = () => {
    wrap.classList.toggle('on', input.checked)
    on.style.display = input.checked ? '' : 'none'
    off.style.display = input.checked ? 'none' : ''
  }
  input.onchange = () => {
    sync()
    o.onChange(input.checked)
  }
  sync()
  wrap.append(input, on, off, el('span', 'field-label', o.label))
  return wrap
}

export function select<T extends string>(o: {
  label?: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  /** a line under it, for what the recipe said about this choice */
  note?: string
}): HTMLElement {
  const wrap = el('label', 'field select')
  if (o.label) wrap.append(el('span', 'field-label', o.label))
  const s = el('select')
  for (const opt of o.options) {
    const n = el('option', '', opt.label)
    n.value = opt.value
    s.append(n)
  }
  s.value = o.value
  s.onchange = () => o.onChange(s.value as T)
  const box = el('div', 'select-box')
  box.append(s, icon('chevron-down', 14))
  wrap.append(box)
  // the note goes UNDER, which means the field stops being one flex row
  if (o.note) {
    wrap.classList.add('with-note')
    wrap.append(el('span', 'field-note', o.note))
  }
  return wrap
}

/** A row of mutually exclusive choices — modes, seasons, quality. */
export function segmented<T extends string>(o: {
  value: T
  options: { value: T; label: string; icon?: IconName; key?: string }[]
  onChange: (v: T) => void
}): HTMLElement {
  const wrap = el('div', 'segmented')
  wrap.setAttribute('role', 'tablist')
  const buttons = new Map<T, HTMLButtonElement>()
  for (const opt of o.options) {
    const b = el('button', 'seg')
    // the value, so a caller can set the control from outside without matching on label text
    b.dataset.value = opt.value
    if (opt.icon) b.append(icon(opt.icon, 16))
    b.append(el('span', '', opt.label))
    if (opt.key) b.title = `${opt.label} (${opt.key})`
    b.onclick = () => {
      for (const [k, n] of buttons) n.classList.toggle('on', k === opt.value)
      o.onChange(opt.value)
    }
    buttons.set(opt.value, b)
    wrap.append(b)
  }
  buttons.get(o.value)?.classList.add('on')
  return wrap
}

/** A read-only label/value pair. The site info panel is a stack of these. */
export function readout(label: string, value: string, mono = true): HTMLElement {
  const r = el('div', 'readout')
  r.append(el('span', 'field-label', label), el('span', `field-value${mono ? ' mono' : ''}`, value))
  return r
}

/** A free-text or numeric input, for the editor's inspectors. */
export function textField(o: {
  label: string
  value: string
  type?: 'text' | 'number'
  step?: number
  /**
   * The SHAPE of what goes here, shown while it is empty.
   *
   * Not a substitute for the label — a placeholder that disappears the moment you type is a label
   * you cannot re-read. This is for the cases where the shape is the hard part: a scenario
   * condition is `<fact> <op> <number>` and nothing about a box called "when" says so.
   */
  placeholder?: string
  /** a line under it, in the smaller ink — what the field is for, not what to type */
  note?: string
  onChange: (v: string) => void
  /**
   * A secret: masked, with a show/hide button once something is typed.
   *
   * It stays `type="text"`. A `type="password"` field is what Chrome's password manager claims,
   * and it then offers to save and fill a token that is not a login. The discs are
   * `-webkit-text-security`, which the manager does not treat as a password.
   */
  secret?: boolean
  /**
   * Every keystroke, for a field whose whole job is to filter a list as you type.
   *
   * `onChange` fires on blur, which is right for a value being EDITED and wrong for a search box —
   * you type three letters and nothing happens until you click elsewhere. `textArea` already had
   * this pair for the same reason; this is the same shape, not a new idea.
   */
  onInput?: (v: string) => void
}): HTMLElement {
  const wrap = el('label', 'field text')
  wrap.append(el('span', 'field-label', o.label))
  // A numeric field wants to be narrow and aligned; a text one wants the room. The first cut gave
  // both the 9ch that suits a number, and an asset's subject line truncated to "a rural".
  const i = el('input', `input${(o.type ?? 'text') === 'text' ? ' wide' : ''}`)
  i.type = o.type ?? 'text'
  if (o.step) i.step = String(o.step)
  i.value = o.value
  if (o.placeholder) i.placeholder = o.placeholder
  i.onchange = () => o.onChange(i.value)
  if (o.onInput) i.oninput = () => o.onInput!(i.value)
  // the library's own shortcuts must not fire while somebody is typing a search
  i.onkeydown = (e) => e.stopPropagation()
  if (o.secret) {
    i.autocomplete = 'off'
    i.spellcheck = false
    i.autocapitalize = 'off'
    i.setAttribute('autocorrect', 'off')
    i.setAttribute('data-1p-ignore', '')
    i.setAttribute('data-lpignore', 'true')
    i.setAttribute('data-form-type', 'other')
    const box = el('span', 'secret-box')
    const reveal = el('button', 'btn ghost icon-only secret-reveal')
    reveal.type = 'button'
    let shown = false
    const sync = () => {
      const filled = i.value.length > 0
      box.classList.toggle('has-value', filled)
      i.classList.toggle('masked', !shown)
      reveal.replaceChildren(icon(shown ? 'eye-slash' : 'eye', 16))
      reveal.title = shown ? 'hide' : 'show'
      reveal.setAttribute('aria-label', shown ? 'hide' : 'show')
      reveal.setAttribute('aria-pressed', String(shown))
      if (!filled) reveal.tabIndex = -1
      else reveal.removeAttribute('tabindex')
    }
    reveal.onclick = (e) => {
      e.preventDefault()
      e.stopPropagation()
      shown = !shown
      sync()
      i.focus()
    }
    i.addEventListener('input', sync)
    box.append(i, reveal)
    wrap.append(box)
    wrap.classList.add('secret')
    sync()
  } else wrap.append(i)
  if (o.note) {
    wrap.classList.add('with-note')
    wrap.append(el('span', 'field-note', o.note))
  }
  return wrap
}

/**
 * A multi-line field, for the text that is too long to be a line.
 *
 * A prompt is 1,600 characters. Shown as `1640 chars` it cannot be read, let alone corrected — and
 * a recipe's prompt is exactly the thing somebody wants to correct (Rich, 2026-09-28: "how am I
 * supposed to see or edit the prompt?"). It grows to fit what is in it, up to a cap, because a
 * four-line box with a scrollbar inside a panel that also scrolls is two scrollbars for one text.
 */
export function textArea(o: {
  label: string
  value: string
  placeholder?: string
  note?: string
  rows?: number
  mono?: boolean
  onChange: (v: string) => void
  onInput?: (v: string) => void
}): HTMLElement {
  const wrap = el('label', 'field area')
  wrap.append(el('span', 'field-label', o.label))
  const t = el('textarea', `input area${o.mono ? ' mono' : ''}`)
  t.value = o.value
  t.rows = o.rows ?? 6
  t.spellcheck = false
  if (o.placeholder) t.placeholder = o.placeholder
  const grow = () => {
    t.style.height = 'auto'
    t.style.height = `${Math.min(420, t.scrollHeight + 2)}px`
  }
  t.oninput = () => { grow(); o.onInput?.(t.value) }
  t.onchange = () => o.onChange(t.value)
  // the editor's own shortcuts must not fire while somebody is typing into this
  t.onkeydown = (e) => e.stopPropagation()
  wrap.append(t)
  if (o.note) wrap.append(el('span', 'field-note', o.note))
  requestAnimationFrame(grow)
  return wrap
}

/**
 * Rebuild a panel's contents without throwing away where somebody had scrolled to.
 *
 * Every one of these panels re-renders by replacing its children, which resets `scrollTop` to
 * zero. On a short panel nobody notices; on the Assets panel, pressing Draw — which is near the
 * bottom, under a 1,600-character prompt — threw the view back to the top (Rich, 2026-09-28:
 * "clicking draw locally scrolls you to the top of the form"). The button you just pressed
 * vanishing upward reads as the page having navigated.
 *
 * Restored twice on purpose: once synchronously, which is right when the new content is at least
 * as tall, and once after a frame, for when it is not yet — an image that has not loaded has no
 * height, so the first restore is clamped to a container that is about to grow.
 */
export function keepScroll(host: HTMLElement, rebuild: () => void): void {
  const box = scroller(host)
  const at = box?.scrollTop ?? 0
  rebuild()
  if (!box || !at) return
  box.scrollTop = at
  requestAnimationFrame(() => { if (box.scrollTop !== at) box.scrollTop = at })
}

/** The nearest thing that actually scrolls — the panel body, usually, not the panel. */
function scroller(from: HTMLElement): HTMLElement | null {
  for (let n: HTMLElement | null = from; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY
    if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight) return n
  }
  return null
}

/** An empty-state line, so a panel with nothing in it still says something. */
export function empty(message: string): HTMLElement {
  return el('p', 'empty', message)
}

/*
 * ERRORS BELONG ON THE FIELD, NOT IN A TOAST.
 *
 * Rich, 2026-09-28: "need error marking on forms (e.g. red outline on text boxes) and focus
 * handling for things like 'give it a slug first' and no toast for this, just show it on the form
 * and hide once you start filling."
 *
 * A toast says what is wrong somewhere else on the screen, for four seconds, and then takes the
 * message away — so it cannot be re-read, it does not say WHICH field, and on a form long enough
 * to scroll the field it is about may not even be in view. The three things a person needs are
 * the message, the place, and the way back: the outline marks the place, the focus is the way
 * back, and the message stays until they start fixing it.
 */

/** Which element inside a field actually takes focus. */
function control(field: HTMLElement): HTMLElement | null {
  return field.querySelector<HTMLElement>('input, select, textarea')
}

/**
 * Mark a field wrong, or clear it with `null`.
 *
 * Clears itself on the first keystroke: "hide once you start filling". On `input` rather than
 * `change`, so it goes the moment they start rather than when they leave the field — the error is
 * about a field being empty, and it stops being empty at the first character, not at blur.
 */
export function setFieldError(field: HTMLElement, message: string | null): void {
  const input = control(field)
  const existing = field.querySelector<HTMLElement>('.field-error')
  if (!message) {
    field.classList.remove('invalid')
    input?.removeAttribute('aria-invalid')
    existing?.remove()
    return
  }
  field.classList.add('invalid')
  input?.setAttribute('aria-invalid', 'true')
  const line = existing ?? el('p', 'field-error')
  line.textContent = message
  // aria-describedby so a screen reader reads the reason with the field, not as a loose paragraph
  if (input) {
    const id = line.id || `err-${Math.random().toString(36).slice(2, 9)}`
    line.id = id
    input.setAttribute('aria-describedby', id)
  }
  if (!existing) field.append(line)
  input?.addEventListener('input', () => setFieldError(field, null), { once: true })
}

/** Put the cursor in the first field that is wrong and scroll it into view. */
export function focusField(field: HTMLElement): void {
  const input = control(field)
  // `block: 'nearest'` rather than 'center': on a form that scrolls under a sticky button bar,
  // centring a field near the end of the form leaves it behind the bar.
  field.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  input?.focus()
}

/**
 * The same, for something that is not a field at all.
 *
 * Not every requirement is a text box. "Drag an area on the map" is about the map, and the only
 * thing on the form that represents it is the group heading it sits under — so the message goes
 * there, and the focus goes to whichever control in the group can take it (the "use the current
 * view" button), which is also the one that can satisfy the requirement without the map.
 */
export function setGroupError(g: HTMLElement, message: string | null): void {
  const body = bodyOf(g)
  const existing = g.querySelector<HTMLElement>(':scope > .group-error, .group-body > .group-error')
  if (!message) {
    g.classList.remove('invalid')
    existing?.remove()
    return
  }
  g.classList.add('invalid')
  const line = existing ?? el('p', 'group-error')
  line.textContent = message
  if (!existing) body.prepend(line)
  // cleared by whatever satisfies it, which the caller signals by calling again with null
}
