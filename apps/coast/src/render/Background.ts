// Sky + two parallax layers. Layers are procedural canvas textures (ridges,
// dunes, a city skyline, a sea horizon) so each theme reads differently
// without any downloaded art. They scroll with accumulated curve and bob with
// the camera's height.

import { CanvasTexture, LinearFilter, Mesh, NearestFilter, PlaneGeometry, RepeatWrapping, ShaderMaterial, Color } from 'three'
import type { Palette } from './RenderTuning'

const LAYER_W = 1024
const LAYER_H = 160

export class Background {
  readonly sky: Mesh
  readonly far: Mesh
  readonly near: Mesh
  readonly clouds: Mesh
  private readonly cloudMat: ShaderMaterial
  private cloudTex: CanvasTexture
  private cloudScroll = 0
  private readonly skyMat: ShaderMaterial
  private readonly farMat: ShaderMaterial
  private readonly nearMat: ShaderMaterial
  private farTex: CanvasTexture
  private nearTex: CanvasTexture
  private backdrop = ''

  constructor() {
    this.skyMat = new ShaderMaterial({
      uniforms: { uTop: { value: new Color() }, uBottom: { value: new Color() }, uSun: { value: new Color() }, uSunPos: { value: [0.7, 0.62] }, uNight: { value: 0 } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `precision highp float; varying vec2 vUv; uniform vec3 uTop, uBottom, uSun; uniform vec2 uSunPos; uniform float uNight;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        void main(){
          vec3 c = mix(uBottom, uTop, smoothstep(0.0, 1.0, vUv.y));
          float d = distance(vUv * vec2(1.6, 1.0), uSunPos * vec2(1.6, 1.0));
          float sunR = mix(0.05, 0.028, uNight);
          c += uSun * (smoothstep(sunR, sunR - 0.008, d) * mix(0.9, 0.55, uNight) + mix(0.25, 0.08, uNight) * smoothstep(0.25, 0.0, d));
          if (uNight > 0.5) { float s = step(0.997, hash(floor(vUv * vec2(320.0, 224.0)))); c += vec3(s) * 0.8; }
          gl_FragColor = vec4(c, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    })
    this.sky = new Mesh(new PlaneGeometry(1, 1), this.skyMat)
    this.sky.frustumCulled = false
    this.farTex = new CanvasTexture(document.createElement('canvas'))
    this.nearTex = new CanvasTexture(document.createElement('canvas'))
    const layerMat = (tex: CanvasTexture) =>
      new ShaderMaterial({
        uniforms: { tMap: { value: tex }, uScroll: { value: 0 }, uTint: { value: new Color(1, 1, 1) } },
        vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `precision highp float; varying vec2 vUv; uniform sampler2D tMap; uniform float uScroll; uniform vec3 uTint;
          void main(){ vec4 c = texture2D(tMap, vec2(fract(vUv.x + uScroll), vUv.y)); if (c.a < 0.5) discard; gl_FragColor = vec4(c.rgb * uTint, 1.0); }`,
        depthTest: false,
        depthWrite: false,
        transparent: true,
      })
    this.farMat = layerMat(this.farTex)
    this.nearMat = layerMat(this.nearTex)
    this.cloudTex = new CanvasTexture(document.createElement('canvas'))
    this.cloudMat = layerMat(this.cloudTex)
    this.clouds = new Mesh(new PlaneGeometry(1, 1), this.cloudMat)
    this.clouds.frustumCulled = false
    this.far = new Mesh(new PlaneGeometry(1, 1), this.farMat)
    this.near = new Mesh(new PlaneGeometry(1, 1), this.nearMat)
    this.far.frustumCulled = false
    this.near.frustumCulled = false
  }

  setPalette(p: Palette, backdrop: string, retro: boolean): void {
    ;(this.skyMat.uniforms.uTop.value as Color).set(p.skyTop)
    ;(this.skyMat.uniforms.uBottom.value as Color).set(p.skyBottom)
    ;(this.skyMat.uniforms.uSun.value as Color).set(p.sun)
    this.skyMat.uniforms.uNight.value = backdrop === 'city' ? 1 : 0
    if (backdrop !== this.backdrop) {
      this.backdrop = backdrop
      drawLayer(this.farTex, backdrop, 'far', p)
      drawLayer(this.nearTex, backdrop, 'near', p)
      drawClouds(this.cloudTex, p, backdrop === 'city')
    }
    for (const t of [this.farTex, this.nearTex, this.cloudTex]) {
      t.minFilter = t.magFilter = retro ? NearestFilter : LinearFilter
      t.wrapS = RepeatWrapping
      t.needsUpdate = true
    }
  }

  /** Lay out the layers for the logical screen; horizonY is where the road meets the sky. */
  layout(width: number, height: number, horizonY: number): void {
    this.sky.scale.set(width, height, 1)
    this.sky.position.set(width / 2, height / 2, 0)
    this.clouds.scale.set(width, height * 0.26, 1)
    this.clouds.position.set(width / 2, horizonY + height * 0.26 * 0.5 + 18, 0)
    const farH = height * 0.36
    this.far.scale.set(width, farH, 1)
    this.far.position.set(width / 2, horizonY + farH / 2 - 2, 0)
    const nearH = height * 0.22
    this.near.scale.set(width, nearH, 1)
    this.near.position.set(width / 2, horizonY + nearH / 2 - 4, 0)
  }

  updateClouds(dt: number, speed: number): void {
    this.cloudScroll += dt * (0.004 + speed * 0.00002)
    this.cloudMat.uniforms.uScroll.value = this.cloudScroll + this.farMat.uniforms.uScroll.value * 0.5
  }

  /** Scroll by accumulated curve; nudge with hill height. */
  update(curveAccum: number, hillY: number): void {
    this.farMat.uniforms.uScroll.value = curveAccum * 0.0006
    this.nearMat.uniforms.uScroll.value = curveAccum * 0.0014
    this.far.position.y += 0
    void hillY
  }
}

function drawLayer(tex: CanvasTexture, backdrop: string, layer: 'far' | 'near', p: Palette): void {
  const c = tex.image as HTMLCanvasElement
  c.width = LAYER_W
  c.height = LAYER_H
  const g = c.getContext('2d')!
  g.clearRect(0, 0, LAYER_W, LAYER_H)
  const col = new Color(layer === 'far' ? p.far : p.near)
  g.fillStyle = `#${col.getHexString()}`
  const seed = layer === 'far' ? 7 : 13
  const rnd = (i: number) => {
    const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453
    return x - Math.floor(x)
  }
  g.beginPath()
  g.moveTo(0, LAYER_H)
  const N = 64
  for (let i = 0; i <= N; i++) {
    const x = (i / N) * LAYER_W
    let h: number
    switch (backdrop) {
      case 'sea':
        h = layer === 'far' ? 18 + 30 * Math.pow(rnd(i % N), 2) * (i % 7 === 0 ? 2 : 1) : 12 + 6 * Math.sin(i * 0.9)
        break
      case 'mesas':
        h = layer === 'far' ? 40 + 50 * (rnd(Math.floor(i / 4) % N) > 0.5 ? 1 : 0.3) : 22 + 18 * (rnd((i * 3) % N) > 0.6 ? 1 : 0.2)
        break
      case 'dunes':
        h = layer === 'far' ? 16 + 14 * (0.5 + 0.5 * Math.sin(i * 0.4 + 1)) : 10 + 10 * (0.5 + 0.5 * Math.sin(i * 0.7))
        break
      case 'city':
        h = layer === 'far' ? 30 + 90 * Math.pow(rnd(Math.floor(i / 2) % N), 1.6) : 15 + 40 * rnd((i * 5) % N)
        break
      case 'peaks':
        h = layer === 'far' ? 40 + 95 * Math.pow(rnd(i % N), 1.2) * Math.abs(Math.sin(i * 0.5)) : 20 + 30 * rnd((i * 2) % N)
        break
      default: // hills
        h = layer === 'far' ? 30 + 45 * (0.5 + 0.5 * Math.sin(i * 0.35) * Math.cos(i * 0.11)) : 14 + 22 * (0.5 + 0.5 * Math.sin(i * 0.8 + 2))
    }
    if (backdrop === 'city' || backdrop === 'mesas') {
      // Blocky: horizontal step then vertical.
      g.lineTo(x, LAYER_H - h)
      g.lineTo(x + LAYER_W / N, LAYER_H - h)
    } else g.lineTo(x, LAYER_H - h)
  }
  g.lineTo(LAYER_W, LAYER_H)
  g.closePath()
  g.fill()
  if (backdrop === 'city' && layer === 'far') {
    // Lit windows.
    g.fillStyle = 'rgba(255,230,150,0.9)'
    for (let i = 0; i < 900; i++) {
      const x = rnd(i * 3) * LAYER_W
      const y = LAYER_H - rnd(i * 3 + 1) * 110
      if (g.isPointInPath(x, y)) g.fillRect(Math.floor(x), Math.floor(y), 2, 2)
    }
  }
  if (backdrop === 'sea' && layer === 'near') {
    // Water band with highlights.
    g.fillStyle = `#${new Color(p.near).getHexString()}`
    g.fillRect(0, LAYER_H - 24, LAYER_W, 24)
    g.fillStyle = 'rgba(255,255,255,0.35)'
    for (let i = 0; i < 120; i++) g.fillRect(rnd(i) * LAYER_W, LAYER_H - 22 + rnd(i + 1) * 20, 6 + rnd(i + 2) * 14, 1)
  }
  tex.needsUpdate = true
}

/** Soft cloud puffs on a transparent strip; the night city gets a thin haze instead. */
function drawClouds(tex: CanvasTexture, p: Palette, night: boolean): void {
  const c = tex.image as HTMLCanvasElement
  c.width = LAYER_W
  c.height = LAYER_H
  const g = c.getContext('2d')!
  g.clearRect(0, 0, LAYER_W, LAYER_H)
  const col = new Color(p.clouds)
  const rnd = (i: number) => {
    const x = Math.sin(i * 12.9898 + 4.1) * 43758.5453
    return x - Math.floor(x)
  }
  const puffs = night ? 5 : 16
  for (let i = 0; i < puffs; i++) {
    const x = rnd(i) * LAYER_W
    const y = 70 + rnd(i + 50) * 70
    const w = 30 + rnd(i + 100) * 70
    const alpha = night ? 0.08 : 0.28 + rnd(i + 150) * 0.22
    g.fillStyle = `rgba(${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)},${alpha})`
    for (let k = 0; k < 5; k++) {
      g.beginPath()
      g.ellipse(x + (k - 2) * w * 0.22, y + (k % 2) * 4, w * 0.26, 8 + rnd(i + k) * 6, 0, 0, Math.PI * 2)
      g.fill()
    }
  }
  tex.needsUpdate = true
}
