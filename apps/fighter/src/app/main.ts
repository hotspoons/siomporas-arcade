// Standalone entry. The arcade shell will mount this game through a GameModule later; for now it
// runs on its own so the mechanics can be played before there is a cabinet to walk up to.

import '../style.css'
import { Game } from './Game'

const root = document.getElementById('app')
if (!root) throw new Error('fighter: no #app')

const canvas = document.createElement('canvas')
canvas.className = 'stage'
root.appendChild(canvas)

const game = new Game(canvas)
game.start()

// Handy from the console while tuning: `fighter.match.fighters[0].health = 50`.
Object.assign(window as unknown as Record<string, unknown>, { fighter: game })
