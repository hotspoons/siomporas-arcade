// The attract-mode prompt: what an arcade board showed with the menu out of the
// way. Put the menu aside on the title screen and this is what is left, over the
// game's own logo and whatever the camera is doing behind it.

export class PressStart {
  readonly el: HTMLElement
  private pad = false
  private touch = false

  constructor(parent: HTMLElement, touch = false) {
    this.touch = touch
    this.el = document.createElement('div')
    this.el.className = 'press-start hidden'
    parent.appendChild(this.el)
    this.write()
  }

  /** A connected pad says START, a keyboard says ENTER. */
  setPad(connected: boolean): void {
    if (connected === this.pad) return
    this.pad = connected
    this.write()
  }

  setVisible(v: boolean): void {
    this.el.classList.toggle('hidden', !v)
  }

  get visible(): boolean {
    return !this.el.classList.contains('hidden')
  }

  private write(): void {
    const line = this.touch ? 'TOUCH TO START' : this.pad ? 'PRESS START' : 'PRESS ENTER TO START'
    this.el.innerHTML = `<span class="line">${line}</span><span class="sub">ESC FOR THE MENU</span>`
  }
}
