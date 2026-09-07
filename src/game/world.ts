// The scene graph, built and driven imperatively. Plain Three.js on purpose:
// this runs every frame and reads straight from the mutable game state, so
// there is nothing for React to reconcile. React owns the canvas, the HUD and
// the menus (see Game.tsx, ui/), and nothing else.
//
// Recycling strategy: the conduit is a small pool of geometry chunks whose
// vertices are rewritten when the craft leaves them behind, and the course
// props are three InstancedMeshes refilled from a sliding window each frame.
// Nothing is allocated per frame.

import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  EdgesGeometry,
  Float32BufferAttribute,
  FogExp2,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  TorusGeometry,
  Vector3,
} from 'three'
import {
  BLOCK_HEIGHT,
  BG_COLOR,
  CAM_AHEAD,
  CAM_BACK,
  CAM_INSET,
  CAM_THETA_LAG,
  CHUNK_COUNT,
  CHUNK_LEN,
  CHUNK_RINGS,
  FOG_DENSITY,
  FOV_BASE,
  FOV_SPEED_GAIN,
  RADIAL_SEGMENTS,
  RING_SPACING,
  SHIP_INSET,
  SPEED_MAX,
  STREAK_COUNT,
} from './constants'
import { game } from './state'
import { makeFrame, type Frame, type Track } from './track'

/** How far ahead course props are instanced. Past the fog, nothing is drawn. */
const VIEW_AHEAD = 1500
const MAX_BLOCKS = 120
const MAX_PADS = 32
const MAX_GATES = 8

const GRID_NEAR = new Color(0x22d3ee)
const GRID_FAR = new Color(0xf0abfc)

interface Chunk {
  index: number
  positions: Float32Array
  surface: BufferGeometry
  grid: BufferGeometry
  group: Group
}

export class World {
  readonly root = new Group()

  private readonly chunks: Chunk[] = []
  private readonly blocks: InstancedMesh
  private readonly pads: InstancedMesh
  private readonly gates: InstancedMesh
  private readonly ship = new Group()
  private readonly shipEdges: LineSegments
  private readonly exhaust: Mesh[] = []
  private readonly streaks: LineSegments
  private readonly streakS = new Float32Array(STREAK_COUNT)
  private readonly streakTheta = new Float32Array(STREAK_COUNT)
  private readonly streakRadius = new Float32Array(STREAK_COUNT)
  private readonly gridMaterial: LineBasicMaterial

  private courseVersion = -1
  private renderCursor = 0
  private camTheta = 0
  private lastS = 0

  // Frame-local scratch. Reused so update() never allocates.
  private readonly frame: Frame = makeFrame()
  private readonly frameB: Frame = makeFrame()
  private readonly vA = new Vector3()
  private readonly vB = new Vector3()
  private readonly vUp = new Vector3()
  private readonly vRight = new Vector3()
  private readonly vFwd = new Vector3()
  private readonly mat = new Matrix4()
  private readonly matB = new Matrix4()
  private readonly quat = new Quaternion()
  private readonly quatB = new Quaternion()
  private readonly scale = new Vector3(1, 1, 1)

