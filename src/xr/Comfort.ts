// VR comfort: presets, the cockpit frame, and the dynamic vignette. The
// cockpit is a static-relative-to-the-vehicle frame in peripheral vision — the
// highest-value comfort feature there is. The vignette is a head-attached
// annulus whose opacity follows lateral and angular acceleration, not a
// screen-space post effect (those read wrong per eye).

import { BoxGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, RingGeometry, ShaderMaterial } from 'three'
import type { ComfortPreset } from '../app/Settings'

export interface ComfortParams {
  /** VISUAL_SPEED_GAIN in this preset. */
  visualGain: number
  /** Vignette strength 0..1. */
  vignette: number
  /** Multiplier on SPEED_MAX. */
  speedScale: number
  /** Multiplier on the laser aim cone. */
  aimConeScale: number
}

export const COMFORT_PRESETS: Record<ComfortPreset, ComfortParams> = {
  intense: { visualGain: 1.0, vignette: 0.3, speedScale: 1, aimConeScale: 1 },
  standard: { visualGain: 0.55, vignette: 0.65, speedScale: 1, aimConeScale: 1 },
  maximum: { visualGain: 0.35, vignette: 1.0, speedScale: 0.82, aimConeScale: 1.5 },
}

export function buildCockpit(): Group {
  const g = new Group()
  const frame = new MeshStandardMaterial({ color: 0x1a2030, metalness: 0.8, roughness: 0.5, emissive: 0x081020 })
  const edge = new MeshBasicMaterial({ color: 0x25e8ff })
  // Canopy struts: two A-pillars and a header bar, just outside the sweet spot.
  const strut = new BoxGeometry(0.03, 1.2, 0.03)
  for (const x of [-0.55, 0.55]) {
    const m = new Mesh(strut, frame)
    m.position.set(x, 0.1, -0.9)
    m.rotation.z = x > 0 ? -0.25 : 0.25
    g.add(m)
  }
  const header = new Mesh(new BoxGeometry(1.25, 0.03, 0.03), frame)
  header.position.set(0, 0.62, -0.95)
  g.add(header)
  // Dash slab with a neon lip.
  const dash = new Mesh(new BoxGeometry(1.3, 0.06, 0.45), frame)
  dash.position.set(0, -0.42, -0.85)
  g.add(dash)
  const lip = new Mesh(new BoxGeometry(1.3, 0.008, 0.01), edge)
  lip.position.set(0, -0.385, -0.63)
  g.add(lip)
  // Wing edges in the far periphery.
  for (const x of [-1.3, 1.3]) {
    const wing = new Mesh(new BoxGeometry(1.2, 0.02, 0.6), frame)
    wing.position.set(x, -0.5, -0.4)
    wing.rotation.z = x > 0 ? -0.12 : 0.12
    g.add(wing)
    const glow = new Mesh(new BoxGeometry(1.2, 0.006, 0.01), edge)
    glow.position.set(x, -0.485, -0.1)
    glow.rotation.z = wing.rotation.z
    g.add(glow)
  }
  g.visible = false
  return g
}

export class Vignette {
  readonly mesh: Mesh
  private readonly mat: ShaderMaterial
  private level = 0

  constructor() {
    this.mat = new ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
      uniforms: { uInner: { value: 0.9 }, uStrength: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec2 vP;
        void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        varying vec2 vP;
        uniform float uInner;
        uniform float uStrength;
        void main() {
          float d = length(vP);
          float a = smoothstep(uInner, uInner + 0.35, d) * uStrength;
          gl_FragColor = vec4(0.0, 0.0, 0.0, a);
        }`,
    })
    this.mesh = new Mesh(new RingGeometry(0.0, 3, 32, 1), this.mat)
    this.mesh.position.z = -0.5
    this.mesh.renderOrder = 999
    this.mesh.frustumCulled = false
    this.mesh.visible = false
  }

  /** `stress` is 0..1 from lateral/angular acceleration; `strength` from the preset. */
  update(stress: number, strength: number, dt: number): void {
    const target = Math.min(1, stress * 1.4) * strength
    this.level += (target - this.level) * Math.min(1, dt * (target > this.level ? 12 : 3))
    this.mat.uniforms.uStrength.value = this.level
    // Tunnel closes tighter as stress rises.
    this.mat.uniforms.uInner.value = 0.95 - 0.5 * this.level
    this.mesh.visible = this.level > 0.01
  }
}
