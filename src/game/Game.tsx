// The React ↔ Three.js seam. R3F owns the canvas, the renderer and the frame
// loop; everything inside it is the imperative World (see world.ts). This
// component is the only place the two meet.

import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import type { PerspectiveCamera } from 'three'
import { registerBridgeContext } from 'virtual:dev-bridge'
import * as constants from './constants'
import { FOV_BASE } from './constants'
import { attachInput, input, pollInput } from './input'
import { stepAttract, stepRun } from './simulate'
import { game, newCourse, resetRun, startRun } from './state'
import { World } from './world'

/** Ignore "confirm" for a beat after a run ends, so the fatal keypress that
 *  wrecked you doesn't immediately restart the run. */
const RESTART_LOCKOUT = 0.7

function Conduit() {
  const world = useMemo(() => new World(), [])
  const scene = useThree((s) => s.scene)
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera)
  const lockout = useRef(0)
  const lastPhase = useRef(game.phase)

  // No dispose on cleanup: StrictMode runs effect teardown/setup twice on the
  // same component instance, so disposing here would free the geometry the
  // second setup goes on to use. The world lives as long as the page does;
  // World.dispose() exists for tests and explicit teardown.
  useEffect(() => {
    world.applyScene(scene)
  }, [world, scene])

  useEffect(attachInput, [])

  // Hand the dev operator shell live handles onto the running game. A no-op
  // unless the bridge switch is on, so nothing is exposed by default.
  useEffect(() => {
    registerBridgeContext({
      game,
      world,
      input,
      constants,
      three: { gl, scene, camera },
      actions: { startRun, resetRun, newCourse },
    })
  }, [world, gl, scene, camera])

  useFrame((state, delta) => {
    const input = pollInput()

    if (game.phase !== lastPhase.current) {
      lastPhase.current = game.phase
      lockout.current = game.phase === 'running' ? 0 : RESTART_LOCKOUT
    }
    lockout.current = Math.max(0, lockout.current - delta)

    if (game.phase === 'running') {
      stepRun(delta, input)
    } else {
      stepAttract(delta)
      if (input.confirm && lockout.current === 0) startRun()
    }

    world.update(state.camera as PerspectiveCamera, delta)
  })

  return <primitive object={world.root} />
}

export function Game() {
  return (
    <Canvas
      // No AA and a capped DPR: chunky edges are the look, and the frame
      // budget goes to speed instead. `flat` skips tone mapping so the neon
      // colours land exactly as authored.
      flat
      dpr={[1, 1.5]}
      gl={{ antialias: false, powerPreference: 'high-performance' }}
      camera={{ fov: FOV_BASE, near: 0.4, far: 4000 }}
    >
      <Conduit />
    </Canvas>
  )
}
