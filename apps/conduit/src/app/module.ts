// Apex Conduit as something the arcade can mount and throw away again.
//
// The standalone entry point (main.ts) still exists and still works — `just dev conduit` serves
// this game on its own at :5180, which is where the tuning panel and the smoke harness live. This
// is the same boot sequence with the page's furniture supplied by the shell instead of by an
// index.html, and with a teardown at the end of it.

import css from '../style.css?inline'
import { Disposer } from '@apex/engine/app/Disposer'
import type { GameHost, GameModule, MountedGame } from '@apex/engine/app/GameModule'
import { Game } from './Game'

export const game: GameModule = {
  id: 'apex',

  async mount(host: GameHost): Promise<MountedGame> {
    // Only one game's stylesheet is ever in the document, because it goes in the mount container
    // and leaves with it. That is what lets all three games keep styling `.menu` and `.hud` their
    // own way without a single renamed class.
    const style = document.createElement('style')
    style.textContent = css
    host.container.appendChild(style)

    const rotate = document.createElement('div')
    rotate.className = 'rotate'
    rotate.textContent = 'ROTATE TO LANDSCAPE'
    host.container.appendChild(rotate)

    host.status('COMPILING')
    const g = new Game(host.canvas, host.container)
    g.menus.bindRouter(host.router, host.route)
    g.onExit = () => host.exit()

    const gone = new Disposer()

    // WebGL context loss: pause, say so, resume when the GPU comes back.
    gone.on(host.canvas, 'webglcontextlost', (e) => {
      e.preventDefault()
      g.loop.paused = true
      host.status('GPU CONTEXT LOST — RECOVERING')
    })
    gone.on(host.canvas, 'webglcontextrestored', () => {
      g.applyStyle()
      g.view.precompile()
      g.loop.paused = false
      host.status(null)
    })

    // Pre-warm shaders behind the loading card, then start the loop.
    await new Promise<void>((r) => requestAnimationFrame(() => r()))
    g.view.precompile()
    host.status(null)
    g.loop.start()

    return {
      dispose(): void {
        gone.run()
        g.dispose()
      },
      bridge: {
        game: g,
        get world() {
          return g.world
        },
        get snap() {
          return g.curr
        },
        view: g.view,
        renderer: g.view.renderer,
        scene: g.view.scene,
        camera: g.view.rig.camera,
        settings: g.settings,
        input: g.input,
        loop: g.loop,
        screenshot(quality = 0.7): string {
          g.view.render()
          return g.view.renderer.domElement.toDataURL('image/jpeg', quality)
        },
      },
    }
  },
}
