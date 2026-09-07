import '../style.css'
import { registerBridgeContext, startDevBridge } from 'virtual:dev-bridge'
import { Game } from './Game'

startDevBridge()

const app = document.getElementById('app')!
const loading = document.createElement('div')
loading.className = 'loading'
loading.textContent = 'BAKING SPRITES'
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
  void game.view.bake().then(() => {
    game.applyStyle()
    game.loop.paused = false
    loading.classList.add('hidden')
  })
})

// Bake the sprite atlas from the CC0 models, then start.
game.view
  .bake((d, t) => (loading.textContent = `BAKING SPRITES ${d}/${t}`))
  .then(() => {
    if (game.view.atlas.fromCache) console.info('%c[atlas] loaded from cache', 'color:#39ff81')
    loading.classList.add('hidden')
    game.loop.start()
  })
  .catch((err) => fatal('SPRITE BAKE FAILED', String((err as Error)?.stack ?? err)))

registerBridgeContext({
  game,
  get sim() {
    return game.sim
  },
  get snap() {
    return game.curr
  },
  view: game.view,
  renderer: game.view.renderer,
  settings: game.settings,
  input: game.input,
  loop: game.loop,
  screenshot(quality = 0.7): string {
    game.view.render()
    return game.view.renderer.domElement.toDataURL('image/jpeg', quality)
  },
})
