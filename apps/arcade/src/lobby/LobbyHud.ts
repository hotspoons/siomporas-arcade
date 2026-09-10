// The lobby's flat furniture: the sign over the door, the plate under the selected cabinet, the
// arrows either side and the row of dots. Everything three-dimensional is in Lobby.ts; this is the
// part that has to stay crisp and readable at any size, which is what DOM is still best at.

import { GAMES, type ArcadeGame } from '../catalog'

export class LobbyHud {
  readonly el: HTMLElement
  onPick: ((index: number) => void) | null = null
  onStep: ((dir: number) => void) | null = null
  onStart: (() => void) | null = null

  private readonly title: HTMLElement
  private readonly lineage: HTMLElement
  private readonly blurb: HTMLElement
  private readonly dots: HTMLElement[]

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div')
    this.el.className = 'lobby'
    this.el.innerHTML = `
      <header class="lobby-sign"><span>SIOMPORAS</span><em>ARCADE</em></header>
      <button class="lobby-arrow left" aria-label="Previous game">‹</button>
      <button class="lobby-arrow right" aria-label="Next game">›</button>
      <footer class="lobby-plate">
        <h1></h1>
        <p class="lineage"></p>
        <p class="blurb"></p>
        <div class="dots"></div>
        <button class="lobby-start">INSERT COIN</button>
      </footer>`

    this.title = this.el.querySelector('h1')!
    this.lineage = this.el.querySelector('.lineage')!
    this.blurb = this.el.querySelector('.blurb')!

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

  show(game: ArcadeGame): void {
    this.title.textContent = game.title
    this.lineage.textContent = game.lineage
    this.blurb.textContent = game.blurb
    const i = GAMES.indexOf(game)
    this.dots.forEach((d, j) => d.classList.toggle('on', j === i))
    this.el.style.setProperty('--glow', `#${game.glow.toString(16).padStart(6, '0')}`)
  }

  dispose(): void {
    this.el.remove()
  }
}
