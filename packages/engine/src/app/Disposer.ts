// A list of undo operations. When a game only ever ran until the tab closed, leaking a `resize`
// listener cost nothing; in the arcade a game is mounted and thrown away every time someone
// changes their mind at the marquees, and the tenth `resize` handler is still holding the ninth
// dead renderer alive. So anything that outlives its object — a window listener, a GPU resource, a
// timer, an AudioContext — is registered here as it is made, and undone in one call.
//
// Register at the point of creation, never in a separate teardown method: a `dispose()` written
// somewhere else is a list that silently falls out of step with the list of things it undoes.

export class Disposer {
  private readonly undo: Array<() => void> = []
  private done = false

  /** Register an arbitrary undo. Runs last-registered-first, like unwinding a stack. */
  add(fn: () => void): void {
    if (this.done) {
      fn()
      return
    }
    this.undo.push(fn)
  }

  /** `addEventListener`, with the matching `removeEventListener` already booked in. */
  on<K extends keyof WindowEventMap>(target: Window, type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions): void
  on<K extends keyof DocumentEventMap>(target: Document, type: K, fn: (e: DocumentEventMap[K]) => void, opts?: AddEventListenerOptions): void
  on<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions): void
  on(target: EventTarget, type: string, fn: EventListenerOrEventListenerObject, opts?: AddEventListenerOptions): void
  on(target: EventTarget, type: string, fn: EventListenerOrEventListenerObject, opts?: AddEventListenerOptions): void {
    target.addEventListener(type, fn, opts)
    this.add(() => target.removeEventListener(type, fn, opts))
  }

  /** Whether everything registered has already been undone. */
  get disposed(): boolean {
    return this.done
  }

  /**
   * Undo everything, newest first. Safe to call twice, and one throwing undo does not strand the
   * rest — a half-disposed game is worse than a noisy console.
   */
  run(): void {
    if (this.done) return
    this.done = true
    for (let i = this.undo.length - 1; i >= 0; i--) {
      try {
        this.undo[i]()
      } catch (err) {
        console.error('[dispose]', err)
      }
    }
    this.undo.length = 0
  }
}
