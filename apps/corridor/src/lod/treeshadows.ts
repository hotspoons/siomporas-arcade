// Shadows for the trees the near set is not drawing.
//
// The models cast on their own. Past them — and everywhere, when tree detail is cards or
// lollipops and the models are hidden — either the impostor card or an invisible crown casts.
// Both are a few hundred instances past the models, out to their own reach, not the whole
// forest. A caster on a tree the near set is already drawing would stack a second shadow on it.
//
// The crown is drawn with colour and depth writes off, so it never appears, and the shadow
// pass still rasterises it. A card uses the baked atlas, stood up toward the sun and laid flat
// when the sun is high, or a noon shadow would be the thin edge of a vertical quad.
import * as THREE from 'three'
import type { Impostors } from './impostors'
import { leafShadowDepth } from '../visuals/shading'
import * as T from '../tuning'
import type { NearTrees, TreeRecord } from '../world/trees'

const CAP = 480

function crownTexture(): THREE.Texture {
  const S = 64
  const cv = document.createElement('canvas')
  cv.width = S
  cv.height = S
  const g = cv.getContext('2d')!
  g.clearRect(0, 0, S, S)
  const grd = g.createRadialGradient(S * 0.5, S * 0.42, S * 0.05, S * 0.5, S * 0.48, S * 0.48)
  grd.addColorStop(0, 'rgba(255,255,255,1)')
  grd.addColorStop(0.55, 'rgba(255,255,255,0.85)')
  grd.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grd
  g.beginPath()
  g.ellipse(S * 0.5, S * 0.46, S * 0.36, S * 0.42, 0, 0, Math.PI * 2)
  g.fill()
  g.fillStyle = 'rgba(255,255,255,0.9)'
  g.fillRect(S * 0.46, S * 0.62, S * 0.08, S * 0.36)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.NoColorSpace
  return tex
}

function crossGeo(): THREE.BufferGeometry {
  const one = (yaw: number) => {
    const g = new THREE.PlaneGeometry(0.7, 1)
    g.translate(0, 0.5, 0)
    g.rotateY(yaw)
    return g
  }
  const a = one(0)
  const b = one(Math.PI / 2)
  const pa = a.getAttribute('position')
  const pb = b.getAttribute('position')
  const ua = a.getAttribute('uv')
  const ub = b.getAttribute('uv')
  const pos = new Float32Array((pa.count + pb.count) * 3)
  const uv = new Float32Array((ua.count + ub.count) * 2)
  pos.set(pa.array as Float32Array, 0)
  pos.set(pb.array as Float32Array, pa.count * 3)
  uv.set(ua.array as Float32Array, 0)
  uv.set(ub.array as Float32Array, ua.count * 2)
  const ia = a.getIndex()!
  const ib = b.getIndex()!
  const idx = new Uint16Array(ia.count + ib.count)
  idx.set(ia.array as Uint16Array, 0)
  for (let i = 0; i < ib.count; i++) idx[ia.count + i] = (ib.getX(i) as number) + pa.count
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geo.setIndex(new THREE.BufferAttribute(idx, 1))
  return geo
}

const CARD_VERT = /* glsl */ `
  attribute float aVariant;
  attribute float aYaw;
  uniform vec3 uSun;
  uniform float cols;
  uniform float yaws;
  uniform float rows;
  varying vec2 vUv;
  void main() {
    vec4 origin = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float s = length(vec3(instanceMatrix[0].x, instanceMatrix[0].y, instanceMatrix[0].z));
    vec3 toSun = normalize(uSun);
    vec3 side = cross(vec3(0.0, 1.0, 0.0), toSun);
    if (dot(side, side) < 1e-4) side = vec3(1.0, 0.0, 0.0);
    side = normalize(side);
    float high = smoothstep(0.4, 0.8, toSun.y);
    vec3 upright = origin.xyz + side * position.x * s + vec3(0.0, position.y * s, 0.0);
    vec3 laid = origin.xyz + vec3(0.0, s * 0.55, 0.0) + vec3(position.x * s, 0.0, (position.y - 0.5) * s);
    vec4 mv = viewMatrix * vec4(mix(upright, laid, high), 1.0);
    float ang = atan(toSun.x, toSun.z);
    float k = mix(mod(floor((ang - aYaw) / 6.2831853 * yaws + 0.5), yaws), yaws, high);
    vUv = vec2((k + uv.x) / cols, (aVariant + uv.y) / rows);
    gl_Position = projectionMatrix * mv;
  }
`

const CARD_FRAG = /* glsl */ `
  uniform sampler2D atlas;
  varying vec2 vUv;
  void main() {
    if (texture2D(atlas, vUv).a < 0.45) discard;
    gl_FragColor = vec4(1.0);
  }
`

export class TreeShadowCasters {
  readonly group = new THREE.Group()
  private readonly cards: THREE.InstancedMesh
  private readonly canopy: THREE.InstancedMesh
  private readonly aVariant: THREE.InstancedBufferAttribute
  private readonly aYaw: THREE.InstancedBufferAttribute
  private readonly sun = new THREE.Vector3(0, 1, 0)
  private readonly sunUniform = { value: new THREE.Vector3(0, 1, 0) }
  private readonly last = new THREE.Vector3(Infinity, Infinity, Infinity)
  private readonly lastFwd = new THREE.Vector3(0, 0, -1)
  private sig = ''
  private readonly m = new THREE.Matrix4()
  private readonly imp: Impostors

