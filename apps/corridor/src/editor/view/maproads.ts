// The map layer of the place editor: every road as a legible line, and its name.
//
// Rich, 2026-10-10: *"No details are visible with the tile-based renderer … We need to make sure we
// have major roads listed at high level overview zooms, and then have overlays showing secondary
// roads when zoomed in at z14 level. Need road labels too."*
//
// WHY NOTHING WAS LEGIBLE. At dc-metro-take-2's 40 km the editor showed the 11.7 m/px NAIP overview
// through a 70 % haze (the season's fog at that range), and the only road drawn was the spine's
// 1 px centreline: the branch network of a tiled world streams in 1 km vector tiles only around
// the start, because the editor never moves the game's eye. A road on a photograph at 20 m a pixel
// is three grey pixels. So the roads are drawn as a map draws them — a screen-width line with a
// dark casing, the same few pixels wide at every zoom — over the ground, not as asphalt in it.
//
// THE DATA is the bake's own: `context.json`, every road with its class and name, which the game's
// minimap already reads (parsed and projected in maproads.worker.ts). A world baked before it falls
// back to what its manifest holds — the spine and every resident branch, with their lidar heights —
// and a tiled world with no context.json takes its branches from the vector tiles the site already
// streams (`loadVectorTile`, the same LRU cache), around the view, once it is zoomed in.
//
// THE COST IS BOUNDED BY CONSTRUCTION. Every segment is a four-vertex quad expanded to its screen
// width in the vertex shader; the major roads are ONE merged bucket for the whole world (≈42 k
// segments on dc-metro), the rest are 4 km cells built the first time they are in view at their
// zoom and dropped least-recently-seen past a segment cap. Two draws a bucket (casing, then fill).
// Labels are capped per frame and only re-laid out while the camera moves.
//
// NOT INSTANCED, measured. The first cut drew each segment as an instance of one quad, which is
// the textbook way and costs nothing on a GPU — and on SwiftShader cost ~20 µs PER INSTANCE: the
// 2 × 42 k-instance overview took 1.7 s a frame, the same with the lines 0.05 px wide and a tenth of
// that with a tenth of the instances (2026-10-10, headless dc-metro). Plain triangles with the
// segment's two ends repeated on its four vertices cost a little memory (136 B a segment) and draw
// at the speed of any other mesh.
//
// A LINE THAT STAYS ON TOP OF THE GROUND without z-fighting it: each vertex is pulled toward the
// eye along its own view ray — its pixel does not move, only its depth — by 1.2 % of its distance
// (2.5 m at least). The terrain under a 40 km view is a coarse mesh that rises and falls metres
// against the DEM the line's heights came from; the pull outruns that, and still lets a real hill
// in front hide the road behind it.
import * as THREE from 'three'
import { DATA_BASE, loadVectorTile, type Manifest } from '../../world/site'
import type { Site } from '../../world/scene'
import { bucketRoads, ROAD_STYLES, type Bucket, type RoadLine } from './maproads.data'
import { layoutLabels, readableAngle, type LabelCand } from './maplabels'

/** metres per CSS pixel at or below which each tier is drawn (tier 1 is "z14": ≤ 10 m a pixel) */
export const TIER_MPP = [Infinity, 10, 2.5]
/** the side of a tier-1/2 cell, metres */
const CELL_M = 4000
/** tier-1/2 segments kept on the GPU (136 B each), least recently seen buckets dropped past this */
const MAX_SEGMENTS = 450_000
/** main-thread budget for building buckets, ms a frame */
const BUILD_MS = 4
/** label candidates examined a frame, at most */
const MAX_CANDS = 6000

