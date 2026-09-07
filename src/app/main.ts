// Entry point: canvas, loading state, the Game, error boundary, WebGL context
// loss recovery, and the dev bridge hook (a no-op unless `just bridge-dev`).

import '../style.css'
import { registerBridgeContext, startDevBridge } from 'virtual:dev-bridge'
import { Game } from './Game'

startDevBridge()

const app = document.getElementById('app')!
const loading = document.createElement('div')
loading.className = 'loading'
loading.textContent = 'COMPILING'
app.appendChild(loading)

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

// WebGL context loss: pause, tell the player, resume when the GPU comes back.
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

// Pre-warm shaders behind the loading card, then start the loop.
requestAnimationFrame(() => {
  game.view.precompile()
  loading.classList.add('hidden')
  game.loop.start()
})

// Dev operator shell handles. Empty function in production builds.
registerBridgeContext({
  game,
  get world() {
    return game.world
  },
  get snap() {
    return game.curr
  },
  view: game.view,
  renderer: game.view.renderer,
  scene: game.view.scene,
  camera: game.view.rig.camera,
  settings: game.settings,
  input: game.input,
  loop: game.loop,
  /** JPEG data URL of the current frame, for looking at the game from a terminal. */
  screenshot(quality = 0.7): string {
    game.view.render()
    return game.view.renderer.domElement.toDataURL('image/jpeg', quality)
  },
})
