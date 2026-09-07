// React's window into the run. Phase changes are pushed (they gate whole
// screens, so they must land immediately); the numbers are polled at 20Hz,
// which is plenty for a readout and keeps React off the render path.

import { useEffect, useState, useSyncExternalStore } from 'react'
import { game, subscribePhase, type Phase } from '../game/state'

export function usePhase(): Phase {
  return useSyncExternalStore(subscribePhase, () => game.phase)
}

export interface Snapshot {
  speed: number
  distance: number
  length: number
  timeLeft: number
  shield: number
  boost: number
  boosting: boolean
  checkpoints: number
  hitFlash: number
  pickupFlash: number
  checkpointFlash: number
  elapsed: number
}

function snapshot(): Snapshot {
  return {
    speed: game.v,
    distance: game.s,
    length: game.track.length,
    timeLeft: game.timeLeft,
    shield: game.shield,
    boost: game.boost,
    boosting: game.boosting,
    checkpoints: game.checkpoints,
    hitFlash: game.hitFlash,
    pickupFlash: game.pickupFlash,
    checkpointFlash: game.checkpointFlash,
    elapsed: game.elapsed,
  }
}

const HUD_HZ = 20

export function useSnapshot(): Snapshot {
  const [snap, setSnap] = useState(snapshot)
  useEffect(() => {
    const id = setInterval(() => setSnap(snapshot()), 1000 / HUD_HZ)
    return () => clearInterval(id)
  }, [])
  return snap
}