interface Built {
  b: Bucket
  names: string[]
  box: THREE.Box3
  /** labels' heights, sampled with the segments' */
  lz: Float32Array | null
  geo: THREE.BufferGeometry | null
  casing: THREE.Mesh | null
  fill: THREE.Mesh | null
  /** how far the height sampling has got (vertices) */
  zDone: number
  z: Float32Array | null
  seen: number
}

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aA;
attribute vec3 aB;
// style · 4 + corner: corner bit 0 is the end (A or B), bit 1 the side
attribute float aC;
uniform vec2 uRes;
uniform float uPx;
uniform float uNear;
uniform float uCasing;
uniform vec3 uColor[${ROAD_STYLES.length}];
uniform float uWidth[${ROAD_STYLES.length}];
uniform vec3 uCasingColor;
uniform float uOpacity;
varying vec4 vColor;
vec4 lifted(vec3 p) {
  vec4 v = modelViewMatrix * vec4(p, 1.0);
  float len = max(length(v.xyz), 1e-3);
  // toward the eye along its own ray: same pixel, nearer depth
  v.xyz *= 1.0 - min(0.5, max(2.5 / len, 0.012));
  return v;
}
void main() {
  float sf = floor(aC / 4.0 + 0.01);
  int s = int(sf);
  float corner = aC - sf * 4.0;
  bool isB = mod(corner, 2.0) > 0.5;
  float side = corner > 1.5 ? 1.0 : -1.0;
  vec4 a = lifted(aA);
  vec4 b = lifted(aB);
  // clip the segment to the near plane, or drop it when it is wholly behind
  float zn = -uNear * 1.001;
  if (a.z > zn && b.z > zn) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vColor = vec4(0.0); return; }
  if (a.z > zn) a = mix(a, b, (zn - a.z) / (b.z - a.z));
  if (b.z > zn) b = mix(b, a, (zn - b.z) / (a.z - b.z));
  vec4 ca = projectionMatrix * a;
  vec4 cb = projectionMatrix * b;
  vec2 sa = ca.xy / ca.w * 0.5 * uRes;
  vec2 sb = cb.xy / cb.w * 0.5 * uRes;
  vec2 d = sb - sa;
  float L = length(d);
  vec2 dir = L > 1e-4 ? d / L : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float hw = (uWidth[s] * 0.5 + uCasing) * uPx;
  vec4 c = isB ? cb : ca;
  vec2 off = nrm * side * hw + dir * (isB ? hw : -hw);
  c.xy += off / (0.5 * uRes) * c.w;
  gl_Position = c;
  #include <logdepthbuf_vertex>
  vColor = vec4(uCasing > 0.0 ? uCasingColor : uColor[s], uCasing > 0.0 ? 0.85 * uOpacity : uOpacity);
}
`
const FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
varying vec4 vColor;
void main() {
  #include <logdepthbuf_fragment>
  if (vColor.a <= 0.0) discard;
  gl_FragColor = vColor;
}
`

/** CSS hex → the raw sRGB triple, unconverted: this shader writes straight to the canvas */
const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

export interface RoadMapHost {
  camera: THREE.PerspectiveCamera
  canvas: HTMLCanvasElement
  renderer: THREE.WebGLRenderer
}

export class RoadMap {
  /** add to the scene; marked as an overlay, so the preview stands it down */
  readonly group = new THREE.Group()
  roadsOn = true
  labelsOn = true
  /** for probes and the report: what came from where, and what it cost */
  readonly stats = { source: 'none' as 'none' | 'context' | 'manifest' | 'tiles', roads: 0, buckets: 0, built: 0, segments: 0, workerMs: 0, firstMajorAt: 0, firstMajorPageMs: 0, labels: 0, cands: 0, layoutMs: 0, buildMs: 0, vtCells: 0 }
  private host: RoadMapHost
  private built: Built[] = []
  private queue = new Set<Built>()
  private site: Site | null = null
  private manifest: Manifest | null = null
  private gen = 0
  private worker: Worker | null = null
  private pending: { names: string[]; buckets: Bucket[] } | null = null
  private loadT0 = 0
  private matCasing: THREE.ShaderMaterial
  private matFill: THREE.ShaderMaterial
  private uniforms: Record<string, THREE.IUniform>
  private frustum = new THREE.Frustum()
  private pv = new THREE.Matrix4()
  private frame = 0
  private labelCanvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private widths = new Map<string, number>()
  private labelsDirty = true
  private shown = true
  private font = 'IBM Plex Sans, system-ui, sans-serif'
  /** tiled worlds with no context.json: which vector tiles' branches have been taken */
  private vtTaken = new Set<string>()
  private vtBusy = 0

