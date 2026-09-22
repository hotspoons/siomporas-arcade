// Form controls. Every field in both corridor UIs is one of these six things.
//
// They all share a shape — label on the left, value on the right, control below or inline — because
// the previous UI had sliders that looked like one thing in the tuning panel and another in the
// editor inspector, and the eye spends its attention learning the difference instead of reading
// the numbers.
import { icon, type IconName } from './icons'
import { el } from './shell'

/** A titled group of fields inside a panel. Collapsible when there are a lot of them. */
export function group(title: string, opts: { collapsed?: boolean; note?: string } = {}): HTMLElement {
  const g = el('section', 'group')
  const head = el('button', 'group-head')
  head.append(icon('chevron-down', 14), el('span', '', title))
  const bodyEl = el('div', 'group-body')
  if (opts.note) bodyEl.append(el('p', 'group-note', opts.note))
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
  name.ondblclick = () => {
    range.value = String(neutral)
    show(neutral)
    o.onInput(neutral)
  }
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
  onChange: (v: string) => void
}): HTMLElement {
  const wrap = el('label', 'field text')
  wrap.append(el('span', 'field-label', o.label))
  const i = el('input', 'input')
  i.type = o.type ?? 'text'
  if (o.step) i.step = String(o.step)
  i.value = o.value
  i.onchange = () => o.onChange(i.value)
  wrap.append(i)
  return wrap
}

/** An empty-state line, so a panel with nothing in it still says something. */
export function empty(message: string): HTMLElement {
  return el('p', 'empty', message)
}
