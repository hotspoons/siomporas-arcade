// Keyboard + mouse buttons. Holds a set of pressed codes; edges are recorded
// so a press between two polls is never lost.

export class KeyboardSource {
  readonly down = new Set<string>()
  private readonly pressed = new Set<string>()
  /** Codes pressed since the last poll (edge). */
  private readonly edges = new Set<string>()
  /**
   * The edges of the frame that was just polled, kept until the next one starts. Game code often reads
   * keys *after* calling poll() — a replay's transport keys, say — and without this those reads would
   * all be false, because poll() ends by clearing the edge set.
   */
  private readonly frameEdges = new Set<string>()
  lastCode = ''
  onAny: ((code: string) => void) | null = null

  attach(target: Window): void {
    target.addEventListener('keydown', this.onKeyDown, { passive: false })
    target.addEventListener('keyup', this.onKeyUp)
    target.addEventListener('blur', this.onBlur)
    target.addEventListener('mousedown', this.onMouseDown)
    target.addEventListener('mouseup', this.onMouseUp)
    target.addEventListener('contextmenu', this.onContext)
  }

  detach(target: Window): void {
    target.removeEventListener('keydown', this.onKeyDown)
    target.removeEventListener('keyup', this.onKeyUp)
    target.removeEventListener('blur', this.onBlur)
    target.removeEventListener('mousedown', this.onMouseDown)
    target.removeEventListener('mouseup', this.onMouseUp)
    target.removeEventListener('contextmenu', this.onContext)
  }

  isDown(code: string): boolean {
    return this.down.has(code)
  }

  wasPressed(code: string): boolean {
    return this.edges.has(code) || this.frameEdges.has(code)
  }

  /** Any key pressed this frame, for "press any key" prompts. */
  get anyEdge(): boolean {
    return this.edges.size > 0 || this.frameEdges.size > 0
  }

  /** Start of a frame: last frame's edges are done with. */
  beginFrame(): void {
    this.frameEdges.clear()
  }

  /** Hand the edges to the rest of the frame, so reads after poll() still see them. */
  endFrame(): void {
    for (const c of this.edges) this.frameEdges.add(c)
    this.edges.clear()
  }

  private press(code: string): void {
    if (!this.pressed.has(code)) {
      this.pressed.add(code)
      this.edges.add(code)
      this.lastCode = code
      this.onAny?.(code)
    }
    this.down.add(code)
  }

  private release(code: string): void {
    this.pressed.delete(code)
    this.down.delete(code)
  }

  private readonly onKeyDown = (e: KeyboardEvent) => {
    // The canvas is the whole app; nothing here should scroll the document.
    if (e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'Tab') e.preventDefault()
    if (e.repeat) return
    // Reserved for the browser / devtools.
    if (e.code === 'F5' || e.code === 'F12' || (e.ctrlKey && e.code !== 'ControlLeft')) return
    if (e.code === 'F2' || e.code === 'F3' || e.code === 'F4') e.preventDefault()
    this.press(e.code)
  }

  private readonly onKeyUp = (e: KeyboardEvent) => this.release(e.code)

  private readonly onBlur = () => {
    // Held keys would otherwise stick on alt-tab and fly you into a wall.
    this.down.clear()
    this.pressed.clear()
  }

  private readonly onMouseDown = (e: MouseEvent) => {
    if ((e.target as HTMLElement | null)?.closest?.('.menu, button, input, select')) return
    this.press(`Mouse${e.button}`)
  }

  private readonly onMouseUp = (e: MouseEvent) => this.release(`Mouse${e.button}`)

  private readonly onContext = (e: Event) => {
    if ((e.target as HTMLElement | null)?.closest?.('.menu')) return
    e.preventDefault()
  }
}
