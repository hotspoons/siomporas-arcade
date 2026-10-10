// The two sounds a menu makes. Synthesised, because the viewer ships no samples and a 40 ms blip
// is not worth a network round-trip; on their own context, because the engine's is created from
// the drive gesture and may not exist yet when the first menu opens.
//
// The context is made lazily from the first call, which is always inside a key or pad handler's
// frame — close enough to a user gesture that browsers allow it; if one does not, `resume()`
// fails quietly and the menu is simply silent until the next gesture.

export class UiSound {
  private ctx: AudioContext | null = null
  private gainNode: GainNode | null = null
  /** 0..1, from the settings (master × sfx, or 0 when muted) */
  gain = 0.5

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx
    if (typeof AudioContext === 'undefined') return null
    try {
      this.ctx = new AudioContext({ latencyHint: 'interactive' })
      this.gainNode = this.ctx.createGain()
      this.gainNode.connect(this.ctx.destination)
    } catch {
      this.ctx = null
    }
    return this.ctx
  }

  private blip(freq: number, ms: number, level: number): void {
    if (this.gain <= 0) return
    const ctx = this.ensure()
    if (!ctx || !this.gainNode) return
    if (ctx.state === 'suspended') void ctx.resume().catch(() => { /* not yet allowed */ })
    this.gainNode.gain.value = this.gain
    const t0 = ctx.currentTime
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(freq, t0)
    env.gain.setValueAtTime(0, t0)
    env.gain.linearRampToValueAtTime(level, t0 + 0.004)
    env.gain.exponentialRampToValueAtTime(0.001, t0 + ms / 1000)
    osc.connect(env)
    env.connect(this.gainNode)
    osc.start(t0)
    osc.stop(t0 + ms / 1000 + 0.01)
  }

  /** the cursor moved */
  move(): void {
    this.blip(880, 35, 0.18)
  }

  /** something was chosen */
  select(): void {
    this.blip(1320, 70, 0.22)
  }

  /** the menu opened or closed */
  open(): void {
    this.blip(660, 60, 0.2)
  }

  /**
   * The finish screen's sting: a rising major arpeggio for a win, a falling minor one for anything
   * else. Synthesised like the blips and on the same bus (master × interface, or nothing when
   * muted): the sound bank has crashes, guns and tyres and nothing that sounds like an ending.
   */
  sting(win: boolean): void {
    const notes = win ? [523.25, 659.25, 783.99, 1046.5] : [440, 349.23, 293.66]
    notes.forEach((f, i) => this.later(i * (win ? 0.09 : 0.14), () => this.blip(f, i === notes.length - 1 ? 520 : 160, 0.2)))
  }

  private later(s: number, fn: () => void): void {
    if (s <= 0) fn()
    else setTimeout(fn, s * 1000)
  }
}
