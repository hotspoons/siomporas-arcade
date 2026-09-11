// CONCRETE CROWN as something the arcade can mount and throw away again.
//
// It is deliberately *unlisted*: reachable at /crown, with no cabinet in the lobby. The stand-in
// renderer draws each attacking limb from the move's own hitbox, which is a genuinely useful
// picture of the frame data and also — entirely by accident — obscene. A cabinet is a thing you
// walk up to; a path is a thing you have to know about. This stays a path until it wears sprites.
//
// See apps/arcade/src/catalog.ts for the other half of that arrangement.

import css from '../style.css?inline'
import { Disposer } from '@apex/engine/app/Disposer'
import type { GameHost, GameModule, MountedGame } from '@apex/engine/app/GameModule'
import { Game } from './Game'

export const game: GameModule = {
  id: 'crown',

  async mount(host: GameHost): Promise<MountedGame> {
    const style = document.createElement('style')
    // The standalone page styles html/body/#app, none of which this owns inside the shell. Only the
    // canvas rule travels, scoped to the container the shell dug for us.
    style.textContent = `${css}\n.arcade-game .stage { display: block; width: 100%; height: 100%; background: #06070a; }`
    host.container.appendChild(style)

    const g = new Game(host.canvas)
    const gone = new Disposer()
    // There is no menu yet, so Escape is the way out. The shell owns the URL either way.
    gone.on(window, 'keydown', (e) => {
      if (e.code === 'Escape') host.exit()
    })
    host.status(null)
    g.start()

    return {
      dispose(): void {
        gone.run()
        g.dispose()
      },
      bridge: { game: g, match: g.match },
    }
  },
}
