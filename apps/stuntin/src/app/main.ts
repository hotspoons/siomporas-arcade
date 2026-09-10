// Entry point for the driving game.

import '../style.css'
import { registerBridgeContext, startDevBridge } from 'virtual:dev-bridge'
import { Game } from './Game'

startDevBridge()

const app = document.getElementById('app')!
const loading = document.createElement('div')
loading.className = 'loading'
loading.textContent = 'COMPILING'
app.appendChild(loading)

const rotate = document.createElement('div')
rotate.className = 'rotate'
rotate.textContent = 'ROTATE TO LANDSCAPE'
app.appendChild(rotate)

const canvas = document.createElement('canvas')
canvas.className = 'game'
app.appendChild(canvas)

function fatal(title: string, detail: string): void {
  let box = document.querySelector('.fatal') as HTMLElement | null
  if (!box) {
    box = document.createElement('div')
    box.className = 'fatal'
    app.appendChild(box)
  }
  box.innerHTML = `<h2>${title}</h2><pre></pre><button>RELOAD</button>`
  box.querySelector('pre')!.textContent = detail
  box.querySelector('button')!.addEventListener('click', () => location.reload())
}

window.addEventListener('error', (e) => fatal('SOMETHING BROKE', String(e.error?.stack ?? e.message)))
window.addEventListener('unhandledrejection', (e) => fatal('SOMETHING BROKE', String((e.reason as Error)?.stack ?? e.reason)))

let game: Game
try {
  game = new Game(canvas, app)
} catch (err) {
  fatal('COULD NOT START', String((err as Error)?.stack ?? err))
  throw err
}

canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault()
  game.loop.paused = true
  loading.textContent = 'GPU CONTEXT LOST — RECOVERING'
  loading.classList.remove('hidden')
})
canvas.addEventListener('webglcontextrestored', () => {
  game.applyStyle()
  game.view.precompile()
  game.loop.paused = false
  loading.classList.add('hidden')
})

requestAnimationFrame(() => {
  game.view.precompile()
  loading.classList.add('hidden')
  game.loop.start()
})

registerBridgeContext({
  game,
  get sim() {
    return game.sim
  },
  get snap() {
    return game.curr
  },
  get track() {
    return game.track
  },
  view: game.view,
  renderer: game.view.renderer,
  settings: game.settings,
  input: game.input,
  loop: game.loop,
  editor: game.editor,
  screenshot(quality = 0.7): string {
    game.view.render()
    return game.view.renderer.domElement.toDataURL('image/jpeg', quality)
  },
})
