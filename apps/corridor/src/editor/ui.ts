// Panel bits. No framework: the editor panel is a few dozen rows and a dozen sliders, and the
// scene is where the work happens.

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text) n.textContent = text
  return n
}

/**
 * A labelled range with its value, and a dot that tells you at a glance whether this knob is
 * still neutral — the whole point of an adjustment area is that almost every knob in it is.
 * Double-click the label to snap back to neutral.
 */
export function slider(label: string, value: number, min: number, max: number, step: number, neutral: number, note: string, onInput: (v: number) => void): HTMLElement {
  const wrap = el('label', 'field slider')
  wrap.title = `${note}. Double-click the label for neutral (${neutral}).`
  const name = el('span', '', label)
  const out = el('span', 'mono val')
  const range = document.createElement('input')
  range.type = 'range'
  range.min = String(min)
  range.max = String(max)
  range.step = String(step)
  range.value = String(value)
  const show = (v: number) => {
    out.textContent = v.toFixed(step < 0.1 ? 2 : 1)
    wrap.classList.toggle('off-neutral', Math.abs(v - neutral) > step / 2)
  }
  show(value)
  range.oninput = () => {
    const v = Number(range.value)
    show(v)
    onInput(v)
  }
  name.ondblclick = () => {
    range.value = String(neutral)
    show(neutral)
    onInput(neutral)
  }
  wrap.append(name, out, range)
  return wrap
}
