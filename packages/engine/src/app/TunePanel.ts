// Live tuning panel: sliders over a game's tunable constants, persisted per
// game in localStorage, with Copy JSON (paste it back to whoever maintains the
// defaults) / Paste / Reset. Games describe their knobs as TuneKey lists.

export interface TuneKey {
  name: string
  get: () => number
  set: (v: number) => void
  default: number
  min: number
  max: number
  step: number
  /** Optional note shown under the label. */
  hint?: string
}

export interface TuneSection {
  title: string
  keys: TuneKey[]
}

/** Build a TuneKey with sensible auto ranges around the default. */
export function tune(name: string, get: () => number, set: (v: number) => void, range?: [number, number], step?: number, hint?: string): TuneKey {
  const d = get()
  const mag = Math.abs(d) || 1
  const min = range ? range[0] : d >= 0 ? 0 : -mag * 3
  const max = range ? range[1] : d >= 0 ? mag * 3 : mag * 3
  const st = step ?? Math.pow(10, Math.floor(Math.log10(mag)) - 2)
  return { name, get, set, default: d, min, max, step: st, hint }
}

export class TunePanel {
  readonly el: HTMLElement
  private readonly key: string
  private readonly sections: TuneSection[]
  private readonly game: string
  private visible = false
  private readonly inputs = new Map<string, HTMLInputElement>()
  private readonly numbers = new Map<string, HTMLInputElement>()
  onChange: ((name: string, value: number) => void) | null = null

  constructor(parent: HTMLElement, game: string, sections: TuneSection[]) {
    this.game = game
    this.key = `apex-${game}.tune.v1`
    this.sections = sections
    this.el = document.createElement('div')
    this.el.className = 'tune hidden'
    if (!document.getElementById('apex-tune-css')) {
      const st = document.createElement('style')
      st.id = 'apex-tune-css'
      st.textContent = TUNE_CSS
      document.head.appendChild(st)
    }
    this.build()
    parent.appendChild(this.el)
    this.load()
  }

  /** Apply saved overrides. Call before anything caches a tunable. */
  private load(): void {
    try {
      const raw = localStorage.getItem(this.key)
      if (!raw) return
      const saved = JSON.parse(raw) as Record<string, number>
      for (const s of this.sections) for (const k of s.keys) if (typeof saved[k.name] === 'number') k.set(saved[k.name])
      this.refresh()
    } catch {
      /* ignore */
    }
  }

  private save(): void {
    const out: Record<string, number> = {}
    for (const s of this.sections) for (const k of s.keys) if (k.get() !== k.default) out[k.name] = k.get()
    try {
      localStorage.setItem(this.key, JSON.stringify(out))
    } catch {
      /* ignore */
    }
  }

  toggle(force?: boolean): boolean {
    this.visible = force ?? !this.visible
    this.el.classList.toggle('hidden', !this.visible)
    if (this.visible) this.refresh()
    return this.visible
  }

  get isVisible(): boolean {
    return this.visible
  }

  /** Everything, plus which ones differ from the shipped defaults. */
  toJSON(): string {
    const values: Record<string, number> = {}
    const changed: Record<string, { from: number; to: number }> = {}
    for (const s of this.sections)
      for (const k of s.keys) {
        values[k.name] = round(k.get())
        if (k.get() !== k.default) changed[k.name] = { from: k.default, to: round(k.get()) }
      }
    return JSON.stringify({ game: this.game, changed, values }, null, 2)
  }

  applyJSON(text: string): number {
    const data = JSON.parse(text) as { values?: Record<string, number>; changed?: Record<string, { to: number }> } | Record<string, number>
    const values: Record<string, number> = {}
    if ('values' in data && data.values) Object.assign(values, data.values)
    else if ('changed' in data && data.changed) for (const [k, v] of Object.entries(data.changed)) values[k] = v.to
    else Object.assign(values, data as Record<string, number>)
    let n = 0
    for (const s of this.sections)
      for (const k of s.keys)
        if (typeof values[k.name] === 'number') {
          k.set(values[k.name])
          this.onChange?.(k.name, values[k.name])
          n++
        }
    this.save()
    this.refresh()
    return n
  }

  reset(): void {
    for (const s of this.sections)
      for (const k of s.keys) {
        k.set(k.default)
        this.onChange?.(k.name, k.default)
      }
    this.save()
    this.refresh()
  }

  private refresh(): void {
    for (const s of this.sections)
      for (const k of s.keys) {
        const v = k.get()
        const r = this.inputs.get(k.name)
        const n = this.numbers.get(k.name)
        if (r) r.value = String(v)
        if (n) n.value = String(round(v))
        r?.parentElement?.classList.toggle('changed', v !== k.default)
      }
  }

