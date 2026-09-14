// Standalone entry: the fighter on its own page, which is where tuning happens. The arcade mounts
// the same Game through module.ts.
//
// `?p1=zangief&p2=blanka&stage=airbase` picks the pairing from the address.

import '../style.css'
import { Game } from './Game'

const root = document.getElementById('app')
if (!root) throw new Error('fighter: no #app')

const canvas = document.createElement('canvas')
canvas.className = 'stage'
root.appendChild(canvas)

const q = new URLSearchParams(location.search)
const game = new Game(canvas, { p1: q.get('p1') ?? undefined, p2: q.get('p2') ?? undefined, stage: q.get('stage') ?? undefined })
game.start()

// Handy from the console while tuning: `fighter.match.fighters[0].health = 50`.
Object.assign(window as unknown as Record<string, unknown>, { fighter: game })
