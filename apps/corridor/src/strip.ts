// The road corridor as its own fine terrain: a strip swept along the spine, wide enough to take
// in every carriageway and the median plus 40 m of verge each side, sampled 1 m across by 2 m
// along. Under any pavement it sits at that carriageway's road height; from the pavement edge it
// blends back to the DEM over 7 m. So there is no coarse triangle to interpolate across the road,
// cut faces beside the shoulder are resolved at 1 m, and the grass ground is one material:
// imagery everywhere, mown turf inside the mow line, rough grass beyond, blended by the same
// edge distance the blades use. The coarse terrain is sunk beneath it.
import * as THREE from 'three'

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
): { mesh: THREE.Mesh; heightAt: (x: number, z: number) => number | null; setTint: (c: THREE.Color, ground: THREE.Color) => void } {
  const nS = Math.floor(length / along) + 1
  const skipped = new Uint8Array(nS)
  const offs: number[] = []
  for (let o = -left; o <= right + 1e-6; o += across) offs.push(o)
  const nL = offs.length
  const pos = new Float32Array(nS * nL * 3)
  const uv = new Float32Array(nS * nL * 2)
  const edge = new Float32Array(nS * nL)
  const up = new THREE.Vector3(0, 1, 0)
  const [bx0, by0, bx1, by1] = bbox
  let k = 0
  // a lookup grid for heightAt(): station index by along-track, lateral by offset
  const heights = new Float32Array(nS * nL)
  const origins: THREE.Vector3[] = []
  const sides: THREE.Vector3[] = []
  for (let i = 0; i < nS; i++) {
    const sHere = Math.min(length, i * along)
    const st = spineAt(sHere)
    const side = st.dir.clone().setY(0).normalize().cross(up) // right of travel
    origins.push(st.pos)
    sides.push(side)
    if (skipAt && skipAt(sHere)) skipped[i] = 1
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
      heights[k] = skipped[i] ? NaN : y
      // imagery uv from world position inside the site bbox (site y = -world z)
      uv[k * 2] = (x - bx0) / (bx1 - bx0)
      uv[k * 2 + 1] = (-z - by0) / (by1 - by0)
      edge[k] = e.d
      k++
    }
  }
  const idxAll = new Uint32Array((nS - 1) * (nL - 1) * 6)
  let n = 0
  for (let i = 0; i < nS - 1; i++) {
    if (skipped[i] || skipped[i + 1]) continue
    for (let j = 0; j < nL - 1; j++) {
      const a = i * nL + j, b = a + 1, c = a + nL, d = c + 1
      idxAll[n++] = a; idxAll[n++] = c; idxAll[n++] = b
      idxAll[n++] = b; idxAll[n++] = c; idxAll[n++] = d
    }
  }
  const idx = n === idxAll.length ? idxAll : idxAll.slice(0, n)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geo.setAttribute('aEdge', new THREE.BufferAttribute(edge, 1))
  geo.setIndex(new THREE.BufferAttribute(idx, 1))
  geo.computeVertexNormals()

  for (const t of [grassMown, grassRough]) if (t) { t.wrapS = t.wrapT = THREE.RepeatWrapping }
  const mat = new THREE.MeshStandardMaterial({ map: imagery, color: 0xffffff, roughness: 1, metalness: 0 })
  const uniforms = {
    grassMown: { value: grassMown },
    grassRough: { value: grassRough },
    hasGrass: { value: grassMown && grassRough ? 1 : 0 },
    grassTint: { value: new THREE.Color(0xffffff) },
  }
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aEdge;\nvarying float vEdge;\nvarying vec3 vWorldXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEdge = aEdge;\nvWorldXZ = (modelMatrix * vec4(position, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_pars_fragment>', '#include <map_pars_fragment>\nuniform sampler2D grassMown;\nuniform sampler2D grassRough;\nuniform int hasGrass;\nuniform vec3 grassTint;\nvarying float vEdge;\nvarying vec3 vWorldXZ;')
      .replace(
        '#include <map_fragment>',
        `
        #ifdef USE_MAP
          vec4 img = texture2D(map, vMapUv);
          vec4 ground = img;
          if (hasGrass == 1) {
            vec2 guv = vWorldXZ.xz / 2.0;
            vec4 mown = texture2D(grassMown, guv);
            vec4 rough = texture2D(grassRough, guv * 0.97 + vec2(0.13, 0.41));
            // the mow line ~8 m out, rough grass to ~22 m, then the air photo takes over; the
            // imagery's own brightness is kept as a large-scale modulation so fields and woods
            // still read through the grass tiles
            float wMown = 1.0 - smoothstep(6.5, 9.5, vEdge);
            float wRough = smoothstep(6.5, 9.5, vEdge) * (1.0 - smoothstep(18.0, 26.0, vEdge));
            float lum = clamp(dot(img.rgb, vec3(0.3, 0.5, 0.2)) * 2.2, 0.55, 1.35);
            vec3 grass = (mown.rgb * wMown + rough.rgb * wRough) * grassTint * lum;
            float wGrass = clamp(wMown + wRough, 0.0, 1.0);
            ground = vec4(mix(img.rgb, grass, wGrass), 1.0);
          }
          diffuseColor *= ground;
        #endif
        `,
      )
  }
  mat.customProgramCacheKey = () => 'corridor-strip'
  const mesh = new THREE.Mesh(geo, mat)
  mesh.name = 'strip'
  mesh.frustumCulled = false

  // height lookup: nearest station by projecting onto the spine polyline (origins every `along`)
  const heightAt = (x: number, z: number): number | null => {
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
    const bj = alongM >= 0 ? Math.min(nS - 1, bi + 1) : Math.max(0, bi - 1)
    const fa = Math.min(1, Math.abs(alongM) / along)
    const lat = (x - o.x) * sd.x + (z - o.z) * sd.z
    const jf = (lat + left) / across
    const j0 = Math.floor(jf), j1 = Math.min(nL - 1, j0 + 1)
    if (j0 < 0 || j0 >= nL) return null
    const fj = jf - j0
    const h = (i: number) => heights[i * nL + j0] * (1 - fj) + heights[i * nL + j1] * fj
    const v = h(bi) * (1 - fa) + h(bj) * fa
    return Number.isNaN(v) ? null : v
  }
  return {
    mesh,
    heightAt,
    setTint: (c: THREE.Color, ground: THREE.Color) => {
      uniforms.grassTint.value.copy(c)
      mat.color.copy(ground)
    },
  }
}

/** Sink coarse-terrain vertices that lie under the strip so nothing pokes through it. */
export function sinkUnderStrip(geo: THREE.BufferGeometry, inside: (x: number, z: number) => number | null, margin = 3, depth = 2.5) {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const h = inside(pos.getX(i), pos.getZ(i))
    if (h === null) continue
    // h is the strip height here; the rim (margin) is left to the strip's own DEM blend
    pos.setY(i, Math.min(pos.getY(i), h) - depth)
  }
  void margin
  pos.needsUpdate = true
  geo.computeVertexNormals()
}