  constructor(imp: Impostors) {
    this.imp = imp
    const cardGeo = new THREE.PlaneGeometry(1, 1)
    cardGeo.translate(0, 0.5, 0)
    this.aVariant = new THREE.InstancedBufferAttribute(new Float32Array(CAP), 1)
    this.aYaw = new THREE.InstancedBufferAttribute(new Float32Array(CAP), 1)
    cardGeo.setAttribute('aVariant', this.aVariant)
    cardGeo.setAttribute('aYaw', this.aYaw)
    const rows = imp.rows
    const depth = new THREE.ShaderMaterial({
      uniforms: { atlas: { value: imp.atlas }, uSun: this.sunUniform, cols: { value: 9 }, yaws: { value: 8 }, rows: { value: rows } },
      vertexShader: CARD_VERT,
      fragmentShader: CARD_FRAG,
      side: THREE.DoubleSide,
    })
    // FrontSide on this material is flipped to BackSide for the shadow pass, which culls the
    // flat noon card — the shadow camera is looking down at it. DoubleSide is what gets copied.
    const hidden = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, shadowSide: THREE.DoubleSide })
    this.cards = new THREE.InstancedMesh(cardGeo, hidden, CAP)
    this.cards.name = 'tree-shadow-cards'
    this.cards.count = 0
    this.cards.frustumCulled = false
    this.cards.castShadow = true
    this.cards.customDepthMaterial = depth
    this.cards.userData.ownDepth = true

    const tex = crownTexture()
    const canopyMat = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.35, colorWrite: false, depthWrite: false, side: THREE.DoubleSide, shadowSide: THREE.DoubleSide })
    this.canopy = new THREE.InstancedMesh(crossGeo(), canopyMat, CAP)
    this.canopy.name = 'tree-shadow-canopy'
    this.canopy.count = 0
    this.canopy.frustumCulled = false
    this.canopy.castShadow = true
    this.canopy.customDepthMaterial = leafShadowDepth(tex, 0.35)
    this.canopy.userData.ownDepth = true

    this.group.name = 'tree-shadows'
    this.group.add(this.cards, this.canopy)
  }

  setSun(dir: THREE.Vector3) {
    if (dir.lengthSq() < 1e-6) return
    this.sun.copy(dir).normalize()
    this.sunUniform.value.copy(this.sun)
  }

  /** Refill the casters when the eye, the view, the near set, or a knob moved. */
  update(near: NearTrees, records: TreeRecord[], eye: THREE.Vector3, force: boolean, fwd?: THREE.Vector3) {
    this.sunUniform.value.copy(this.sun)
    const canopy = T.SHADOW_CANOPY >= 0.5
    const cards = !canopy && T.SHADOW_CARDS >= 0.5
    const reach = canopy ? T.SHADOW_CANOPY_REACH : T.SHADOW_REACH
    const sig = `${canopy ? 1 : 0}|${cards ? 1 : 0}|${reach}|${T.SHADOW_CANOPY_SCALE}|${T.SHADOW > 0.02 ? 1 : 0}`
    const fx = fwd && Math.hypot(fwd.x, fwd.z) > 1e-4 ? fwd.x : this.lastFwd.x
    const fz = fwd && Math.hypot(fwd.x, fwd.z) > 1e-4 ? fwd.z : this.lastFwd.z
    const fl = Math.hypot(fx, fz) || 1
    const ux = fx / fl
    const uz = fz / fl
    const turned = this.lastFwd.x * ux + this.lastFwd.z * uz < 0.94
    // An empty fill latched before the ring had trees, and the toggle then looked dead: the
    // next frames bailed until the car moved. Keep asking until a caster actually exists.
    const waiting = (cards || canopy) && T.SHADOW > 0.02 && reach > near.horizon && this.cards.count === 0 && this.canopy.count === 0
    if (!force && sig === this.sig && !waiting && !turned && this.last.distanceTo(eye) < 8) return
    this.sig = sig
    this.last.copy(eye)
    this.lastFwd.set(ux, 0, uz)
    if (T.SHADOW <= 0.02 || (!canopy && !cards)) {
      this.cards.count = 0
      this.canopy.count = 0
      return
    }
    // The models already cast. Extra casters start at the far edge of that set, so a crown is
    // never standing on a tree that has a mesh.
    const minDist = near.group.visible && near.horizon > 1 ? near.horizon : 0
    const ids = near.shadowAhead(eye, ux, uz, minDist, reach, CAP)
    const mesh = canopy ? this.canopy : this.cards
    const other = canopy ? this.cards : this.canopy
    other.count = 0
    let n = 0
    for (const i of ids) {
      const r = records[i]
      if (!r) continue
      const variant = this.imp.variantAt(i)
      const s = canopy ? Math.max(1, r.h) * T.SHADOW_CANOPY_SCALE : Math.max(1, r.h) * this.imp.extentAt(variant)
      this.m.makeScale(s, s, s)
      this.m.setPosition(r.x, r.y, r.z)
      mesh.setMatrixAt(n, this.m)
      if (!canopy) {
        this.aVariant.setX(n, variant)
        this.aYaw.setX(n, this.imp.yawAt(i))
      }
      n++
    }
    mesh.count = n
    mesh.instanceMatrix.needsUpdate = true
    if (!canopy) {
      this.aVariant.needsUpdate = true
      this.aYaw.needsUpdate = true
    }
  }
}
