// Backdrop for open-air and flight sections: a starfield that follows the
// camera (translation only) and a gradient dome with a horizon band. Inside a
// tube neither is visible; bursting out into them is the point.

import { BackSide, BufferAttribute, BufferGeometry, Color, Group, Mesh, Points, PointsMaterial, ShaderMaterial, SphereGeometry, Vector3 } from 'three'

const STAR_COUNT = 1800
const STAR_RADIUS = 2600

export class Sky {
  readonly root = new Group()
  private readonly dome: Mesh
  private readonly domeMat: ShaderMaterial

  constructor() {
    const pos = new Float32Array(STAR_COUNT * 3)
    const col = new Float32Array(STAR_COUNT * 3)
    const c = new Color()
    for (let i = 0; i < STAR_COUNT; i++) {
      const u = Math.random() * 2 - 1
      const ph = Math.random() * Math.PI * 2
      const r = Math.sqrt(1 - u * u)
      pos[i * 3] = r * Math.cos(ph) * STAR_RADIUS
      pos[i * 3 + 1] = (u * 0.8 + 0.15) * STAR_RADIUS
      pos[i * 3 + 2] = r * Math.sin(ph) * STAR_RADIUS
      c.setHSL(0.55 + Math.random() * 0.15, 0.4, 0.6 + Math.random() * 0.4)
      col[i * 3] = c.r
      col[i * 3 + 1] = c.g
      col[i * 3 + 2] = c.b
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(pos, 3))
    g.setAttribute('color', new BufferAttribute(col, 3))
    const stars = new Points(g, new PointsMaterial({ size: 2.2, sizeAttenuation: false, vertexColors: true, depthWrite: false }))
    stars.frustumCulled = false
    this.root.add(stars)

    this.domeMat = new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      uniforms: {
        uTop: { value: new Color(0x0a0620) },
        uHorizon: { value: new Color(0x2a1650) },
        uBottom: { value: new Color(0x06040f) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uBottom;
        void main() {
          float y = vDir.y;
          float band = exp(-abs(y - 0.02) * 9.0);
          vec3 c = y > 0.0 ? mix(uHorizon, uTop, smoothstep(0.0, 0.5, y)) : mix(uHorizon, uBottom, smoothstep(0.0, 0.25, -y));
          c += uHorizon * band * 0.6;
          gl_FragColor = vec4(c, 1.0);
        }`,
    })
    this.dome = new Mesh(new SphereGeometry(STAR_RADIUS * 1.2, 24, 12), this.domeMat)
    this.dome.frustumCulled = false
    this.dome.renderOrder = -10
    this.root.add(this.dome)
  }

  setPalette(hue: number, bg: Color): void {
    const u = this.domeMat.uniforms
    ;(u.uHorizon.value as Color).setHSL((hue + 0.25) % 1, 0.45, 0.13)
    ;(u.uTop.value as Color).setHSL((hue + 0.2) % 1, 0.5, 0.05)
    ;(u.uBottom.value as Color).copy(bg)
  }

  update(cameraWorldPos: Vector3): void {
    this.root.position.copy(cameraWorldPos)
  }
}
