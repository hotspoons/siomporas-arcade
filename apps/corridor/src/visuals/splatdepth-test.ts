// Does a gaussian splat obey the depth buffer in THIS renderer?
//
// The corridor viewer builds its renderer with `logarithmicDepthBuffer: true`, and a splat
// renderer that writes ordinary depth would z-fight or draw straight over the world. Everything in
// docs/corridor/PLAN-SPLAT-CORRIDORS.md rests on the answer, so it deserves a test that answers it
// and nothing else.
//
// Measuring it inside the viewer was the wrong instrument: differencing two frames of a living
// world measures the clock, the grass, an animated stream, the lazy build pump and the canopy
// shade easing after a camera move — every one of which I chased in turn. So this is a page with
// three objects in it and no time: an opaque wall, a splat in front of it, a splat behind it. Load
// /splatdepth.html and read `window.__splatdepth`.

import * as THREE from 'three'
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark'

const WALL = 0x2255ff // the wall is blue

interface Result {
  ok: boolean
  logDepth: boolean
  cases: Record<string, { centre: number[]; verdict: string }>
  notes: string[]
}

const notes: string[] = []

async function run(): Promise<Result> {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  document.body.append(canvas)
  // THE SAME RENDERER THE VIEWER BUILDS. If this flag is the problem, this is where it shows.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, logarithmicDepthBuffer: true, preserveDrawingBuffer: true })
  renderer.setSize(256, 256, false)
  const logDepth = renderer.capabilities.logarithmicDepthBuffer
  notes.push(`renderer logarithmicDepthBuffer: ${logDepth}`)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x101010)
  scene.add(new THREE.AmbientLight(0xffffff, 3))
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 20000)
  camera.position.set(0, 0, 0)
  camera.lookAt(0, 0, -1)

  // an opaque wall 10 m in front of the camera, filling the view
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial({ color: WALL }))
  wall.position.set(0, 0, -10)
  scene.add(wall)

  // the splats: one cloud, moved between the cases
  const spark = new SparkRenderer({ renderer })
  scene.add(spark)
  // THE CLOUD IS BUILT HERE, not loaded. A tile from a capture is a sheet with an orientation and
  // an origin a kilometre out, and the test would end up asking about those instead of about
  // depth. A ball of gaussians at the origin has no orientation to get wrong.
  // `constructSplats` is how Spark wants a cloud built in code: it hands you the buffer to fill
  // before the mesh is ready, rather than mutating one that has already been uploaded.
  const q = new THREE.Quaternion()
  const s = new THREE.Vector3(0.35, 0.35, 0.35)
  const col = new THREE.Color(1, 0.15, 0.15) // the splats are red, the wall is blue
  const splat = new SplatMesh({
    maxSplats: 512,
    constructSplats: (packed) => {
      for (let i = 0; i < 400; i++) {
        // a spiral disc a couple of metres across, facing the camera: dense enough that the centre
        // pixel is certainly covered, with no orientation to get wrong
        const a = i * 2.399963, r = Math.sqrt(i / 400)
        packed.pushSplat(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, (i / 400 - 0.5) * 0.6), s, q, 1, col)
      }
    },
  })
  await splat.initialized
  scene.add(splat)
  // WHERE IS THE CLOUD? A tile's gaussians sit at their own coordinates — a kilometre out in the
  // capture's ENU frame — so setting the mesh's position to z = −5 does not put the SPLATS five
  // metres in front of the camera, it puts the mesh ORIGIN there and leaves them a kilometre away.
  // The centroid is what has to land where the test wants it.
  let n = 0
  splat.forEachSplat(() => { n++ })
  notes.push(`built a ball of ${n} gaussians at the origin`)
  const placeCloud = (x: number, y: number, z: number) => {
    splat.position.set(x, y, z)
    splat.updateMatrixWorld(true)
  }

  /**
   * RENDER SEVERAL FRAMES BEFORE READING. Spark sorts its gaussians off the main thread and
   * uploads the result, so the first frame after a move can legitimately have nothing to draw —
   * which reads exactly like "the splat never drew". The README's own example runs an animation
   * loop; a single render is not the same thing.
   */
  const read = async (): Promise<number[]> => {
    for (let i = 0; i < 24; i++) {
      renderer.render(scene, camera)
      await new Promise((r) => requestAnimationFrame(r))
    }
    const c2 = document.createElement('canvas')
    c2.width = c2.height = 256
    const ctx = c2.getContext('2d')!
    ctx.drawImage(canvas, 0, 0)
    const d = ctx.getImageData(128, 128, 1, 1).data
    return [d[0], d[1], d[2]]
  }

  const isWall = (p: number[]) => p[2] > 90 && p[2] > p[0] * 1.6
  const isSplat = (p: number[]) => p[0] > 60 && p[0] > p[2] * 1.4
  const cases: Result['cases'] = {}
  // 1. nothing between: the wall
  placeCloud(0, 0, 3000) // far out of the way, behind the camera
  const bare = await read()
  cases.wallOnly = { centre: bare, verdict: isWall(bare) ? 'wall' : 'not the wall' }

  // 2. the splat IN FRONT of the wall: it must cover it
  placeCloud(0, 0, -5)
  const front = await read()
  cases.splatInFront = { centre: front, verdict: isSplat(front) ? 'the splat' : isWall(front) ? 'still the wall — the splat did not draw' : 'neither' }

  // 3. the splat BEHIND the wall: the wall must hide it. This is the depth test.
  placeCloud(0, 0, -30)
  const behind = await read()
  cases.splatBehind = { centre: behind, verdict: isWall(behind) ? 'the wall — occluded correctly' : isSplat(behind) ? 'the splat showed through' : 'neither' }

  const ok = cases.wallOnly.verdict === 'wall' && cases.splatInFront.verdict === 'the splat' && cases.splatBehind.verdict === 'the wall — occluded correctly'
  return { ok, logDepth, cases, notes }
}

run()
  .then((r) => {
    ;(window as unknown as { __splatdepth: Result }).__splatdepth = r
    const pre = document.createElement('pre')
    pre.textContent = JSON.stringify(r, null, 1)
    document.body.append(pre)
  })
  .catch((e) => {
    ;(window as unknown as { __splatdepth: unknown }).__splatdepth = { ok: false, error: String(e), notes }
    document.body.append(Object.assign(document.createElement('pre'), { textContent: String(e) }))
  })