  constructor(host: RoadMapHost) {
    this.host = host
    this.group.name = 'map:roads'
    this.uniforms = {
      uRes: { value: new THREE.Vector2(1, 1) },
      uPx: { value: 1 },
      uNear: { value: 1 },
      uCasing: { value: 0 },
      uColor: { value: ROAD_STYLES.map((s) => rgb(s.colour)) },
      uWidth: { value: ROAD_STYLES.map((s) => s.width) },
      uCasingColor: { value: rgb('#14171c') },
      uOpacity: { value: 1 },
    }
    const mat = (casing: boolean) => new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { ...this.uniforms, uCasing: { value: casing ? 1.25 : 0 } },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: false,
    })
    this.matCasing = mat(true)
    this.matFill = mat(false)
    const lc = document.createElement('canvas')
    lc.className = 'map-labels'
    lc.style.cssText = 'position:fixed;pointer-events:none;left:0;top:0;width:0;height:0'
    host.canvas.after(lc)
    this.labelCanvas = lc
    this.ctx = lc.getContext('2d')!
    try {
      const ff = getComputedStyle(document.body).fontFamily
      if (ff) this.font = ff
    } catch { /* keep the default */ }
  }

  /**
   * Start reading the roads for a world as soon as its manifest is known — in parallel with the
   * site build, which is the long pole (22 s on dc-metro, headless) — so they are ready when it is.
   */
  prefetch(manifest: Manifest): void {
    this.clear()
    const gen = ++this.gen
    this.manifest = manifest
    this.loadT0 = performance.now()
    if (!manifest.frame) { this.fallback(gen); return }
    this.worker ??= new Worker(new URL('./maproads.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (ev) => {
      if (gen !== this.gen) return
      const m = ev.data as { type: string; names?: string[]; buckets?: Bucket[]; ms?: number; roads?: number; message?: string }
      if (m.type === 'buckets') {
        this.stats.source = 'context'
        this.stats.workerMs = Math.round(m.ms ?? 0)
        this.stats.roads = m.roads ?? 0
        this.take(m.names!, m.buckets!)
      } else {
        if (m.type === 'error') console.warn('[map] roads worker:', m.message)
        this.fallback(gen)
      }
    }
    this.worker.postMessage({
      type: 'load',
      url: new URL(`${DATA_BASE}/sites/${manifest.slug}/context.json`, location.href).href,
      frame: manifest.frame,
      cell: CELL_M,
    })
  }

  /** the site is built: heights can be sampled and buckets built */
  attach(site: Site): void {
    this.site = site
    if (this.pending) {
      const p = this.pending
      this.pending = null
      this.take(p.names, p.buckets)
    }
  }

  /** drop everything (a new world) */
  clear(): void {
    for (const b of this.built) this.unbuild(b)
    this.built = []
    this.queue.clear()
    this.pending = null
    this.site = null
    this.vtTaken.clear()
    this.stats.buckets = this.stats.built = this.stats.segments = 0
    this.stats.firstMajorAt = 0
    this.stats.firstMajorPageMs = 0
    this.stats.source = 'none'
    this.labelsDirty = true
  }

  /** the label canvas follows the editor: hidden with it, and under the preview */
  setShown(on: boolean): void {
    this.shown = on
    if (!on) this.labelCanvas.style.display = 'none'
  }

  private take(names: string[], buckets: Bucket[]) {
    if (!this.site) {
      // the site is still building; hold them
      if (this.pending) { this.pending.buckets.push(...buckets); return }
      this.pending = { names, buckets }
      return
    }
    for (const b of buckets) {
      const box = new THREE.Box3(new THREE.Vector3(b.bbox[0], -500, -b.bbox[3]), new THREE.Vector3(b.bbox[2], 4000, -b.bbox[1]))
      const e: Built = { b, names, box, lz: null, geo: null, casing: null, fill: null, zDone: 0, z: null, seen: 0 }
      this.built.push(e)
      if (b.tier === 0) this.queue.add(e) // the major roads are wanted at once, wherever the camera is
    }
    // the major roads first, then by tier
    this.built.sort((a, b) => a.b.tier - b.b.tier)
    this.stats.buckets = this.built.length
    this.labelsDirty = true
  }

  /** No context.json: the spine and the manifest's resident branches, which carry their own heights. */
  private fallback(gen: number) {
    if (gen !== this.gen || !this.manifest) return
    const m = this.manifest
    const lines: RoadLine[] = []
    const sp = m.spine
    if (sp?.coords?.length > 1) {
      // the spine's class and name are its longest segment's
      const byLen = new Map<string, { len: number; name: string | null; cls: string }>()
      for (const s of sp.segments ?? []) {
        const cls = s.tags?.highway ?? 'primary'
        const name = s.tags?.name ?? s.tags?.ref ?? null
        const k = `${cls}|${name}`
        const cur = byLen.get(k) ?? { len: 0, name, cls }
        cur.len += s.s_end - s.s_start
        byLen.set(k, cur)
      }
      const top = [...byLen.values()].sort((a, b) => b.len - a.len)[0]
      lines.push(lineOf(sp.coords, top?.cls ?? 'primary', top?.name ?? null))
    }
    for (const br of m.branches ?? []) {
      if (br.coords?.length > 1) lines.push(lineOf(br.coords, br.highway ?? 'residential', br.name ?? br.ref ?? null))
    }
    for (const st of m.stubs ?? []) {
      if (st.coords?.length > 1) lines.push(lineOf(st.coords, st.highway, st.name ?? null))
    }
    this.stats.source = m.vt?.branch?.length ? 'tiles' : 'manifest'
    this.stats.roads = lines.length
    const out = bucketRoads(lines, CELL_M, 'm:')
    this.take(out.names, out.buckets)
  }

  /** A tiled world with no context.json: take the branches of the vector tiles around the view. */
  private streamTiles(cx: number, cy: number, radius: number) {
    const vt = this.manifest?.vt
    if (!vt?.branch?.length || !vt.dir || this.stats.source !== 'tiles' || this.vtBusy >= 2) return
    const size = vt.size_m || 1000
    const want = vt.branch
      .filter((t) => !this.vtTaken.has(`${t.x},${t.y}`))
      .map((t) => ({ t, d: Math.hypot((t.x + 0.5) * size - cx, (t.y + 0.5) * size - cy) }))
      .filter((w) => w.d < radius)
      .sort((a, b) => a.d - b.d)
      .slice(0, 2 - this.vtBusy)
    const gen = this.gen
    const slug = this.manifest!.slug
    for (const { t } of want) {
      this.vtTaken.add(`${t.x},${t.y}`)
      this.vtBusy++
      void loadVectorTile(slug, vt.dir, t.x, t.y).then((files) => {
        this.vtBusy--
        if (gen !== this.gen) return
        const lines: RoadLine[] = []
        for (const br of (files.branches ?? []) as NonNullable<Manifest['branches']>) {
          if (br.coords?.length > 1) lines.push(lineOf(br.coords, br.highway ?? 'residential', br.name ?? br.ref ?? null))
        }
        // one bucket per tile: these are already 1 km cells
        const out = bucketRoads(lines, 1e9, `vt${t.x},${t.y}:`)
        for (const b of out.buckets) if (b.tier === 0) b.tier = 1 // a tile's major roads arrive with the zoom that fetched them
        this.stats.vtCells++
        this.take(out.names, out.buckets)
      }).catch(() => { this.vtBusy-- })
    }
  }

  // -------------------------------------------------------------------------------------------
  // building a bucket: heights, then the instance buffers

  /** Sample heights for up to `budgetMs`; true when the bucket is ready to upload. */
  private sample(e: Built, until: number): boolean {
    const b = e.b
    const n = b.xy.length / 2
    if (b.hasZ) {
      e.z = b.z
      e.zDone = n
    }
    if (!e.z) e.z = new Float32Array(n)
    const h = this.site!.heightAt
    const z = e.z
    let i = e.zDone
    for (; i < n; i++) {
      const v = h(b.xy[i * 2], b.xy[i * 2 + 1])
      z[i] = Number.isFinite(v) ? v : 0
      if ((i & 1023) === 1023 && performance.now() > until) { i++; break }
    }
    e.zDone = i
    if (i < n) return false
    if (!e.lz) {
      const L = b.labels
      e.lz = new Float32Array(L.x.length)
      for (let k = 0; k < L.x.length; k++) {
        const v = h(L.x[k], L.y[k])
        e.lz[k] = Number.isFinite(v) ? v : 0
      }
    }
    return true
  }

  private upload(e: Built) {
    const b = e.b
    const nSeg = b.segs.length / 2
    let zmin = Infinity, zmax = -Infinity
    for (let i = 0; i < e.z!.length; i++) { const v = e.z![i]; if (v < zmin) zmin = v; if (v > zmax) zmax = v }
    for (let i = 0; i < (e.lz?.length ?? 0); i++) { const v = e.lz![i]; if (v < zmin) zmin = v; if (v > zmax) zmax = v }
    if (!Number.isFinite(zmin)) { zmin = 0; zmax = 0 }
    e.box.min.y = zmin - 30
    e.box.max.y = zmax + 30
    if (!nSeg) return // a label-only bucket
    // four vertices a segment, each carrying both ends: the shader puts each corner on screen
    const A = new Float32Array(nSeg * 12)
    const B = new Float32Array(nSeg * 12)
    const C = new Float32Array(nSeg * 4)
    const idx = nSeg * 4 > 65535 ? new Uint32Array(nSeg * 6) : new Uint16Array(nSeg * 6)
    const z = e.z!
    for (let k = 0; k < nSeg; k++) {
      const i = b.segs[k * 2], j = b.segs[k * 2 + 1]
      const ax = b.xy[i * 2], ay = z[i], az = -b.xy[i * 2 + 1]
      const bx = b.xy[j * 2], by = z[j], bz = -b.xy[j * 2 + 1]
      const st = b.style[k] * 4
      for (let c = 0; c < 4; c++) {
        const v = (k * 4 + c) * 3
        A[v] = ax; A[v + 1] = ay; A[v + 2] = az
        B[v] = bx; B[v + 1] = by; B[v + 2] = bz
        C[k * 4 + c] = st + c
      }
      const v0 = k * 4, o = k * 6
      // corners: 0 A−, 1 B−, 2 A+, 3 B+
      idx[o] = v0; idx[o + 1] = v0 + 1; idx[o + 2] = v0 + 2
      idx[o + 3] = v0 + 2; idx[o + 4] = v0 + 1; idx[o + 5] = v0 + 3
    }
    const geo = new THREE.BufferGeometry()
    // `position` is what three counts vertices by; the shader reads aA/aB/aC
    geo.setAttribute('position', new THREE.BufferAttribute(A, 3))
    geo.setAttribute('aA', geo.getAttribute('position'))
    geo.setAttribute('aB', new THREE.BufferAttribute(B, 3))
    geo.setAttribute('aC', new THREE.BufferAttribute(C, 1))
    geo.setIndex(new THREE.BufferAttribute(idx, 1))
    geo.boundingBox = e.box.clone()
    geo.boundingSphere = e.box.getBoundingSphere(new THREE.Sphere())
    const order = 20 + (2 - b.tier) * 2
    const casing = new THREE.Mesh(geo, this.matCasing)
    const fill = new THREE.Mesh(geo, this.matFill)
    casing.renderOrder = order
    fill.renderOrder = order + 1
    casing.name = `map:${b.key}:casing`
    fill.name = `map:${b.key}`
    this.group.add(casing, fill)
    e.geo = geo
    e.casing = casing
    e.fill = fill
    this.stats.built++
    this.stats.segments += nSeg
    if (b.tier === 0 && !this.stats.firstMajorAt) {
      this.stats.firstMajorAt = Math.round(performance.now() - this.loadT0)
      this.stats.firstMajorPageMs = Math.round(performance.now())
    }
  }

  private unbuild(e: Built) {
    if (e.casing) this.group.remove(e.casing)
    if (e.fill) this.group.remove(e.fill)
    if (e.geo) {
      e.geo.dispose()
      this.stats.built--
      this.stats.segments -= e.b.segs.length / 2
    }
    e.geo = e.casing = e.fill = null
    e.z = null
    e.zDone = 0
  }

  private isBuilt(e: Built) {
    return !!e.lz && (!!e.geo || e.b.segs.length === 0)
  }

  // -------------------------------------------------------------------------------------------
  // the frame

  /**
   * Once a frame: which buckets are wanted, build some, set the uniforms, and lay the labels out
   * when the camera moved. `mpp` is ground metres per CSS pixel at the look-at point; `focus` is
   * the look-at point in the site frame.
   */
  update(mpp: number, focus: { x: number; y: number }, moving: boolean): void {
    this.frame++
    const cam = this.host.camera
    const r = this.host.renderer
    const size = r.getDrawingBufferSize(new THREE.Vector2())
    this.uniforms.uRes.value.set(size.x, size.y)
    this.uniforms.uPx.value = r.getPixelRatio()
    this.uniforms.uNear.value = cam.near
    // a road is a line on the map until the photograph shows the road itself; then the line steps
    // back so the asphalt, the paint and what you are placing on it read through
    this.uniforms.uOpacity.value = THREE.MathUtils.clamp((mpp - 0.12) / (0.7 - 0.12), 0.3, 1)
    for (const m of [this.matCasing, this.matFill]) {
      m.uniforms.uRes.value = this.uniforms.uRes.value
      m.uniforms.uPx.value = this.uniforms.uPx.value
      m.uniforms.uNear.value = this.uniforms.uNear.value
      m.uniforms.uOpacity.value = this.uniforms.uOpacity.value
    }
    cam.updateMatrixWorld()
    this.pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    this.frustum.setFromProjectionMatrix(this.pv)
    const tierOn = TIER_MPP.map((t) => mpp <= t)
    if (tierOn[1]) this.streamTiles(focus.x, focus.y, Math.max(1500, mpp * 1200))

    // ---- visibility, and what to build
    let builtMinor = 0
    for (const e of this.built) {
      const want = this.roadsOn && tierOn[e.b.tier] && this.frustum.intersectsBox(e.box)
      if (want) {
        e.seen = this.frame
        if (!this.isBuilt(e)) this.queue.add(e)
      }
      if (e.casing) e.casing.visible = want
      if (e.fill) e.fill.visible = want
      if (e.geo && e.b.tier > 0) builtMinor += e.b.segs.length / 2
    }
    // ---- build, nearest first, inside the budget
    if (this.queue.size && this.site) {
      const t0 = performance.now()
      const until = t0 + BUILD_MS
      const list = [...this.queue].sort((a, b) => a.b.tier - b.b.tier || dist2(a, focus) - dist2(b, focus))
      for (const e of list) {
        if (performance.now() > until && e.b.tier > 0) break
        if (e.b.tier > 0 && e.seen !== this.frame) { this.queue.delete(e); continue } // no longer wanted
        // the major roads are finished in one go, whatever it costs: they are the overview
        if (!this.sample(e, e.b.tier === 0 ? Infinity : until)) break
        this.upload(e)
        this.queue.delete(e)
        this.labelsDirty = true
        if (e.casing) e.casing.visible = e.fill!.visible = this.roadsOn && tierOn[e.b.tier]
      }
      this.stats.buildMs = +(performance.now() - t0).toFixed(1)
    }
    // ---- keep the GPU set bounded
    if (builtMinor > MAX_SEGMENTS) {
      const old = this.built.filter((e) => e.geo && e.b.tier > 0 && e.seen !== this.frame).sort((a, b) => a.seen - b.seen)
      for (const e of old) {
        if (builtMinor <= MAX_SEGMENTS) break
        builtMinor -= e.b.segs.length / 2
        this.unbuild(e)
        e.lz = null
      }
    }
    // ---- labels
    this.placeLabels(mpp, tierOn, moving)
  }

  private placeLabels(mpp: number, tierOn: boolean[], moving: boolean) {
    const lc = this.labelCanvas
    const gl = this.host.canvas
    if (!this.shown || !this.labelsOn || gl.hidden) {
      lc.style.display = 'none'
      this.stats.labels = 0
      return
    }
    lc.style.display = ''
    const rect = gl.getBoundingClientRect()
    const dpr = Math.min(2, devicePixelRatio || 1)
    const W = Math.round(rect.width), H = Math.round(rect.height)
    const resized = lc.width !== Math.round(W * dpr) || lc.height !== Math.round(H * dpr) || lc.style.left !== `${rect.left}px` || lc.style.top !== `${rect.top}px`
    if (resized) {
      lc.style.left = `${rect.left}px`
      lc.style.top = `${rect.top}px`
      lc.style.width = `${W}px`
      lc.style.height = `${H}px`
      lc.width = Math.round(W * dpr)
      lc.height = Math.round(H * dpr)
    }
    // lay out only while the view changes, or when new roads arrived
    if (!moving && !this.labelsDirty && !resized) return
    this.labelsDirty = false
    const t0 = performance.now()
    const cands: LabelCand[] = []
    const texts: string[] = []
    const fonts: string[] = []
    const e4 = this.pv.elements
    const cx = W / 2, cy = H / 2
    const ctx = this.ctx
    const L = Math.max(4, mpp * 30)
    const project = (x: number, y: number, z: number): [number, number] | null => {
      const X = x, Y = z, Z = -y
      const w = e4[3] * X + e4[7] * Y + e4[11] * Z + e4[15]
      if (w <= 1e-6) return null
      const nx = (e4[0] * X + e4[4] * Y + e4[8] * Z + e4[12]) / w
      const ny = (e4[1] * X + e4[5] * Y + e4[9] * Z + e4[13]) / w
      const nz = (e4[2] * X + e4[6] * Y + e4[10] * Z + e4[14]) / w
      if (nz < -1 || nz > 1) return null
      return [(nx * 0.5 + 0.5) * W, (-ny * 0.5 + 0.5) * H]
    }
    outer: for (const e of this.built) {
      if (!this.roadsOn || !tierOn[e.b.tier] || !e.lz || e.seen !== this.frame) continue
      const Lb = e.b.labels
      for (let k = 0; k < Lb.x.length; k++) {
        if (cands.length >= MAX_CANDS) break outer
        const rank = Lb.rank[k]
        const p = project(Lb.x[k], Lb.y[k], e.lz[k])
        if (!p || p[0] < -50 || p[1] < -50 || p[0] > W + 50 || p[1] > H + 50) continue
        const q = project(Lb.x[k] + Math.cos(Lb.ang[k]) * L, Lb.y[k] + Math.sin(Lb.ang[k]) * L, e.lz[k])
        const ang = q ? readableAngle(Math.atan2(q[1] - p[1], q[0] - p[0])) : 0
        const name = e.names[Lb.name[k]]
        const font = rank <= 2 ? `600 13px ${this.font}` : rank <= 4 ? `600 12px ${this.font}` : `500 11.5px ${this.font}`
        const wk = `${font}|${name}`
        let w = this.widths.get(wk)
        if (w === undefined) {
          ctx.font = font
          w = ctx.measureText(name).width
          this.widths.set(wk, w)
        }
        // the same name in two sources (or two buckets) is one name for spacing
        cands.push({ sx: p[0], sy: p[1], ang, w, h: rank <= 2 ? 15 : 14, name: hashName(name), rank, dist: Math.hypot(p[0] - cx, p[1] - cy) })
        texts.push(name)
        fonts.push(font)
      }
    }
    const max = mpp > TIER_MPP[1] ? 45 : mpp > TIER_MPP[2] ? 90 : 120
    const keep = layoutLabels(cands, { width: W, height: H, max, pad: 3, sameNamePx: (r) => (r <= 2 ? 380 : 260) })
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineJoin = 'round'
    for (const i of keep) {
      const c = cands[i]
      ctx.save()
      ctx.translate(c.sx, c.sy)
      ctx.rotate(c.ang)
      ctx.font = fonts[i]
      ctx.lineWidth = 3.5
      ctx.strokeStyle = 'rgba(12,14,18,0.85)'
      ctx.strokeText(texts[i], 0, 0)
      ctx.fillStyle = c.rank <= 1 ? '#ffe2a8' : '#ffffff'
      ctx.fillText(texts[i], 0, 0)
      ctx.restore()
    }
    this.stats.labels = keep.length
    this.stats.cands = cands.length
    this.stats.layoutMs = +(performance.now() - t0).toFixed(2)
  }

  /** which label names are on screen now — for probes: "a label is visible" must be a fact */
  visibleLabels(): number {
    return this.stats.labels
  }
}

const dist2 = (e: Built, f: { x: number; y: number }) => {
  const cx = (e.b.bbox[0] + e.b.bbox[2]) / 2, cy = (e.b.bbox[1] + e.b.bbox[3]) / 2
  return (cx - f.x) ** 2 + (cy - f.y) ** 2
}

const nameIds = new Map<string, number>()
const hashName = (s: string) => {
  let v = nameIds.get(s)
  if (v === undefined) nameIds.set(s, (v = nameIds.size))
  return v
}

function lineOf(coords: [number, number, number][] | [number, number][], cls: string, name: string | null): RoadLine {
  const n = coords.length
  const xy = new Float32Array(n * 2)
  const z = new Float32Array(n)
  let hasZ = true
  for (let i = 0; i < n; i++) {
    const c = coords[i] as number[]
    xy[i * 2] = c[0]
    xy[i * 2 + 1] = c[1]
    if (c.length > 2 && Number.isFinite(c[2])) z[i] = c[2]
    else hasZ = false
  }
  return { cls, name, xy, z: hasZ ? z : null }
}