  constructor() {
    this.gridMaterial = new LineBasicMaterial({ color: GRID_NEAR.clone(), transparent: true, opacity: 0.85 })
    const surfaceMaterial = new MeshBasicMaterial({ color: 0x0b0a1f, side: BackSide })
    const gridIndex = buildGridIndex()
    const surfaceIndex = buildSurfaceIndex()

    for (let i = 0; i < CHUNK_COUNT; i++) {
      const positions = new Float32Array((CHUNK_RINGS + 1) * RADIAL_SEGMENTS * 3)
      const attr = new BufferAttribute(positions, 3)
      const surface = new BufferGeometry()
      surface.setAttribute('position', attr)
      surface.setIndex(surfaceIndex)
      const grid = new BufferGeometry()
      grid.setAttribute('position', attr)
      grid.setIndex(gridIndex)
      const group = new Group()
      group.add(new Mesh(surface, surfaceMaterial))
      group.add(new LineSegments(grid, this.gridMaterial))
      // The chunks span the whole course; per-chunk culling would pop them in
      // and out at the fog line, so let them all draw (9 chunks, 18 calls).
      group.frustumCulled = false
      this.root.add(group)
      this.chunks.push({ index: -1, positions, surface, grid, group })
    }

    this.blocks = new InstancedMesh(
      new BoxGeometry(8, BLOCK_HEIGHT, 12),
      new MeshBasicMaterial({ color: 0xf0abfc, wireframe: true }),
      MAX_BLOCKS,
    )
    this.pads = new InstancedMesh(
      new PlaneGeometry(11, 26),
      new MeshBasicMaterial({ color: 0xfde047, transparent: true, opacity: 0.55, blending: AdditiveBlending }),
      MAX_PADS,
    )
    this.gates = new InstancedMesh(
      // Unit radius; the per-instance matrix scales it to the local conduit.
      new TorusGeometry(1, 0.035, 5, RADIAL_SEGMENTS),
      new MeshBasicMaterial({ color: 0x7dd3fc, wireframe: true }),
      MAX_GATES,
    )
    for (const m of [this.blocks, this.pads, this.gates]) {
      m.frustumCulled = false
      m.count = 0
      this.root.add(m)
    }

    this.shipEdges = buildShip(this.ship, this.exhaust)
    this.root.add(this.ship)

    this.streaks = buildStreaks()
    this.streaks.frustumCulled = false
    this.root.add(this.streaks)
    for (let i = 0; i < STREAK_COUNT; i++) this.respawnStreak(i, true)
  }

  /** Fog + clear colour belong to the scene, which R3F owns. */
  applyScene(scene: Scene) {
    scene.background = new Color(BG_COLOR)
    scene.fog = new FogExp2(BG_COLOR, FOG_DENSITY)
  }

  update(camera: PerspectiveCamera, dt: number) {
    const { track } = game

    if (this.courseVersion !== game.courseVersion) {
      this.courseVersion = game.courseVersion
      for (const chunk of this.chunks) chunk.index = -1
      this.renderCursor = 0
    }
    // A reset (or a new run) rewinds distance; the render cursor only walks
    // forward, so it has to rewind with it.
    if (game.s < this.lastS - 1) this.renderCursor = 0
    this.lastS = game.s

    this.updateChunks(track)
    this.updateProps(track)
    this.updateStreaks(track)
    this.updateShip(track)
    this.updateCamera(camera, track, dt)

    // Tint the grid along the course: cyan at the start, magenta by the end.
    const t = Math.min(1, game.s / Math.max(1, track.length))
    ;(this.gridMaterial.color as Color).lerpColors(GRID_NEAR, GRID_FAR, t)
    const pulse = game.boosting ? 1 : 0.85 + game.checkpointFlash * 0.15
    this.gridMaterial.opacity = pulse
  }

  // --- conduit --------------------------------------------------------------

  private updateChunks(track: Track) {
    // Slot i always holds the chunk whose index is ≡ i (mod CHUNK_COUNT) inside
    // the visible window, so advancing one chunk length rebuilds exactly one
    // slot — the one that just fell behind.
    const base = Math.floor(game.s / CHUNK_LEN) - 1
    for (let i = 0; i < CHUNK_COUNT; i++) {
      const chunk = this.chunks[i]
      const target = base + (((i - base) % CHUNK_COUNT) + CHUNK_COUNT) % CHUNK_COUNT
      if (chunk.index === target) continue
      chunk.index = target
      this.buildChunk(track, chunk)
    }
  }

