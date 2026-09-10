// Stuntin' as something the arcade can mount and throw away again. See the note at the top of
// apps/conduit/src/app/module.ts — the three are deliberately the same shape.

import css from '../style.css?inline'
import { Disposer } from '@apex/engine/app/Disposer'
import type { GameHost, GameModule, MountedGame } from '@apex/engine/app/GameModule'
import { Game } from './Game'

export const game: GameModule = {
  id: 'stuntin',

  async mount(host: GameHost): Promise<MountedGame> {
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
        get sim() {
          return g.sim
        },
        get snap() {
          return g.curr
        },
        get track() {
          return g.track
        },
        view: g.view,
        renderer: g.view.renderer,
        settings: g.settings,
        input: g.input,
        loop: g.loop,
        editor: g.editor,
        screenshot(quality = 0.7): string {
          g.view.render()
          return g.view.renderer.domElement.toDataURL('image/jpeg', quality)
        },
      },
    }
  },
}
