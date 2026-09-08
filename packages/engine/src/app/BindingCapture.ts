// Capturing a key for the rebind screen.
//
// Two problems with "press a key and we'll bind it". Escape is how you back out
// of the screen, so it can never be bound — and pause is exactly the action you
// want it on. And a press replaces what is there, so an action can only ever
// have one key, when the defaults happily carry two (Escape *and* P).
//
// So: tap a key to set it, hold a key to add it alongside what is already bound.
// Tapping Escape still backs out; holding Escape binds it, and only for actions
// that allow it (pause), because Escape on the throttle would be a trap.

export interface KeyDownSource {
  isDown(code: string): boolean
  onAny: ((code: string) => void) | null
}

export interface PadSource {
  onAny: ((binding: string) => void) | null
}

export interface BindingCaptureOptions {
  /** Seconds a key must be held to add it rather than replace. */
  hold?: number
  /** May Escape be bound to this action at all? */
  allowEscape?: boolean
  /** Poll interval in ms; also how often onProgress fires. */
  intervalMs?: number
  /** Bind: 'set' replaces the action's keys, 'add' appends to them. */
  onKey(code: string, mode: 'set' | 'add'): void
  onPad(binding: string): void
  /** Backed out without binding anything. */
  onCancel(): void
  /** How far through a hold we are, 0..1, for a progress meter. */
  onProgress?(fraction: number, code: string): void
}

export const HOLD_SECONDS = 0.7

export class BindingCapture {
  private readonly kb: KeyDownSource
  private readonly pad: PadSource
  private readonly opts: Required<Pick<BindingCaptureOptions, 'hold' | 'allowEscape' | 'intervalMs'>> & BindingCaptureOptions
  private timer: ReturnType<typeof setInterval> | null = null
  private code = ''
  private held = 0
  private lastAt = 0
  private done = false

  constructor(kb: KeyDownSource, pad: PadSource, opts: BindingCaptureOptions) {
    this.kb = kb
    this.pad = pad
    this.opts = { hold: HOLD_SECONDS, allowEscape: false, intervalMs: 40, ...opts }
    kb.onAny = (code) => this.press(code)
    pad.onAny = (b) => {
      if (this.done) return
      this.finish()
      this.opts.onPad(b)
    }
  }

  /** A key went down. Escape on an action that can't take it backs out at once, as it always did. */
  press(code: string): void {
    if (this.done || this.code) return
    if (code === 'Escape' && !this.opts.allowEscape) {
      this.finish()
      this.opts.onCancel()
      return
    }
    this.code = code
    this.held = 0
    this.lastAt = Date.now()
    this.opts.onProgress?.(0, code)
    // Real elapsed time, not one tick's worth per callback: under a heavy frame the interval fires
    // late, and counting ticks would stretch a 0.7 s hold into two seconds.
    this.timer = setInterval(() => {
      const now = Date.now()
      const dt = Math.max(0, (now - this.lastAt) / 1000)
      this.lastAt = now
      this.tick(dt)
    }, this.opts.intervalMs)
  }

  /** Advance the hold. Exposed for tests; normally the interval drives it. */
  tick(dt: number): void {
    if (this.done || !this.code) return
    const code = this.code
    if (!this.kb.isDown(code)) {
      // Released early: a tap.
      this.finish()
      if (code === 'Escape') this.opts.onCancel()
      else this.opts.onKey(code, 'set')
      return
    }
    this.held += dt
    if (this.held < this.opts.hold) {
      this.opts.onProgress?.(this.held / this.opts.hold, code)
      return
    }
    this.finish()
    this.opts.onKey(code, 'add')
  }

  /** Stop listening. Safe to call twice. */
  finish(): void {
    this.done = true
    this.code = ''
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    if (this.kb.onAny) this.kb.onAny = null
    if (this.pad.onAny) this.pad.onAny = null
  }

  /** True once a binding has been made or the capture was cancelled. */
  get finished(): boolean {
    return this.done
  }
}

/** Apply a capture to an action's key list: replace it, or add to it without duplicating. */
export function applyBinding(keys: string[] | undefined, code: string, mode: 'set' | 'add'): string[] {
  if (mode === 'set') return [code]
  const list = keys ? [...keys] : []
  if (!list.includes(code)) list.push(code)
  return list
}

/** A little text meter for the hold, drawn in fonts that only have ASCII. */
export function holdMeter(fraction: number): string {
  if (fraction <= 0) return ''
  const cells = 8
  const on = Math.max(1, Math.min(cells, Math.round(fraction * cells)))
  return `[${'='.repeat(on)}${'-'.repeat(cells - on)}]`
}