  private buildChunk(track: Track, chunk: Chunk) {
    const start = chunk.index * CHUNK_LEN
    const pos = chunk.positions
    let o = 0
    for (let j = 0; j <= CHUNK_RINGS; j++) {
      const s = start + j * RING_SPACING
      track.sample(s, this.frame)
      for (let k = 0; k < RADIAL_SEGMENTS; k++) {
        const theta = (k / RADIAL_SEGMENTS) * Math.PI * 2
        track.surfacePoint(this.frame, s, theta, 0, this.vA)
        pos[o++] = this.vA.x
        pos[o++] = this.vA.y
        pos[o++] = this.vA.z
      }
    }
    const attr = chunk.surface.getAttribute('position') as BufferAttribute
    attr.needsUpdate = true
    chunk.surface.computeBoundingSphere()
    chunk.grid.computeBoundingSphere()
  }

  // --- blocks / pads / arches ----------------------------------------------

  private updateProps(track: Track) {
    const { course } = game
    while (this.renderCursor < course.length && course[this.renderCursor].s < game.s - 120) {
      this.renderCursor++
    }
    let nBlocks = 0
    let nPads = 0
    let nGates = 0
    for (let i = this.renderCursor; i < course.length; i++) {
      const item = course[i]
      if (item.s > game.s + VIEW_AHEAD) break
      track.sample(item.s, this.frame)
      const radius = track.radiusAt(item.s)

      if (item.kind === 'block' && nBlocks < MAX_BLOCKS) {
        // Sits on the wall, standing on end: local +Y points inward, +Z runs
        // down the tube.
        track.surfacePoint(this.frame, item.s, item.theta, BLOCK_HEIGHT / 2, this.vA)
        track.radial(this.frame, item.theta, this.vUp).negate()
        this.vFwd.copy(this.frame.tan)
        this.vRight.crossVectors(this.vUp, this.vFwd).normalize()
        this.mat.makeBasis(this.vRight, this.vUp, this.vFwd)
        this.mat.setPosition(this.vA)
        this.blocks.setMatrixAt(nBlocks++, this.mat)
        continue
      }

      if (item.kind === 'pad' && !item.taken && nPads < MAX_PADS) {
        // A flat quad lying on the wall: the plane's +Z normal faces inward.
        track.surfacePoint(this.frame, item.s, item.theta, 0.35, this.vA)
        track.radial(this.frame, item.theta, this.vUp).negate()
        this.vFwd.copy(this.frame.tan)
        this.vRight.crossVectors(this.vFwd, this.vUp).normalize()
        this.mat.makeBasis(this.vRight, this.vFwd, this.vUp)
        this.mat.setPosition(this.vA)
        this.pads.setMatrixAt(nPads++, this.mat)
        continue
      }

      if (item.kind === 'gate' && nGates < MAX_GATES) {
        // A ring around the tube: the torus axis runs along the tangent.
        this.mat.makeBasis(this.frame.nor, this.frame.bin, this.frame.tan)
        this.quat.setFromRotationMatrix(this.mat)
        this.scale.setScalar(radius * 0.99)
        this.matB.compose(this.frame.pos, this.quat, this.scale)
        this.gates.setMatrixAt(nGates++, this.matB)
      }
    }
    this.blocks.count = nBlocks
    this.pads.count = nPads
    this.gates.count = nGates
    this.blocks.instanceMatrix.needsUpdate = true
    this.pads.instanceMatrix.needsUpdate = true
    this.gates.instanceMatrix.needsUpdate = true
  }

  // --- speed streaks --------------------------------------------------------

  private respawnStreak(i: number, initial: boolean) {
    this.streakS[i] = game.s + (initial ? Math.random() * VIEW_AHEAD : 600 + Math.random() * 900)
    this.streakTheta[i] = Math.random() * Math.PI * 2
    this.streakRadius[i] = 3 + Math.random() * 0.8
  }

