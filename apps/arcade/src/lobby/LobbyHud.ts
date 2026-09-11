// The lobby's flat furniture: the sign over the door, the plate under the selected cabinet, the
// arrows either side and the row of dots. Everything three-dimensional is in Lobby.ts; this is the
// part that has to stay crisp and readable at any size, which is what DOM is still best at.

import { GAMES, type ArcadeGame } from '../catalog'

export class LobbyHud {
  readonly el: HTMLElement
  onPick: ((index: number) => void) | null = null
  onStep: ((dir: number) => void) | null = null
  onStart: (() => void) | null = null
  onWalk: (() => void) | null = null

  private readonly title: HTMLElement
  private readonly blurb: HTMLElement
  private readonly dots: HTMLElement[]
  private readonly walkBtn: HTMLButtonElement

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div')
    this.el.className = 'lobby'
    this.el.innerHTML = `
      <header class="lobby-sign"><span>SIOMPORAS</span><em>ARCADE</em></header>
      <button class="lobby-arrow left" aria-label="Previous game">‹</button>
      <button class="lobby-arrow right" aria-label="Next game">›</button>
      <button class="lobby-play" aria-label="Play this game">▶</button>
      <button class="lobby-walk">WALK THE AISLE</button>
      <p class="lobby-hint">W A S D &nbsp;WALK &nbsp;·&nbsp; DRAG &nbsp;LOOK &nbsp;·&nbsp; CLICK A MACHINE TO WALK OVER &nbsp;·&nbsp; F &nbsp;BACK TO THE ROW</p>
      <footer class="lobby-plate">
        <h1></h1>
        <p class="blurb"></p>
        <div class="dots"></div>
        <button class="lobby-start">INSERT COIN</button>
      </footer>`

    this.title = this.el.querySelector('h1')!
    this.blurb = this.el.querySelector('.blurb')!
    this.walkBtn = this.el.querySelector<HTMLButtonElement>('.lobby-walk')!
    this.walkBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.onWalk?.()
    })

    this.el.querySelector<HTMLElement>('.lobby-arrow.left')!.addEventListener('click', (e) => {
      e.stopPropagation()
      this.onStep?.(-1)
    })
    this.el.querySelector<HTMLElement>('.lobby-arrow.right')!.addEventListener('click', (e) => {
      e.stopPropagation()
      this.onStep?.(1)
    })
    this.el.querySelector<HTMLElement>('.lobby-start')!.addEventListener('click', (e) => {
      e.stopPropagation()
      this.onStart?.()
    })
    this.el.querySelector<HTMLElement>('.lobby-play')!.addEventListener('click', (e) => {
      e.stopPropagation()
      this.onStart?.()
    })

    const dots = this.el.querySelector<HTMLElement>('.dots')!
    this.dots = GAMES.map((g, i) => {
      const d = document.createElement('button')
      d.className = 'dot'
      d.setAttribute('aria-label', g.title)
      d.addEventListener('click', (e) => {
        e.stopPropagation()
        this.onPick?.(i)
      })
      dots.appendChild(d)
      return d
    })

    parent.appendChild(this.el)
  }

  /**
   * Leaning in on a cabinet's screen: the row furniture goes, a play button comes up over the glass.
   * Everything else about the lobby is still there behind it, so backing out is instant.
   */
  setLeaning(on: boolean): void {
    if (this.leaning === on) return
    this.leaning = on
    this.el.classList.toggle('leaning', on)
  }
  private leaning = false

  /**
   * Walking the aisle: the plate still names whatever machine you are standing nearest, and the
   * arrows and dots still work — they walk you there rather than sliding the row past you.
   */
  setWalking(on: boolean): void {
    this.el.classList.toggle('walking', on)
    this.walkBtn.textContent = on ? 'BACK TO THE ROW' : 'WALK THE AISLE'
  }

  show(game: ArcadeGame): void {
    this.title.textContent = game.title
    this.blurb.textContent = game.blurb
    const i = GAMES.indexOf(game)
    this.dots.forEach((d, j) => d.classList.toggle('on', j === i))
    this.el.style.setProperty('--glow', `#${game.glow.toString(16).padStart(6, '0')}`)
  }

  dispose(): void {
    this.el.remove()
  }
}