  private build(): void {
    const head = document.createElement('div')
    head.className = 'tune-head'
    head.innerHTML = `<strong>TUNING · ${this.game.toUpperCase()}</strong><span class="tune-hint">F6 toggles · drag sliders, the game updates live · changes persist in this browser</span>`
    const actions = document.createElement('div')
    actions.className = 'tune-actions'
    for (const [label, act] of [
      ['Copy JSON', 'copy'],
      ['Paste JSON', 'paste'],
      ['Reset all', 'reset'],
      ['Close', 'close'],
    ]) {
      const b = document.createElement('button')
      b.textContent = label
      b.dataset.act = act
      actions.appendChild(b)
    }
    const status = document.createElement('div')
    status.className = 'tune-status'
    actions.appendChild(status)
    head.appendChild(actions)
    this.el.appendChild(head)
    const body = document.createElement('div')
    body.className = 'tune-body'
    this.el.appendChild(body)
    for (const s of this.sections) {
      const sec = document.createElement('section')
      const h = document.createElement('h3')
      h.textContent = s.title
      sec.appendChild(h)
      for (const k of s.keys) {
        const row = document.createElement('label')
        row.className = 'tune-row'
        const name = document.createElement('span')
        name.className = 'tune-name'
        name.textContent = k.name
        if (k.hint) name.title = k.hint
        const range = document.createElement('input')
        range.type = 'range'
        range.min = String(k.min)
        range.max = String(k.max)
        range.step = String(k.step)
        range.value = String(k.get())
        const num = document.createElement('input')
        num.type = 'number'
        num.step = String(k.step)
        num.value = String(round(k.get()))
        const apply = (v: number) => {
          if (!Number.isFinite(v)) return
          k.set(v)
          this.onChange?.(k.name, v)
          this.save()
          range.value = String(v)
          num.value = String(round(v))
          row.classList.toggle('changed', v !== k.default)
        }
        range.addEventListener('input', () => apply(Number(range.value)))
        num.addEventListener('change', () => apply(Number(num.value)))
        const def = document.createElement('button')
        def.className = 'tune-def'
        def.textContent = '↺'
        def.title = `default ${round(k.default)}`
        def.addEventListener('click', (e) => {
          e.preventDefault()
          apply(k.default)
        })
        row.append(name, range, num, def)
        sec.appendChild(row)
        this.inputs.set(k.name, range)
        this.numbers.set(k.name, num)
      }
      body.appendChild(sec)
    }
    // Keep keyboard focus out of the game and stop keys leaking to the input map.
    this.el.addEventListener('keydown', (e) => e.stopPropagation())
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation())
    this.el.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).dataset.act
      if (!act) return
      e.preventDefault()
      if (act === 'copy') {
        const json = this.toJSON()
        navigator.clipboard?.writeText(json).then(
          () => (status.textContent = 'Copied. Paste it back to the maintainer to set new defaults.'),
          () => this.showText(json),
        )
        this.showText(json)
      } else if (act === 'paste') {
        const text = prompt('Paste tuning JSON')
        if (text) {
          try {
            status.textContent = `Applied ${this.applyJSON(text)} values.`
          } catch {
            status.textContent = 'Could not parse that.'
          }
        }
      } else if (act === 'reset') this.reset()
      else if (act === 'close') this.toggle(false)
    })
  }

  private showText(json: string): void {
    let ta = this.el.querySelector('textarea')
    if (!ta) {
      ta = document.createElement('textarea')
      ta.readOnly = true
      ta.rows = 6
      this.el.querySelector('.tune-head')!.appendChild(ta)
    }
    ta.value = json
    ta.select()
  }
}

function round(v: number): number {
  return Math.round(v * 10000) / 10000
}

export const TUNE_CSS = `
.tune.hidden { display: none; }
.tune { position: absolute; top: 0; right: 0; bottom: 0; width: min(440px, 92vw); z-index: 8; background: rgba(8,10,20,0.94); color: #e8f6ff; font: 12px ui-monospace, monospace; display: flex; flex-direction: column; border-left: 1px solid rgba(255,255,255,0.15); pointer-events: auto; }
.tune-head { padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.12); }
.tune-head strong { letter-spacing: 0.2em; display: block; margin-bottom: 4px; }
.tune-hint { opacity: 0.6; display: block; margin-bottom: 8px; }
.tune-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.tune-actions button, .tune-def { font: inherit; color: #e8f6ff; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); padding: 4px 8px; border-radius: 3px; cursor: pointer; }
.tune-status { flex-basis: 100%; opacity: 0.75; min-height: 1em; }
.tune-head textarea { width: 100%; margin-top: 8px; font: 11px ui-monospace, monospace; background: #050710; color: #cfe; border: 1px solid rgba(255,255,255,0.2); }
.tune-body { overflow: auto; padding: 6px 12px 12px; }
.tune-body h3 { margin: 12px 0 4px; font-size: 11px; letter-spacing: 0.25em; opacity: 0.6; }
.tune-row { display: grid; grid-template-columns: 1fr 120px 64px 24px; gap: 6px; align-items: center; padding: 3px 0; }
.tune-row.changed .tune-name { color: #ffc857; }
.tune-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tune-row input[type=number] { font: inherit; width: 64px; background: #0a0d18; color: #e8f6ff; border: 1px solid rgba(255,255,255,0.2); padding: 2px 4px; }
.tune-row input[type=range] { width: 100%; }
.tune-def { padding: 0 4px; }
`
