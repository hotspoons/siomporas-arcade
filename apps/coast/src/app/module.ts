// Turbo Radrun as something the arcade can mount and throw away again. See the note at the top of
// apps/conduit/src/app/module.ts.
//
// This one has a real wait in front of it: the sprite atlas is baked on the GPU from the CC0
// models before the first frame, which is seconds on a cold cache. The bake reports progress
// through host.status(), so the shell's loading card counts up instead of just sitting there.

import css from '../style.css?inline'
import { Disposer } from '@apex/engine/app/Disposer'
import type { GameHost, GameModule, MountedGame } from '@apex/engine/app/GameModule'
import { Game } from './Game'

export const game: GameModule = {
  id: 'radrun',

  async mount(host: GameHost): Promise<MountedGame> {
    const style = document.createElement('style')
    style.textContent = css
    host.container.appendChild(style)

    const rotate = document.createElement('div')
    rotate.className = 'rotate'
    rotate.textContent = 'ROTATE TO LANDSCAPE'
    host.container.appendChild(rotate)

    host.status('BAKING SPRITES')
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
      void g.view.bake().then(() => {
        g.applyStyle()
        g.loop.paused = false
        host.status(null)
      })
    })

    await g.view.bake((d, t) => host.status(`BAKING SPRITES ${d}/${t}`))
    if (g.view.atlas.fromCache) console.info('%c[atlas] loaded from cache', 'color:#39ff81')
    host.status(null)
    g.loop.start()

    // A phone has no console: ?gldebug=1 puts the GPU's limits and the baked atlas on screen.
    if (new URLSearchParams(location.search).get('gldebug') === '1') {
      void import('./gldebug').then((m) => m.showGlDebug(host.container, g.view.renderer, g.view.atlas))
    }

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
        view: g.view,
        renderer: g.view.renderer,
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
