// The road corridor as its own fine terrain: a strip swept along the spine, wide enough to take
// in every carriageway and the median plus 40 m of verge each side, sampled 1 m across by 2 m
// along. Under any pavement it sits at that carriageway's road height; from the pavement edge it
// blends back to the DEM over 7 m. So there is no coarse triangle to interpolate across the road,
// cut faces beside the shoulder are resolved at 1 m, and the grass ground is one material:
// imagery everywhere, mown turf inside the mow line, rough grass beyond, blended by the same
// edge distance the blades use. The coarse terrain is sunk beneath it.
import * as THREE from 'three'
import { ACCUM_PARS, accumUniforms } from './weather'

export interface Edge {
  d: number // signed distance to the nearest pavement edge (negative on the pavement)
  y: number // road surface height at that station
}

export function buildStrip(
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
): {
  mesh: THREE.Mesh
  heightAt: (x: number, z: number) => number | null
  /** where a coarse-terrain vertex goes under the strip's rim; null outside the strip */
  sinkAt: (x: number, z: number) => number | null
  /** metres inside the strip, ≤ 0 outside: how sinkUnderStrip knows which triangles to drop */
  coverAt: (x: number, z: number) => number
  setLitter: (tint: THREE.Color, spread: number) => void
  weatherUniforms: Record<string, THREE.IUniform>
  setTint: (c: THREE.Color, ground: THREE.Color) => void
} {
  const nS = Math.floor(length / along) + 1
  const skipped = new Uint8Array(nS)
  const offs: number[] = []
  for (let o = -left; o <= right + 1e-6; o += across) offs.push(o)
  const nL = offs.length
  const pos = new Float32Array(nS * nL * 3)
  const uv = new Float32Array(nS * nL * 2)
  const edge = new Float32Array(nS * nL)
  const canopy = new Float32Array(nS * nL)
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
      const y = (e.d < 0.6 ? e.y - 0.02 : (e.y - 0.02) * (1 - t) + dem * t) + off
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
    }
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
  }
  const idx = n === idxAll.length ? idxAll : idxAll.slice(0, n)
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
        uniform vec3 grassTint;
        varying float vEdge;
        varying float vCanopy;
        varying vec3 vWorldXZ;
        varying vec3 vWorldN;
        ${ACCUM_PARS}
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
          vec4 ground = img;
          if (hasGrass == 1) {
            vec3 n = normalize(vWorldN);
            vec3 mown = triplanar(grassMown, vWorldXZ, n, 0.5, vec2(0.0));
            vec3 rough = triplanar(grassRough, vWorldXZ, n, 0.485, vec2(0.13, 0.41));
            // the mow line ~8 m out, rough grass to ~22 m, then the air photo takes over; the
            // imagery's own brightness is kept as a large-scale modulation so fields and woods
            // still read through the grass tiles
            float wMown = 1.0 - smoothstep(6.5, 9.5, vEdge);
            float wRough = smoothstep(6.5, 9.5, vEdge) * (1.0 - smoothstep(18.0, 26.0, vEdge));
            float lum = clamp(dot(img.rgb, vec3(0.3, 0.5, 0.2)) * 2.2, 0.55, 1.35);
            vec3 grass = (mown * wMown + rough * wRough) * grassTint * lum;
            float wGrass = clamp(wMown + wRough, 0.0, 1.0);
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
              vec3 litter = triplanar(forestFloor, vWorldXZ, n, 0.5, vec2(0.37, 0.11)) * litterTint * 1.6 * lum;
              ground = vec4(mix(ground.rgb, litter, wForest), 1.0);
            }
          }
          // snow, ice and rain last, over whatever the ground turned out to be
          ground = vec4(applyWeather(ground.rgb, normalize(vWorldN), vWorldXZ), 1.0);
          diffuseColor *= ground;
        #endif
        `,
      )
  }
  mat.customProgramCacheKey = () => 'corridor-strip'
  const mesh = new THREE.Mesh(geo, mat)
  mesh.name = 'strip'
  mesh.frustumCulled = false

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
  return {
    mesh,
    heightAt,
    sinkAt,
    coverAt,
    setTint: (c: THREE.Color, ground: THREE.Color) => {
      uniforms.grassTint.value.copy(c)
      mat.color.copy(ground)
    },
    /** the season's leaf litter: its colour, and how far past the crowns it has fallen */
    setLitter: (tint: THREE.Color, spread: number) => {
      uniforms.litterTint.value.copy(tint)
      uniforms.litterSpread.value = spread
    },
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
export function sinkUnderStrip(
  geo: THREE.BufferGeometry,
  sinkTo: (x: number, z: number) => number | null,
  coverAt: (x: number, z: number) => number,
  margin = 9,
  maxLift = 3.5,
) {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const cover = new Float32Array(pos.count)
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i)
    cover[i] = coverAt(x, z)
    if (cover[i] <= 0) continue
    const y = sinkTo(x, z)
    if (y === null) { cover[i] = -1; continue }
    // A DECK IS NOT A COVER. Being laterally inside the strip is not the same as having the strip
    // over your head: on a bridge the strip is the deck, five to twelve metres up, and the valley
    // floor below is in full view. Dropping those triangles punched a hole straight through the
    // world — invisible until the deck's 40 m verge stopped hanging over it and hiding it. Where
    // the strip stands more than `maxLift` above this ground, leave the ground alone entirely.
    // A fill embankment never reaches that: its blend is back on the DEM within seven metres.
    if (y - pos.getY(i) > maxLift) { cover[i] = -1; continue }
    pos.setY(i, Math.min(pos.getY(i), y))
  }
  const idx = geo.getIndex()
  if (idx) {
    const src = idx.array
    const kept: number[] = []
    for (let t = 0; t < src.length; t += 3) {
      const a = src[t], b = src[t + 1], c = src[t + 2]
      if (cover[a] > margin && cover[b] > margin && cover[c] > margin) continue
      kept.push(a, b, c)
    }
    geo.setIndex(kept)
  }
  pos.needsUpdate = true
  geo.computeVertexNormals()
}