  private updateStreaks(track: Track) {
    const attr = this.streaks.geometry.getAttribute('position') as BufferAttribute
    const arr = attr.array as Float32Array
    // Streaks stretch with speed — the cheapest motion cue there is.
    const len = 10 + game.v * 0.075
    for (let i = 0; i < STREAK_COUNT; i++) {
      if (this.streakS[i] < game.s - 40) this.respawnStreak(i, false)
      const s = this.streakS[i]
      track.sample(s, this.frame)
      track.surfacePoint(this.frame, s, this.streakTheta[i], this.streakRadius[i], this.vA)
      const o = i * 6
      arr[o] = this.vA.x
      arr[o + 1] = this.vA.y
      arr[o + 2] = this.vA.z
      // Second endpoint along the tangent: one track sample per streak.
      arr[o + 3] = this.vA.x + this.frame.tan.x * len
      arr[o + 4] = this.vA.y + this.frame.tan.y * len
      arr[o + 5] = this.vA.z + this.frame.tan.z * len
    }
    attr.needsUpdate = true
    const m = this.streaks.material as LineBasicMaterial
    m.opacity = 0.06 + Math.min(0.5, game.v / SPEED_MAX) * 0.45
  }

  // --- craft ----------------------------------------------------------------

  private updateShip(track: Track) {
    track.sample(game.s, this.frame)
    track.surfacePoint(this.frame, game.s, game.theta, SHIP_INSET + game.lift, this.vA)
    this.ship.position.copy(this.vA)

    track.radial(this.frame, game.theta, this.vUp).negate()
    this.vFwd.copy(this.frame.tan)
    this.vRight.crossVectors(this.vUp, this.vFwd).normalize()
    this.mat.makeBasis(this.vRight, this.vUp, this.vFwd)
    this.quat.setFromRotationMatrix(this.mat)
    // Bank into the roll and nose up on a hop: the craft's body language is
    // most of what makes the controls feel connected.
    this.quatB.setFromAxisAngle(this.vFwd, -game.thetaVel * 0.22)
    this.quat.premultiply(this.quatB)
    this.quatB.setFromAxisAngle(this.vRight, Math.max(-0.25, Math.min(0.25, game.liftVel * 0.006)))
    this.quat.premultiply(this.quatB)
    this.ship.quaternion.copy(this.quat)

    // Blink through the post-hit grace period, and flare the exhaust with
    // thrust so boost reads without looking at the HUD.
    const blink = game.invuln > 0 && Math.floor(game.invuln * 12) % 2 === 0
    this.ship.visible = game.phase !== 'title' && !blink
    const flare = 0.55 + (game.v / SPEED_MAX) * 0.8 + (game.boosting ? 0.5 : 0)
    for (const jet of this.exhaust) {
      jet.scale.setScalar(flare * (0.9 + Math.sin(game.elapsed * 40) * 0.1))
      const mat = jet.material as MeshBasicMaterial
      mat.color.setHex(game.boosting ? 0xfff0a0 : 0x67e8f9)
    }
    const edges = this.shipEdges.material as LineBasicMaterial
    edges.color.setHex(game.hitFlash > 0.2 ? 0xff5d73 : 0xe0fbff)
  }

  private updateCamera(camera: PerspectiveCamera, track: Track, dt: number) {
    // The camera's roll chases the craft's instead of matching it, so a hard
    // turn swings the world before the view catches up.
    const lag = 1 - Math.exp(-CAM_THETA_LAG * dt)
    this.camTheta += (game.theta - this.camTheta) * lag

    track.pointAt(game.s - CAM_BACK, this.camTheta, CAM_INSET + game.lift * 0.6, this.vA, this.frameB)
    camera.position.copy(this.vA)
    if (game.shake > 0) {
      const k = game.shake * game.shake * 1.6
      camera.position.x += (Math.random() - 0.5) * k
      camera.position.y += (Math.random() - 0.5) * k
      camera.position.z += (Math.random() - 0.5) * k
    }
    // Up is "toward the middle of the tube", which is what keeps a barrel roll
    // legible instead of nauseating.
    track.sample(game.s - CAM_BACK, this.frameB)
    track.radial(this.frameB, this.camTheta, this.vUp).negate()
    camera.up.copy(this.vUp)
    track.pointAt(game.s + CAM_AHEAD, game.theta, CAM_INSET * 1.7, this.vB, this.frameB)
    camera.lookAt(this.vB)

    const fov = FOV_BASE + FOV_SPEED_GAIN * (game.v / SPEED_MAX)
    if (Math.abs(camera.fov - fov) > 0.05) {
      camera.fov = fov
      camera.updateProjectionMatrix()
    }
  }

