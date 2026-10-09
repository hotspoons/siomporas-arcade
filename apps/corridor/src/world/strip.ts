// The road corridor as its own fine terrain: a strip swept along the spine, wide enough to take
// in every carriageway and the median plus 40 m of verge each side, sampled 1 m across by 2 m
// along. Under any pavement it sits at that carriageway's road height; from the pavement edge it
// blends back to the DEM over 7 m. So there is no coarse triangle to interpolate across the road,
// cut faces beside the shoulder are resolved at 1 m, and the grass ground is one material:
// imagery everywhere, mown turf inside the mow line, rough grass beyond, blended by the same
// edge distance the blades use. The coarse terrain is sunk beneath it.
import * as THREE from 'three'
import type { Budget } from './budget'
import { ACCUM_PARS, accumUniforms } from '../visuals/weather'
import { injectShade, injectWetStreak } from '../visuals/shading'
import { GRASS_RELIEF_PARS, grassReliefUniforms } from '../visuals/grassrelief'
import { injectFloodLamp } from '../visuals/retro'
import { isDeck } from './overpass'
import * as T from '../tuning'

export interface Edge {
  d: number // signed distance to the nearest pavement edge (negative on the pavement)
  y: number // road surface height at that station
}

export async function buildStrip(
  spineAt: (s: number) => { pos: THREE.Vector3; dir: THREE.Vector3 },
  length: number,
  left: number,
  right: number,
  edgeAt: (x: number, z: number) => Edge,
  demAt: (x: number, y: number) => number,
  imagery: THREE.Texture | null,
  bbox: [number, number, number, number],
  grassMown: THREE.Texture | null,
  grassRough: THREE.Texture | null,
  along = 2,
  across = 1,
  offsetAt: ((x: number, y: number) => number) | null = null,
  /** network branches: stations where another road's strip already covers the ground are left out (no triangles, heightAt → null) */
  skipAt: ((s: number) => boolean) | null = null,
  /**
   * How far past the PAVEMENT EDGE the strip may reach at this station, in metres (Infinity for
   * no limit). On a bridge the verge has to stop at the parapet: out there the strip is still at
   * DECK height while the DEM is the valley floor 5–12 m below, and the blend to the DEM cannot
   * reach that far, so the verge hangs over the valley as a shelf with grass and trees standing
   * on it. Measured from the pavement edge rather than from the spine because a divided highway
   * carries its carriageways on two separate decks: a spine-relative half-width would keep the
   * median, which is open air, and cut the sibling's deck away. Vertices past the limit emit no
   * triangles and heightAt returns null for them.
   */
  edgeLimitAt: ((s: number) => number) | null = null,
  /** canopy height (m) at site x,y — the CHM. Where it closes over, the verge is forest floor. */
  canopyAt: ((x: number, y: number) => number) | null = null,
  /** the forest-floor texture that replaces turf under canopy (groundcover.forestFloorTexture) */
  forestFloor: THREE.Texture | null = null,
  /** when set, the station fill yields once the slice is spent so a chunk cannot own the frame */
  budget?: Budget,
  /**
   * THE BAKED GROUND (world x, z → height). On a graded bake the pyramid raster already holds
   * what the blend below computes — the bake ran the same formula into every fine tile — so a
   * vertex reads it instead. Except on a DECK: there the raster is the earth (the physics ground
   * under an overpass is the road below), while this strip is the deck's own verge, held at deck
   * height to the parapet; those vertices keep the formula. Null on an older bake, and null FROM
   * the function where the raster cannot answer — a cell that spans a step between two roads.
   */
  rasterAt: ((x: number, z: number) => number | null) | null = null,
): Promise<{
  mesh: THREE.Mesh
  heightAt: (x: number, z: number) => number | null
  /** where a coarse-terrain vertex goes under the strip's rim; null outside the strip */
  sinkAt: (x: number, z: number) => number | null
  /** metres inside the strip, ≤ 0 outside: how sinkUnderStrip knows which triangles to drop */
  coverAt: (x: number, z: number) => number
  /** the strip's own extent in world metres, [minX, minZ, maxX, maxZ] — sinkUnderStrip's fast path */
  bounds: [number, number, number, number]
  setLitter: (tint: THREE.Color, spread: number) => void
  setImageryDesat: (v: number) => void
  weatherUniforms: Record<string, THREE.IUniform>
  setTint: (c: THREE.Color, ground: THREE.Color) => void
}> {
  const nS = Math.floor(length / along) + 1
  const skipped = new Uint8Array(nS)
  const offs: number[] = []
  for (let o = -left; o <= right + 1e-6; o += across) offs.push(o)
  const nL = offs.length
  // the lift ramps from zero at the pavement edge to full over this run, so the strip itself never
  // pokes up through the asphalt (its own triangles are not edge-aligned); the fringe below owns the
  // crisp face and the raised top over this same run
  const liftRamp = Math.max(0.6, across + 0.2)
  // THE LIP SCALES WITH THE GRASS. grassLipM() is GRASS_LIFT_M at the reference grass height, scaled
  // by the grass-height dials; the blade roots in scene.ts's gradedHeight use the same value, so the
  // mesh top and the blades stay together at any height. Read once, the strip is thousands of verts.
  const lipM = T.grassLipM()
  const pos = new Float32Array(nS * nL * 3)
  const uv = new Float32Array(nS * nL * 2)
  const edge = new Float32Array(nS * nL)
  const canopy = new Float32Array(nS * nL)
  /** the un-lifted ground height: the pavement edge face (below) starts from this */
  const baseY = new Float32Array(nS * nL)
  const up = new THREE.Vector3(0, 1, 0)
  const [bx0, by0, bx1, by1] = bbox
  let k = 0
  // a lookup grid for heightAt(): station index by along-track, lateral by offset
  const heights = new Float32Array(nS * nL)
  /** vertices outside this station's width limit: no triangles touch them, heightAt ignores them */
  const dead = new Uint8Array(nS * nL)
  const origins: THREE.Vector3[] = []
  const sides: THREE.Vector3[] = []
  for (let i = 0; i < nS; i++) {
    const sHere = Math.min(length, i * along)
    const st = spineAt(sHere)
    const side = st.dir.clone().setY(0).normalize().cross(up) // right of travel
    origins.push(st.pos)
    sides.push(side)
    if (skipAt && skipAt(sHere)) skipped[i] = 1
    const edgeLimit = edgeLimitAt ? edgeLimitAt(sHere) : Infinity
    for (let j = 0; j < nL; j++) {
      const o = offs[j]
      const x = st.pos.x + side.x * o, z = st.pos.z + side.z * o
      const e = edgeAt(x, z)
      const dem = demAt(x, -z)
      // road height under and just beside the pavement, DEM beyond; the road wins where it is
      // higher than the DEM under it (a fill) AND where it is lower (a cut)
      const t = THREE.MathUtils.smoothstep(e.d, 0.6, 7.0)
      // the editor's ground_offset_m raises or lowers the verge, never the pavement, fading in
      // over the same 0.6–7 m band the DEM blend uses
      const off = offsetAt ? offsetAt(x, -z) * t : 0
      let base = (e.d < 0.6 ? e.y - 0.02 : (e.y - 0.02) * (1 - t) + dem * t) + off
      if (rasterAt && !isDeck(e.y, dem, T.OVERPASS_CLEAR_M)) { const r = rasterAt(x, z); if (r !== null) base = r }
      baseY[k] = base
      // GRASS LIP. The mown/rough turf stands proud of the pavement: real mown grass beside asphalt
      // forms a lip, and raising the whole band (not a thin skirt) makes the ground itself the slab.
      // A ground-plane shader cannot draw above its own pixel, so this real step plus the face built
      // below is what gives low-cut grass thickness. A hard step at the pavement edge, so the strip
      // is already at full lift by its first grass vertex and the face (below) covers the seam.
      // BUILD-TIME, and the height is grassLipM() so the step tracks the grass-height dials.
      const y = base + lipM * Math.max(0, Math.min(1, e.d / liftRamp))
      pos[k * 3] = x
      pos[k * 3 + 1] = y
      pos[k * 3 + 2] = z
      if (e.d > edgeLimit) dead[k] = 1
      heights[k] = skipped[i] || dead[k] ? NaN : y
      // imagery uv from world position inside the site bbox (site y = -world z)
      uv[k * 2] = (x - bx0) / (bx1 - bx0)
      uv[k * 2 + 1] = (-z - by0) / (by1 - by0)
      edge[k] = e.d
      canopy[k] = canopyAt ? canopyAt(x, -z) : 0
      k++
      // a wide row is itself the hitch: one station of a primary strip is ~80 edgeDistance probes
      if (budget && (k & 7) === 0) await budget.tick()
    }
    if (budget) await budget.tick()
  }
  const idxAll = new Uint32Array((nS - 1) * (nL - 1) * 6)
  let n = 0
  for (let i = 0; i < nS - 1; i++) {
    if (skipped[i] || skipped[i + 1]) continue
    for (let j = 0; j < nL - 1; j++) {
      const a = i * nL + j, b = a + 1, c = a + nL, d = c + 1
      if (dead[a] || dead[b] || dead[c] || dead[d]) continue
      // WINDING. b is one step along `side` (= dir × up) and c is one step along `dir`, so
      // (a, c, b) has normal dir × side = −up: the sheet's front faces pointed DOWN. The material
      // is FrontSide, so the strip was back-face culled from above and drew nothing at all — the
      // ground under the verge was the coarse terrain, which sinkUnderStrip puts 2.5 m BELOW the
      // strip. That 2.5 m is the gap between the landscape and the imagery: grass, trees and the
      // car stand on the strip's heights, and the imagery you see is the sunk terrain.
      idxAll[n++] = a; idxAll[n++] = b; idxAll[n++] = c
      idxAll[n++] = b; idxAll[n++] = d; idxAll[n++] = c
    }
    if (budget && (i & 7) === 7) await budget.tick()
  }
  const idx = n === idxAll.length ? idxAll : idxAll.slice(0, n)
  if (budget) await budget.tick()
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geo.setAttribute('aEdge', new THREE.BufferAttribute(edge, 1))
  geo.setAttribute('aCanopy', new THREE.BufferAttribute(canopy, 1))
  geo.setIndex(new THREE.BufferAttribute(idx, 1))
  geo.computeVertexNormals()

  for (const t of [grassMown, grassRough, forestFloor]) if (t) { t.wrapS = t.wrapT = THREE.RepeatWrapping }
  const mat = new THREE.MeshStandardMaterial({ map: imagery, color: 0xffffff, roughness: 1, metalness: 0 })
  const uniforms = {
    grassMown: { value: grassMown },
    grassRough: { value: grassRough },
    hasGrass: { value: grassMown && grassRough ? 1 : 0 },
    forestFloor: { value: forestFloor },
    hasForest: { value: forestFloor ? 1 : 0 },
    litterTint: { value: new THREE.Color(0x7a6e56) },
    litterSpread: { value: 0.2 },
    ...accumUniforms(),
    grassTint: { value: new THREE.Color(0xffffff) },
    /** a style's hold on the photo: 0 as shot, 1 greyscale under the ground tint */
    imageryDesat: { value: 0 },
    // the relief underlayment (GRASS_GROUND 1), read by this material only
    ...grassReliefUniforms,
  }
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aEdge;\nattribute float aCanopy;\nvarying float vEdge;\nvarying float vCanopy;\nvarying vec3 vWorldXZ;\nvarying vec3 vWorldN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEdge = aEdge;\nvCanopy = aCanopy;\nvWorldXZ = (modelMatrix * vec4(position, 1.0)).xyz;\nvWorldN = normalize(mat3(modelMatrix) * objectNormal);')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_pars_fragment>', `#include <map_pars_fragment>
        uniform sampler2D grassMown;
        uniform sampler2D grassRough;
        uniform int hasGrass;
        uniform sampler2D forestFloor;
        uniform int hasForest;
        uniform vec3 litterTint;
        uniform float litterSpread;
        uniform float imageryDesat;
        uniform vec3 grassTint;
        varying float vEdge;
        varying float vCanopy;
        varying vec3 vWorldXZ;
        varying vec3 vWorldN;
        ${ACCUM_PARS}
        ${GRASS_RELIEF_PARS}
        // the relief turf's world-space shading normal, written in map_fragment and consumed in
        // normal_fragment_begin (a file-scope global; map_fragment runs first). gGRW is how much of
        // it to apply, so the far photo turf keeps the ground's real upward normal.
        vec3 gGRNormal = vec3(0.0, 1.0, 0.0);
        float gGRW = 0.0;
        // TRIPLANAR. The ground textures used to be projected straight down — uv = worldXZ / 2 —
        // which is exact on the flat and degenerate on a cut face: a 40° bank gets a metre of uv
        // for every 1.3 m of slope, and a near-vertical one smears a single row of texels all the
        // way down. That is the vertical streaking on the Chesterfield embankment. Sampling on all
        // three world planes and blending by the normal costs three fetches and holds scale
        // whatever the ground is doing. The exponent decides how narrow the blend band is; 4 keeps
        // flat ground effectively single-sampled and only pays on the slopes.
        vec3 triplanar(sampler2D t, vec3 p, vec3 n, float scale, vec2 off) {
          vec3 w = pow(abs(n), vec3(4.0));
          w /= max(1e-4, w.x + w.y + w.z);
          vec3 c = vec3(0.0);
          if (w.y > 0.001) c += texture2D(t, p.xz * scale + off).rgb * w.y;
          if (w.x > 0.001) c += texture2D(t, p.zy * scale + off).rgb * w.x;
          if (w.z > 0.001) c += texture2D(t, p.xy * scale + off).rgb * w.z;
          return c;
        }`)
      .replace(
        '#include <map_fragment>',
        `
        #ifdef USE_MAP
          vec4 img = texture2D(map, vMapUv);
          img.rgb = mix(img.rgb, vec3(dot(img.rgb, vec3(0.3, 0.5, 0.2))), imageryDesat);
          vec4 ground = img;
          if (hasGrass == 1) {
            vec3 n = normalize(vWorldN);
            // the mow line ~8 m out, rough grass to ~22 m, then the air photo takes over
            float wMown = 1.0 - smoothstep(6.5, 9.5, vEdge);
            float wRough = smoothstep(6.5, 9.5, vEdge) * (1.0 - smoothstep(18.0, 26.0, vEdge));
            vec3 grass;
            float wGrass;
            if (uGROn > 0.5) {
              // RELIEF UNDERLAYMENT (GRASS_GROUND 1). A dense, camera-facing grass surface painted on
              // the ground itself, lit by the scene through gGRNormal below. No cards, no geometry —
              // the real 3D blades (GRASS_MODE 0) are drawn above it by grass.ts.
              //
              // REGION. The walk in grRelief is ~200 hash evaluations per fragment, and the strip is
              // 5 km of ground, so the relief is only evaluated inside a cone AHEAD of the driver
              // (GRASS_SHADER_CONE, out to GRASS_SHADER_RADIUS) plus a small circle all round
              // (GRASS_SHADER_NEAR). Everything else keeps the static photo turf, which is a few
              // texture fetches. reg is the blend weight, and it also weights the relief normal, so
              // the far photo turf keeps the ground's real upward normal.
              float distCam = distance(cameraPosition, vWorldXZ);
              vec3 cf = -normalize(vec3(mat3(viewMatrix)[0].z, mat3(viewMatrix)[1].z, mat3(viewMatrix)[2].z));
              vec2 camFwd = normalize(cf.xz + vec2(1e-4, 0.0));
              vec2 toFrag = normalize(vWorldXZ.xz - cameraPosition.xz + vec2(1e-4, 0.0));
              float facing = dot(toFrag, camFwd);
              float rd = 1.0 - smoothstep(uGRFar * 0.75, uGRFar, distCam);
              float rc = smoothstep(uGRCone - 0.15, uGRCone, facing);
              float rn = 1.0 - smoothstep(uGRNear * 0.6, max(uGRNear, 1e-3), distCam);
              float reg = max(rd * rc, rn);
              if (reg > 0.01) {
                vec3 V = normalize(cameraPosition - vWorldXZ);
                float roughMix = wRough / max(wMown + wRough, 1e-4);
                float cov;
                vec3 rc0 = grRelief(vWorldXZ, V, roughMix, cov, gGRNormal);
                // the blade colour only; coverage says how much of the pixel it covers. It is blended
                // over the ground below, so the gaps between blades are real ground, not green gel.
                vec3 relief = rc0 * grassTint;
                // the mode-0 photo turf underneath, for the fade and beyond
                vec3 mown = mix(triplanar(grassMown, vWorldXZ, n, 0.5, vec2(0.0)), triplanar(grassMown, vWorldXZ, n, 0.137, vec2(0.31, 0.77)), 0.4);
                vec3 roughTurf = mix(triplanar(grassRough, vWorldXZ, n, 0.485, vec2(0.13, 0.41)), triplanar(grassRough, vWorldXZ, n, 0.121, vec2(0.62, 0.19)), 0.4);
                mown = mix(mown, vec3(dot(mown, vec3(0.3, 0.5, 0.2))), imageryDesat);
                roughTurf = mix(roughTurf, vec3(dot(roughTurf, vec3(0.3, 0.5, 0.2))), imageryDesat);
                float lum = clamp(dot(img.rgb, vec3(0.3, 0.5, 0.2)) * 2.2, 0.55, 1.35);
                vec3 turf = (mown * wMown + roughTurf * wRough) * grassTint * lum;
                float cw = clamp(reg * cov, 0.0, 1.0);
                grass = mix(turf, relief, cw);
                gGRW = cw;
              } else {
                // outside the cone: plain mode-0 photo turf
                vec3 mown = mix(triplanar(grassMown, vWorldXZ, n, 0.5, vec2(0.0)), triplanar(grassMown, vWorldXZ, n, 0.137, vec2(0.31, 0.77)), 0.4);
                vec3 roughTurf = mix(triplanar(grassRough, vWorldXZ, n, 0.485, vec2(0.13, 0.41)), triplanar(grassRough, vWorldXZ, n, 0.121, vec2(0.62, 0.19)), 0.4);
                mown = mix(mown, vec3(dot(mown, vec3(0.3, 0.5, 0.2))), imageryDesat);
                roughTurf = mix(roughTurf, vec3(dot(roughTurf, vec3(0.3, 0.5, 0.2))), imageryDesat);
                float lum = clamp(dot(img.rgb, vec3(0.3, 0.5, 0.2)) * 2.2, 0.55, 1.35);
                grass = (mown * wMown + roughTurf * wRough) * grassTint * lum;
                gGRW = 0.0;
              }
              wGrass = clamp(wMown + wRough, 0.0, 1.0);
            } else {
              // two scales of each turf, the second four times larger and offset, mixed 40 %: a
              // single 2 m tile repeats visibly from any height ("the repeating grass texture is
              // terrible") and the product of two incommensurate periods does not
              vec3 mown = mix(triplanar(grassMown, vWorldXZ, n, 0.5, vec2(0.0)), triplanar(grassMown, vWorldXZ, n, 0.137, vec2(0.31, 0.77)), 0.4);
              vec3 rough = mix(triplanar(grassRough, vWorldXZ, n, 0.485, vec2(0.13, 0.41)), triplanar(grassRough, vWorldXZ, n, 0.121, vec2(0.62, 0.19)), 0.4);
              // a style that greys the photo greys the turf too, or a lilac tint over a green
              // texture is mud; greyscale turf under the tint IS lilac turf
              mown = mix(mown, vec3(dot(mown, vec3(0.3, 0.5, 0.2))), imageryDesat);
              rough = mix(rough, vec3(dot(rough, vec3(0.3, 0.5, 0.2))), imageryDesat);
              // the imagery's own brightness is kept as a large-scale modulation so fields and
              // woods still read through the grass tiles
              float lum = clamp(dot(img.rgb, vec3(0.3, 0.5, 0.2)) * 2.2, 0.55, 1.35);
              grass = (mown * wMown + rough * wRough) * grassTint * lum;
              wGrass = clamp(wMown + wRough, 0.0, 1.0);
            }
            ground = vec4(mix(img.rgb, grass, wGrass), 1.0);
            // FOREST FLOOR. Under a closed canopy the verge is leaf litter, not turf: the same
            // CHM > 3 m that stops the grass generator putting a single blade here (68 % of the
            // Chesterfield verge) should stop the ground reading as mown grass too. Blended over
            // 2–4 m of canopy height so a hedge line is a gradient and not a cut-out, and kept
            // off the pavement by the same edge distance everything else uses.
            if (hasForest == 1) {
              // canopy closing over AND clear of the mown strip: a highway crew mows under an
              // overhanging crown, so the first few metres off the shoulder stay turf even in
              // closed woodland. 41 % of Bowie's verge is under canopy by the CHM and most of that
              // is overhang, not forest floor.
              //
              // litterSpread moves the canopy threshold with the SEASON. A wood in leaf drops
              // almost nothing on the verge beside it (spread 0.2: litter only where the CHM is
              // really closed); the same wood in November has covered it (spread 1.0: litter
              // wherever there is any canopy at all nearby). That, and not the bare branches
              // alone, is what makes a winter wood read as winter.
              float lo = mix(3.0, 0.2, litterSpread), hi = mix(5.0, 1.2, litterSpread);
              float wForest = smoothstep(lo, hi, vCanopy) * smoothstep(4.0, 10.0, vEdge);
              // NOT multiplied by the photo's luminance. Under a crown the air photo shows the
              // crown, and the crown is dark, so litter x lum came out near black: the "weird
              // brown areas along roadways" Rich saw from the air (2026-09-26), isolated by
              // switching this blend off. The floor keeps its own brightness and is pulled a
              // third of the way toward the photo, so from above it reads as shaded ground under
              // trees and from the car it reads as litter, and neither is a black stripe.
              vec3 litter = triplanar(forestFloor, vWorldXZ, n, 0.5, vec2(0.37, 0.11)) * litterTint * 1.6;
              litter = mix(litter, img.rgb, 0.45);
              // and never the whole way: a verge under trees is litter over turf, not a floor. The
              // full replacement read as a brown stripe along the parkway from the air even after
              // the luminance fix; at 0.65 the turf shows through and the stripe is a shading.
              ground = vec4(mix(ground.rgb, litter, wForest * 0.65), 1.0);
            }
          }
          // snow, ice and rain last, over whatever the ground turned out to be
          ground = vec4(applyWeather(ground.rgb, normalize(vWorldN), vWorldXZ), 1.0);
          diffuseColor *= ground;
        #endif
        `,
      )
      // the relief turf replaces the surface normal so the scene's own lights (sun, sky, headlights)
      // shade it as relief — the "reactive to light" half of the idea
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        if (uGROn > 0.5 && gGRW > 0.0) {
          vec3 grN = normalize((viewMatrix * vec4(gGRNormal, 0.0)).xyz);
          normal = normalize(mix(normal, grN, gGRW));
        }`,
      )
    injectShade(shader)
    injectWetStreak(shader)
    // OPTIMIZED PATH (FAKE lamps): the analytic flood also lights the verge. car.ts turns the real
    // headlight spots off while they are fake, so the two never double up.
    injectFloodLamp(shader)
  }
  mat.customProgramCacheKey = () => 'corridor-strip-shade-wet-vert'
  const mesh = new THREE.Mesh(geo, mat)
  mesh.name = 'strip'
  // GRASS EDGE FACE. The lift above put the turf proud of the pavement; on its own that shows only
  // as the strip's own 1 m triangle, which spreads a 7.5 cm rise into a 4° bevel nobody can see.
  // This walks the pavement edges and drops a short, near-vertical face from each plus a shelf out
  // to the next strip column, so the strip's own ramp is hidden underneath. It shares the strip's
  // material, so it is the same turf texture, tint, weather and light. Emitted with both windings:
  // the face is thin and the material is FrontSide, so this avoids a per-side winding guess.
  if (lipM > 0) {
    const fp: number[] = []
    const fuv: number[] = []
    const fn: number[] = []
    const fe: number[] = []
    const fc: number[] = []
    const fi: number[] = []
    const lift0 = lipM
    // The face is the crisp lip: a near-vertical run from the pavement edge up to the turf. Keep it
    // steep — GRASS_EDGE_M is the horizontal run, so smaller is a sharper lip.
    const run = Math.max(0.02, Math.min(T.GRASS_EDGE_M, across * 0.5))
    // The shelf is the turf top. It runs from the face out past the strip's FIRST grass column — the
    // mesh only reaches full lift at a vertex, not at e.d = liftRamp, so a shelf that stops at
    // liftRamp leaves the strip's own 1 m ramp poking through. It floats 4 mm above the strip so the
    // two surfaces cannot z-fight where they meet.
    const shelfOut = across + 0.3
    const shelfUp = 0.004
    const hash2 = (a: number, b: number): number => {
      const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453
      return s - Math.floor(s)
    }
    const cross = (i: number, j: number): { x: number; y: number; z: number; ox: number; oz: number; h: number } | null => {
      const k0 = i * nL + (j - 1), k1 = i * nL + j
      if (dead[k0] || dead[k1]) return null
      const d0 = edge[k0], d1 = edge[k1]
      let sgn: number
      if (d0 < 0 && d1 >= 0) sgn = 1 // pavement -> grass, outward is +side
      else if (d0 >= 0 && d1 < 0) sgn = -1 // grass -> pavement, outward is -side
      else return null
      const f = d0 / (d0 - d1)
      const o = offs[j - 1] + f * (offs[j] - offs[j - 1])
      const o0 = origins[i], sd = sides[i]
      // a per-crossing height jitter so the lip is TORN, not ruled: the last row of turf reads as
      // blades defining the edge. 1.0…1.35, never below 1, so the shelf can never sink under the strip.
      const h = 1.0 + 0.35 * hash2(i * 1.37 + (sgn > 0 ? 0.0 : 51.7), j * 2.11)
      return {
        x: o0.x + sd.x * o,
        y: baseY[k0] * (1 - f) + baseY[k1] * f,
        z: o0.z + sd.z * o,
        ox: sd.x * sgn,
        oz: sd.z * sgn,
        h,
      }
    }
    const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number): number => {
      const vi = fp.length / 3
      fp.push(x, y, z)
      // WORLD imagery uv, the same mapping the strip itself uses. This used to be (0, y), which
      // sampled a single column of the aerial photo down the whole fringe — the teal stripe and the
      // crosshatch along the kerb.
      fuv.push((x - bx0) / (bx1 - bx0), (-z - by0) / (by1 - by0))
      // Fringe vertices carry their OWN normals; see the note where the geometry is finished for why
      // computeVertexNormals() cannot work here.
      fn.push(nx, ny, nz)
      fe.push(0)
      fc.push(0)
      return vi
    }
    // The lip's normal is kept CLOSE TO UP on purpose. The ground shader is triplanar: it blends the
    // x/z world planes by pow(abs(normal), 4), so a normal with any real horizontal component makes
    // the wall cross-fade two projections and beat into the crosshatch woven band along the kerb, and
    // shades it like a separate surface. Near-vertical normals (true for this wall) are the worst case.
    // Very nearly up keeps the xz sample dominant, so the lip is the same turf as the ground under it,
    // while the slight outward tilt still lets the sun and headlights rake it.
    const faceN = (c: { ox: number; oz: number }): [number, number, number] => {
      const k = 0.35
      const nx = -c.ox * k, ny = 1.0, nz = -c.oz * k
      const s = 1 / Math.hypot(nx, ny, nz)
      return [nx * s, ny * s, nz * s]
    }
    for (let j = 1; j < nL; j++) {
      for (let i = 0; i < nS - 1; i++) {
        const c0 = cross(i, j), c1 = cross(i + 1, j)
        if (!c0 || !c1) continue
        const l0 = lift0 * c0.h, l1 = lift0 * c1.h
        const n0 = faceN(c0), n1 = faceN(c1)
        const a = push(c0.x, c0.y, c0.z, n0[0], n0[1], n0[2])
        const b = push(c0.x + c0.ox * run, c0.y + l0, c0.z + c0.oz * run, 0, 1, 0)
        const e = push(c1.x, c1.y, c1.z, n1[0], n1[1], n1[2])
        const f = push(c1.x + c1.ox * run, c1.y + l1, c1.z + c1.oz * run, 0, 1, 0)
        const g = push(c0.x + c0.ox * shelfOut, c0.y + l0 + shelfUp, c0.z + c0.oz * shelfOut, 0, 1, 0)
        const h = push(c1.x + c1.ox * shelfOut, c1.y + l1 + shelfUp, c1.z + c1.oz * shelfOut, 0, 1, 0)
        // BOTH WINDINGS. The material is FrontSide and which way the face looks depends on which side
        // of the carriageway the edge is on, so picking one winding culled the lip on one side of
        // every divided highway. The extra triangles are hidden back-faces.
        fi.push(a, e, f, a, f, b, a, b, f, a, f, e)
        fi.push(b, f, h, b, h, g, b, g, h, b, h, f)
      }
    }
    if (fi.length) {
      const fgeo = new THREE.BufferGeometry()
      fgeo.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3))
      fgeo.setAttribute('normal', new THREE.Float32BufferAttribute(fn, 3))
      fgeo.setAttribute('uv', new THREE.Float32BufferAttribute(fuv, 2))
      fgeo.setAttribute('aEdge', new THREE.Float32BufferAttribute(fe, 1))
      fgeo.setAttribute('aCanopy', new THREE.Float32BufferAttribute(fc, 1))
      fgeo.setIndex(fi)
      // NO computeVertexNormals. Every quad below is emitted twice with opposite windings (so the
      // thin single-sided face is visible from either side of a divided highway). computeVertexNormals
      // sums each face's area-weighted normal into its vertices, so the two copies of a quad cancel
      // each other and every fringe normal collapses toward zero: the shader then triplanar-samples
      // all three planes at random and the surface lights from nowhere. That is the black shard and
      // the teal crosshatch in the lip. Normals are supplied per-vertex by push instead.
      const fmesh = new THREE.Mesh(fgeo, mat)
      fmesh.name = 'strip:edge'
      fmesh.receiveShadow = true
      mesh.add(fmesh)
    }
  }
  mesh.receiveShadow = true
  // the blend uniforms are merged into the compiled shader and otherwise unreachable from outside;
  // a probe that wants to switch the forest floor or the turf off to see what is under it (the
  // bisection in probes/corridor-stanceshot.mjs) finds them here
  mesh.userData.uniforms = uniforms
  // CULL IT. This was off, which is right for one 5 km corridor strip whose bounding sphere covers
  // the site anyway, and wrong the moment a network gave every branch its own: 428 of them were
  // submitted in full from anywhere on crofton-triangle. The primary's sphere is still site-sized
  // and still always passes, so this costs nothing there and removes the branches when they are
  // behind you.
  mesh.frustumCulled = true
  geo.computeBoundingSphere()

  // height lookup: nearest station by projecting onto the spine polyline (origins every `along`).
  // `lat` comes back too, because the sink taper below needs to know how near the rim we are.
  const probe = (x: number, z: number): { y: number; lat: number } | null => {
    // coarse search: nearest origin
    let best = Infinity, bi = -1
    for (let i = 0; i < nS; i += 8) {
      const d = (origins[i].x - x) ** 2 + (origins[i].z - z) ** 2
      if (d < best) { best = d; bi = i }
    }
    for (let i = Math.max(0, bi - 8); i <= Math.min(nS - 1, bi + 8); i++) {
      const d = (origins[i].x - x) ** 2 + (origins[i].z - z) ** 2
      if (d < best) { best = d; bi = i }
    }
    if (bi < 0) return null
    // bilinear: along-track between this station and the next toward the point, across between
    // the two lateral columns — a nearest-vertex lookup stepped the car 25 cm every 2 m
    const o = origins[bi], sd = sides[bi]
    const fwd = { x: sd.z, z: -sd.x } // side = dir × up = (-dz, 0, dx), so dir = (side.z, 0, -side.x)
    const alongM = (x - o.x) * fwd.x + (z - o.z) * fwd.z
    // PAST THE END the strip does not exist. Without this the nearest station to a point a
    // kilometre beyond the last one is still that last station, `lat` is measured in its frame,
    // and every point inside |lat| < left reads as "on the strip" — an 80 m band running off the
    // end of every road for ever. `sinkUnderStrip` then DROPPED the terrain triangles in those
    // bands, which is the sky showing through past each cul-de-sac (Rich, 2026-09-21): ten roads,
    // twenty wedges. Half a station of tolerance keeps the end cap itself intact.
    if ((bi === 0 && alongM < -along * 0.5) || (bi === nS - 1 && alongM > along * 0.5)) return null
    const bj = alongM >= 0 ? Math.min(nS - 1, bi + 1) : Math.max(0, bi - 1)
    const fa = Math.min(1, Math.abs(alongM) / along)
    const lat = (x - o.x) * sd.x + (z - o.z) * sd.z
    const jf = (lat + left) / across
    const j0 = Math.floor(jf), j1 = Math.min(nL - 1, j0 + 1)
    if (j0 < 0 || j0 >= nL) return null
    const fj = jf - j0
    const h = (i: number) => heights[i * nL + j0] * (1 - fj) + heights[i * nL + j1] * fj
    const y = h(bi) * (1 - fa) + h(bj) * fa
    if (Number.isNaN(y)) return null // a skipped station: another road's strip owns this ground
    return { y, lat }
  }
  const heightAt = (x: number, z: number): number | null => probe(x, z)?.y ?? null

  /**
   * Where to put a coarse-terrain vertex that the strip covers.
   *
   * Deep inside the strip the terrain can go a long way down: it is a 2 m lattice under a 1 m
   * sheet and would otherwise poke through, and nobody can see it. At the RIM the two have to
   * meet — out there the strip's own height is the DEM, the same DEM the terrain is built from —
   * so the sink tapers to a few centimetres over the last `margin` metres.
   *
   * Without the taper (sinkUnderStrip took a `margin` argument and then `void`ed it) the terrain
   * arrived at the rim still 0.5–1.1 m low, and since the strip stops there, nothing covered it:
   * a trench about three metres wide ran down both sides of the corridor for the length of the
   * site. Measured on Bowie at s = 1000 and s = 3219 with probes/corridor-float.mjs.
   */
  const sinkAt = (x: number, z: number, deep = 2.2, band = 3.5): number | null => {
    const r = probe(x, z)
    if (!r) return null
    // zero at the rim, so the two surfaces MEET where the strip stops and the terrain carries on,
    // growing inward to clear the chord error of a 4 m lattice under a 1 m sheet (0.64 m at the
    // worst place on Bowie). Past `margin` in sinkUnderStrip there is no terrain left to clear.
    const rim = Math.min(r.lat + left, right - r.lat)
    return r.y - deep * THREE.MathUtils.smoothstep(rim, 0, band)
  }
  /** how far inside the strip a point is, in metres; ≤ 0 outside it */
  const coverAt = (x: number, z: number): number => {
    const r = probe(x, z)
    return r === null ? -1 : Math.min(r.lat + left, right - r.lat)
  }
  geo.computeBoundingBox()
  const bb = geo.boundingBox!
  return {
    mesh,
    heightAt,
    sinkAt,
    coverAt,
    bounds: [bb.min.x, bb.min.z, bb.max.x, bb.max.z] as [number, number, number, number],
    setTint: (c: THREE.Color, ground: THREE.Color) => {
      uniforms.grassTint.value.copy(c)
      mat.color.copy(ground)
    },
    /** the season's leaf litter: its colour, and how far past the crowns it has fallen */
    setLitter: (tint: THREE.Color, spread: number) => {
      uniforms.litterTint.value.copy(tint)
      uniforms.litterSpread.value = spread
    },
    /** how much of the photo a style leaves: 0 realistic, toward 1 for a palette that is not this place */
    setImageryDesat: (v: number) => { uniforms.imageryDesat.value = v },
    /** hand these to Precipitation.follow so the settled layer and the wet look drive them */
    weatherUniforms: uniforms as unknown as Record<string, THREE.IUniform>,
  }
}

/** Sink coarse-terrain vertices that lie under the strip so nothing pokes through it. */
/**
 * Get the coarse terrain out of the strip's way.
 *
 * It used to be pushed down a flat 2.5 m wherever the strip covered it. That leaves two faults.
 * Deep inside, sinking VERTICES does not stop the surface BETWEEN them from rising back through
 * the strip: the terrain is a 4 m lattice (stride 2 over the 2 m DEM) under a 1 m sheet, and over
 * a crest the chord between two sunk vertices crossed above the strip by up to 0.55 m, measured
 * on Bowie. At the rim the 2.5 m step had nothing over it at all, because that is exactly where
 * the strip stops — a trench a few metres wide down both sides of the site for its whole length.
 *
 * So: drop the terrain triangles the strip fully covers — they can never be seen and cannot tear
 * through what they cannot reach — and keep the ring that straddles the rim, nudged down by
 * `strip.sinkAt`'s few centimetres so the strip wins the seam. Out there the strip's height IS
 * the DEM the terrain is built from, so the two meet.
 */
export interface StripCover {
  sinkAt: (x: number, z: number) => number | null
  coverAt: (x: number, z: number) => number
  bounds: [number, number, number, number]
}

/**
 * A coarse grid over anything that carries `bounds`, so a point asks the two or three whose extent
 * actually reaches it rather than all of them.
 *
 * `sinkUnderStrips` already had this grid inline — it is what took the sink from 84 s to 0.7 s on
 * crofton-triangle's 427 branches. `stripHeight` in scene.ts did NOT have it, and that turned out
 * to be the single largest cost in the whole load: every ground query that was not on the primary
 * road walked all 427 branch strips before falling through to the DEM. Measured on Rich's machine
 * through the dev bridge, 2026-09-21: 0.4 µs for a point on the primary strip (first try, no scan)
 * against 45.3 µs for a point off every strip. Buildings alone make 68 347 of those queries — 3.2 s
 * of the build, against 9 ms for all the geometry they actually assemble.
 *
 * Everything that stands on the ground goes through that lookup: buildings, grass (once a blade),
 * crops, placements, power, furniture, parking, barriers, sidewalks, rocks, water and bridges. So
 * it lives here now, shared, instead of being re-derived at each call site.
 */
export class BoundsIndex<T extends { bounds: [number, number, number, number] }> {
  private grid = new Map<number, T[]>()
  private cell: number
  private pad: number

  constructor(items: readonly T[], cell = 250, pad = 1) {
    this.cell = cell
    this.pad = pad
    for (const it of items) {
      const [x0, z0, x1, z1] = it.bounds
      if (!Number.isFinite(x0)) continue
      for (let cx = Math.floor((x0 - pad) / cell); cx <= Math.floor((x1 + pad) / cell); cx++) {
        for (let cz = Math.floor((z0 - pad) / cell); cz <= Math.floor((z1 + pad) / cell); cz++) {
          const k = cx * 100003 + cz
          const arr = this.grid.get(k)
          if (arr) arr.push(it)
          else this.grid.set(k, [it])
        }
      }
    }
  }

  /**
   * The first non-null `hit` among the items whose bounds contain (x, z). Allocation-free: this
   * runs hundreds of thousands of times a load, so it takes a callback rather than returning a
   * filtered array.
   */
  firstAt<R>(x: number, z: number, hit: (item: T) => R | null): R | null {
    const near = this.grid.get(Math.floor(x / this.cell) * 100003 + Math.floor(z / this.cell))
    if (!near) return null
    const pad = this.pad
    for (let i = 0; i < near.length; i++) {
      const it = near[i]
      const [x0, z0, x1, z1] = it.bounds
      if (x < x0 - pad || x > x1 + pad || z < z0 - pad || z > z1 + pad) continue
      const r = hit(it)
      if (r !== null) return r
    }
    return null
  }
}

/**
 * Get the coarse terrain out of the way of EVERY strip, in one pass.
 *
 * It used to be one call per strip. That is fine for a corridor with one carriageway and quadratic
 * for a network: crofton-triangle has 427 branch strips, and each call allocated a fresh cover
 * array over 580 000 terrain vertices AND rebuilt the whole 1.7-million-entry index. 427 of those
 * was **84 of the 125 second build**, with the browser frozen for all of it. A bounding-box
 * fast-path in front of the expensive probe took it to 60 s; the rest was the per-call allocation
 * and index rebuild, which only one pass can remove.
 *
 * So: one cover array, one index rebuild, and the strips bucketed into a coarse grid so a vertex
 * only asks the two or three strips whose extent actually reaches it rather than all 427.
 *
 * The sink itself is unchanged. A vertex covered by several strips takes the LOWEST of their
 * targets, and keeps the deepest cover for the triangle test — a triangle buried under any strip
 * is dropped, which is what dropping it per strip used to achieve one strip at a time.
 */
export async function sinkUnderStrips(geo: THREE.BufferGeometry, strips: StripCover[], margin = 9, maxLift = 3.5, budget?: Budget, normals = true) {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  if (!strips.length || !pos) return
  const cover = new Float32Array(pos.count).fill(-1)
  const pad = margin + 1

  // bucket the strips by a grid over their extents, so a vertex asks only the strips near it
  const CELL = 250
  const grid = new Map<number, number[]>()
  const key = (cx: number, cz: number) => cx * 100003 + cz
  for (let i = 0; i < strips.length; i++) {
    const [x0, z0, x1, z1] = strips[i].bounds
    if (!Number.isFinite(x0)) continue
    for (let cx = Math.floor((x0 - pad) / CELL); cx <= Math.floor((x1 + pad) / CELL); cx++) {
      for (let cz = Math.floor((z0 - pad) / CELL); cz <= Math.floor((z1 + pad) / CELL); cz++) {
        const k = key(cx, cz)
        const arr = grid.get(k)
        if (arr) arr.push(i)
        else grid.set(k, [i])
      }
    }
  }

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i)
    const near = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)))
    if (!near) continue
    const y0 = pos.getY(i)
    let bestCover = -1
    let lowest = Infinity
    for (let k = 0; k < near.length; k++) {
      const st = strips[near[k]]
      const [x0, z0, x1, z1] = st.bounds
      if (x < x0 - pad || x > x1 + pad || z < z0 - pad || z > z1 + pad) continue
      const c = st.coverAt(x, z)
      if (c <= 0) continue
      const y = st.sinkAt(x, z)
      if (y === null) continue
      // A DECK IS NOT A COVER. Being laterally inside the strip is not the same as having it over
      // your head: on a bridge the strip is the deck, five to twelve metres up, and the valley
      // floor below is in full view. Dropping those triangles punched a hole through the world.
      // A fill embankment never reaches maxLift — its blend is back on the DEM within seven metres.
      if (y - y0 > maxLift) continue
      if (c > bestCover) bestCover = c
      if (y < lowest) lowest = y
    }
    cover[i] = bestCover
    if (lowest < Infinity) pos.setY(i, Math.min(y0, lowest))
    if (budget && (i & 63) === 63) await budget.tick()
  }

  const idx = geo.getIndex()
  if (idx) {
    const src = idx.array
    const kept = new Uint32Array(src.length)
    let n = 0
    for (let t = 0; t < src.length; t += 3) {
      const a = src[t], b = src[t + 1], c = src[t + 2]
      if (cover[a] > margin && cover[b] > margin && cover[c] > margin) continue
      kept[n++] = a
      kept[n++] = b
      kept[n++] = c
      if (budget && (t & 8191) === 8191) await budget.tick()
    }
    geo.setIndex(new THREE.BufferAttribute(kept.subarray(0, n), 1))
  }
  pos.needsUpdate = true
  // The site overview is up to a million vertices. Rebuilding its normals here is the ~100 ms
  // hitch at the end of every strip. Callers that defer that pass pass `normals` false.
  if (normals) geo.computeVertexNormals()
}

/**
 * The same normal pass as `BufferGeometry.computeVertexNormals`, yielding on a budget.
 *
 * One call on the site overview is about 100 ms. Sliced, it spreads across frames instead of
 * stopping the one that turned the mesh back on.
 */
export async function refreshNormals(geo: THREE.BufferGeometry, budget?: Budget, stop?: () => boolean): Promise<boolean> {
  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute | undefined
  if (!posAttr) return false
  let normalAttr = geo.getAttribute('normal') as THREE.BufferAttribute | undefined
  if (!normalAttr || normalAttr.count !== posAttr.count) {
    normalAttr = new THREE.BufferAttribute(new Float32Array(posAttr.count * 3), 3)
    geo.setAttribute('normal', normalAttr)
  }
  const pos = posAttr.array as ArrayLike<number>
  const nor = normalAttr.array as Float32Array
  const pause = async () => {
    if (stop?.()) return true
    if (budget) await budget.tick()
    return stop?.() ?? false
  }
  for (let i = 0; i < nor.length; i++) {
    nor[i] = 0
    if (budget && (i & 65535) === 65535 && await pause()) return false
  }
  const index = geo.getIndex()
  const add = (ia: number, ib: number, ic: number) => {
    const abx = pos[ia] - pos[ib], aby = pos[ia + 1] - pos[ib + 1], abz = pos[ia + 2] - pos[ib + 2]
    const cbx = pos[ic] - pos[ib], cby = pos[ic + 1] - pos[ib + 1], cbz = pos[ic + 2] - pos[ib + 2]
    const nx = cby * abz - cbz * aby
    const ny = cbz * abx - cbx * abz
    const nz = cbx * aby - cby * abx
    nor[ia] += nx; nor[ia + 1] += ny; nor[ia + 2] += nz
    nor[ib] += nx; nor[ib + 1] += ny; nor[ib + 2] += nz
    nor[ic] += nx; nor[ic + 1] += ny; nor[ic + 2] += nz
  }
  if (index) {
    const idx = index.array
    for (let t = 0, n = 0; t < idx.length; t += 3, n++) {
      add(idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3)
      if ((n & 4095) === 4095 && await pause()) return false
    }
  } else {
    for (let i = 0, n = 0; i < posAttr.count; i += 3, n++) {
      add(i * 3, (i + 1) * 3, (i + 2) * 3)
      if ((n & 4095) === 4095 && await pause()) return false
    }
  }
  for (let i = 0; i < nor.length; i += 3) {
    const x = nor[i], y = nor[i + 1], z = nor[i + 2]
    const len = Math.hypot(x, y, z)
    if (len > 0) { nor[i] = x / len; nor[i + 1] = y / len; nor[i + 2] = z / len }
    if (budget && (i & 65535) === 65535 && await pause()) return false
  }
  if (stop?.()) return false
  normalAttr.needsUpdate = true
  return true
}

/** One strip's worth of the above, for callers that have only one. */
export function sinkUnderStrip(
  geo: THREE.BufferGeometry,
  sinkTo: (x: number, z: number) => number | null,
  coverAt: (x: number, z: number) => number,
  margin = 9,
  maxLift = 3.5,
  bounds: [number, number, number, number] = [-Infinity, -Infinity, Infinity, Infinity],
) {
  void sinkUnderStrips(geo, [{ sinkAt: sinkTo, coverAt, bounds }], margin, maxLift)
}