  dispose() {
    this.root.traverse((obj) => {
      const any = obj as unknown as { geometry?: BufferGeometry; material?: { dispose(): void } }
      any.geometry?.dispose()
      any.material?.dispose()
    })
  }
}

// --- geometry builders ------------------------------------------------------

/** Ring lines + longitudinal lines over the chunk's vertex grid. */
function buildGridIndex(): number[] {
  const idx: number[] = []
  const rs = RADIAL_SEGMENTS
  for (let j = 0; j <= CHUNK_RINGS; j++) {
    for (let k = 0; k < rs; k++) {
      idx.push(j * rs + k, j * rs + ((k + 1) % rs))
    }
  }
  for (let j = 0; j < CHUNK_RINGS; j++) {
    for (let k = 0; k < rs; k++) {
      idx.push(j * rs + k, (j + 1) * rs + k)
    }
  }
  return idx
}

/** Two triangles per quad. Drawn BackSide — we're always inside the tube. */
function buildSurfaceIndex(): number[] {
  const idx: number[] = []
  const rs = RADIAL_SEGMENTS
  for (let j = 0; j < CHUNK_RINGS; j++) {
    for (let k = 0; k < rs; k++) {
      const k2 = (k + 1) % rs
      const a = j * rs + k
      const b = j * rs + k2
      const c = (j + 1) * rs + k
      const d = (j + 1) * rs + k2
      idx.push(a, c, b, b, c, d)
    }
  }
  return idx
}

/**
 * A five-vertex delta wedge with per-face colours — flat "shading" with no
 * lights in the scene at all, which is both the period-correct look and one
 * less thing in the frame budget.
 */
function buildShip(root: Group, exhaust: Mesh[]): LineSegments {
  const nose = [0, 0, 3.4]
  const top = [0, 0.95, -1.1]
  const belly = [0, -0.4, -0.9]
  const left = [-2.3, 0, -1.7]
  const right = [2.3, 0, -1.7]
  const faces: number[][][] = [
    [nose, left, top],
    [nose, top, right],
    [nose, belly, left],
    [nose, right, belly],
    [top, left, right],
    [belly, right, left],
  ]
  const shades = [0x2b3f6b, 0x35507f, 0x1b2749, 0x212f56, 0x172038, 0x101733]
  const verts: number[] = []
  const colors: number[] = []
  faces.forEach((tri, i) => {
    const c = new Color(shades[i])
    for (const v of tri) {
      verts.push(v[0], v[1], v[2])
      colors.push(c.r, c.g, c.b)
    }
  })
  const geom = new BufferGeometry()
  geom.setAttribute('position', new Float32BufferAttribute(verts, 3))
  geom.setAttribute('color', new Float32BufferAttribute(colors, 3))
  root.add(new Mesh(geom, new MeshBasicMaterial({ vertexColors: true })))

  const edges = new LineSegments(
    new EdgesGeometry(geom, 1),
    new LineBasicMaterial({ color: 0xe0fbff }),
  )
  root.add(edges)

  const jetGeom = new CircleGeometry(0.5, 8)
  for (const x of [-0.55, 0.55]) {
    const jet = new Mesh(
      jetGeom,
      new MeshBasicMaterial({ color: 0x67e8f9, blending: AdditiveBlending, transparent: true, opacity: 0.9 }),
    )
    jet.position.set(x, 0.15, -1.75)
    jet.rotation.y = Math.PI
    root.add(jet)
    exhaust.push(jet)
  }
  return edges
}

function buildStreaks(): LineSegments {
  const geom = new BufferGeometry()
  geom.setAttribute('position', new BufferAttribute(new Float32Array(STREAK_COUNT * 6), 3))
  return new LineSegments(
    geom,
    new LineBasicMaterial({ color: 0xbff9ff, transparent: true, opacity: 0.2, blending: AdditiveBlending }),
  )
}
