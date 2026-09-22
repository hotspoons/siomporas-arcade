// Weather: what is falling, what the road looks like under it, and what has settled.
//
// Three parts, and they are separate on purpose because they fail differently.
//
//   FALLING   instanced quads in a box that follows the camera. Every particle's position is
//             computed in the VERTEX SHADER from the camera position and the clock — there is no
//             per-frame CPU work and no buffer upload at all, which matters because rain wants
//             tens of thousands of particles and the grass has already taught us what a per-frame
//             upload of that size costs. The trick is to wrap each particle into the box with a
//             mod() against a WORLD lattice rather than against the camera: anchoring to the
//             camera makes the whole field travel with you, so at 30 m/s you drive through rain
//             that never passes you, which reads as glass beads hanging in the air.
//
//   WET       a darker, glossier road. Not a texture — roughness and a darkening on the materials
//             that already exist, so it costs nothing and works on every surface class.
//
//   SETTLED   accumulation, as one shader chunk that the strip, the terrain, the grass and (when
//             road-and-car wire it) the pavement all include. It is a white blend weighted by how
//             far a surface faces up, so it lands on the flat and not on a cut face, and it
//             builds over time rather than appearing.
//
// Ice is the odd one: almost nothing falls, but the accumulation is a glaze rather than a mat, and
// it is where WEATHER_GRIP_SCALE bites hardest.
import * as THREE from 'three'
import * as T from './tuning'

export type Weather = 'clear' | 'rain' | 'sleet' | 'snow' | 'ice'
export const WEATHERS: Weather[] = ['clear', 'rain', 'sleet', 'snow', 'ice']

export interface WeatherLook {
  /**
   * Particles per cubic metre of the box. Small numbers: a 110 m box is 730 000 m³, so 0.03 is
   * twenty-two thousand raindrops.
   */
  density: number
  /**
   * The side of the box, in metres, before WEATHER_BOX scales it. Rain wants a SMALL one and snow
   * a large one. A raindrop is twelve millimetres across: spread the same count over a 110 m box
   * and almost all of it is beyond the distance at which a streak covers a pixel, so the rain is
   * invisible and the frame is spent drawing it. Snow is the opposite — a flake reads at a
   * hundred metres and a tight box around the camera looks like a snow globe.
   */
  box: number
  /** metres per second downward */
  fall: number
  /** metres per second sideways, before the gust field */
  drift: number
  /** metres: the long axis of a particle */
  length: number
  /** metres: the short axis */
  width: number
  colour: THREE.Color
  opacity: number
  /** how much a particle wanders as it falls — a flake does, a raindrop does not */
  flutter: number
  /** the season's fog density is multiplied by this */
  fogScale: number
  /** the sky is pulled this far toward `skyTint` */
  skyMix: number
  skyTint: THREE.Color
  /** 0…1 — darkens and glosses the ground */
  wet: number
  /** 0…1 — how much settles when it has been falling a while */
  accum: number
  /** what a tyre keeps: car.ts reads WEATHER_GRIP_SCALE, which this sets */
  grip: number
  /** the settled layer's colour: snow is white, ice is a grey glaze */
  accumColour: THREE.Color
}

const c = (hex: number) => new THREE.Color(hex)

export const WEATHER: Record<Weather, WeatherLook> = {
  clear: {
    density: 0, box: 60, fall: 0, drift: 0, length: 0, width: 0, colour: c(0xffffff), opacity: 0, flutter: 0,
    fogScale: 1, skyMix: 0, skyTint: c(0xffffff), wet: 0, accum: 0, grip: 1, accumColour: c(0xffffff),
  },
  rain: {
    // a streak, falling fast and nearly straight: the eye reads rain from the streak length, not
    // from the count, so this is fewer and longer than it looks like it should be
    density: 0.15, box: 38, fall: 14, drift: 2.2, length: 0.55, width: 0.012,
    colour: c(0xc8d4e0), opacity: 0.5, flutter: 0.05,
    fogScale: 3.2, skyMix: 0.72, skyTint: c(0x8f98a2), wet: 1, accum: 0, grip: 0.82, accumColour: c(0xffffff),
  },
  sleet: {
    density: 0.08, box: 48, fall: 10, drift: 2.6, length: 0.22, width: 0.03,
    colour: c(0xdfe8f0), opacity: 0.72, flutter: 0.35,
    fogScale: 3.8, skyMix: 0.8, skyTint: c(0x9aa2aa), wet: 0.85, accum: 0.35, grip: 0.55, accumColour: c(0xf0f4f8),
  },
  snow: {
    density: 0.03, box: 105, fall: 1.3, drift: 1.6, length: 0.055, width: 0.055,
    colour: c(0xffffff), opacity: 0.95, flutter: 1,
    fogScale: 4.5, skyMix: 0.88, skyTint: c(0xc6ccd2), wet: 0.2, accum: 1, grip: 0.5, accumColour: c(0xfbfdff),
  },
  ice: {
    // freezing rain: barely anything visible in the air, and everything on the ground
    density: 0.05, box: 34, fall: 13, drift: 1.4, length: 0.4, width: 0.01,
    colour: c(0xd4e2ee), opacity: 0.35, flutter: 0.05,
    fogScale: 2.4, skyMix: 0.62, skyTint: c(0xa8b0b8), wet: 1, accum: 0.55, grip: 0.22, accumColour: c(0xdfe9f2),
  },
}

/**
 * The settled layer, as a chunk every ground material includes.
 *
 * Weighted by how far the surface faces up, so it sits on the flat and slides off a cut face, with
 * a little noise in the band so the line where it stops is not a contour. `uAccum` is the built-up
 * amount, which `Precipitation.tick` ramps rather than switching, because snow that appears
 * between one frame and the next reads as a bug.
 */
export const ACCUM_PARS = /* glsl */ `
  uniform float uAccum;        // 0…1, how much has settled
  uniform vec3 uAccumColour;
  uniform float uWet;          // 0…1, how wet the surface is
  float accumWeight(vec3 worldNormal, vec3 worldPos) {
    if (uAccum <= 0.001) return 0.0;
    float up = clamp(worldNormal.y, 0.0, 1.0);
    // a hash of world position breaks the contour line where the layer runs out
    float n = fract(sin(dot(floor(worldPos.xz * 3.0), vec2(127.1, 311.7))) * 43758.5453);
    float slope = smoothstep(0.42 - 0.12 * uAccum, 0.9 - 0.35 * uAccum, up + (n - 0.5) * 0.14);
    return clamp(slope * uAccum, 0.0, 1.0);
  }
  vec3 applyWeather(vec3 colour, vec3 worldNormal, vec3 worldPos) {
    // wet first: water darkens what it soaks and then the settled layer covers it
    colour *= mix(1.0, 0.62, uWet);
    return mix(colour, uAccumColour, accumWeight(worldNormal, worldPos));
  }
`

/** The uniforms `ACCUM_PARS` needs. One object, shared by every material that includes the chunk. */
export function accumUniforms(): Record<string, THREE.IUniform> {
  return {
    uAccum: { value: 0 },
    uAccumColour: { value: new THREE.Color(0xffffff) },
    uWet: { value: 0 },
  }
}

/**
 * What is falling.
 *
 * One InstancedBufferGeometry of quads, sized once at `capacity`, with the live count driven by
 * the weather's density and the box volume. Nothing is written per frame: the vertex shader gets
 * the camera position and the time and works out where each particle is.
 */
export class Precipitation {
  mesh: THREE.Mesh
  private geo: THREE.InstancedBufferGeometry
  private mat: THREE.ShaderMaterial
  private capacity: number
  private look: WeatherLook = WEATHER.clear
  private weather: Weather = 'clear'
  /** the settled amount, ramped toward the weather's target so snow builds instead of appearing */
  private accum = 0
  private wet = 0
  /** every material that draws settled weather, so one tick updates them all */
  private followers: Record<string, THREE.IUniform>[] = []

  constructor(capacity = 60_000, fog: THREE.FogExp2 | null = null) {
    this.capacity = capacity
    const g = new THREE.InstancedBufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2))
    g.setIndex([0, 1, 2, 0, 2, 3])
    // a fixed lattice of pseudo-random offsets in the unit cube, plus a per-particle phase
    const seed = new Float32Array(capacity * 4)
    for (let i = 0; i < capacity; i++) {
      seed[i * 4] = hash(i * 3 + 1)
      seed[i * 4 + 1] = hash(i * 7 + 2)
      seed[i * 4 + 2] = hash(i * 11 + 3)
      seed[i * 4 + 3] = hash(i * 13 + 5)
    }
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4))
    g.instanceCount = 0
    this.geo = g

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        ...THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
        uTime: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uBox: { value: new THREE.Vector3(120, 60, 120) },
        uFall: { value: 0 },
        uDrift: { value: 0 },
        uFlutter: { value: 0 },
        uSize: { value: new THREE.Vector2(0.01, 0.4) },
        uGrow: { value: 0.012 },
        uColour: { value: new THREE.Color(0xffffff) },
        uOpacity: { value: 0 },
      },
      vertexShader: /* glsl */ `
        attribute vec4 aSeed;
        uniform float uTime;
        uniform vec3 uCam;
        uniform vec3 uBox;
        uniform float uFall;
        uniform float uDrift;
        uniform float uFlutter;
        uniform vec2 uSize;   // (width, length)
        uniform float uGrow;  // how fast a particle is widened with distance
        varying vec2 vUv;
        varying float vFade;
        #include <common>
        #include <fog_pars_vertex>
        #include <logdepthbuf_pars_vertex>
        void main() {
          vUv = uv;
          // where this particle is in the world. The wrap is against a WORLD lattice, not against
          // the camera, so particles stream PAST you as you drive instead of travelling with you.
          vec3 origin = uCam - uBox * 0.5;
          vec3 wander = vec3(
            sin(uTime * 1.6 + aSeed.w * 31.4) * uFlutter * 0.6,
            0.0,
            cos(uTime * 1.3 + aSeed.w * 17.7) * uFlutter * 0.6
          );
          vec3 drift = vec3(0.8, 0.0, 0.5) * uDrift * uTime;
          vec3 raw = aSeed.xyz * uBox + drift + wander - vec3(0.0, uFall * uTime, 0.0);
          vec3 world = origin + mod(raw - origin, uBox);
          // the quad: a streak hangs along its own velocity, so rain leans with the wind
          vec3 vel = normalize(vec3(0.8, 0.0, 0.5) * uDrift - vec3(0.0, uFall, 0.0) + vec3(1e-4));
          vec3 toCam = normalize(cameraPosition - world);
          vec3 side = normalize(cross(vel, toCam));
          // keep a distant particle from falling under a pixel: widen it with distance, which is
          // what a cheap screen-space minimum size buys without the projection maths
          float camD = distance(world, cameraPosition);
          float grow = 1.0 + camD * uGrow;
          vec3 p = world + side * position.x * uSize.x * grow + vel * -position.y * uSize.y * (1.0 + camD * uGrow * 0.18);
          // fade at the rim of the box so nothing pops in at the boundary
          float d = length(world.xz - uCam.xz) / (uBox.x * 0.5);
          vFade = 1.0 - smoothstep(0.75, 1.0, d);
          vec4 mvPosition = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <logdepthbuf_vertex>
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColour;
        uniform float uOpacity;
        varying vec2 vUv;
        varying float vFade;
        #include <fog_pars_fragment>
        #include <logdepthbuf_pars_fragment>
        void main() {
          #include <logdepthbuf_fragment>
          // a soft-edged capsule, so a flake is round and a streak is a streak
          vec2 q = (vUv - 0.5) * 2.0;
          float r = max(abs(q.x), 0.0);
          float a = (1.0 - smoothstep(0.35, 1.0, r)) * (1.0 - smoothstep(0.7, 1.0, abs(q.y)));
          a *= uOpacity * vFade;
          if (a < 0.01) discard;
          gl_FragColor = vec4(uColour, a);
          #include <fog_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: !!fog,
    })
    this.mesh = new THREE.Mesh(this.geo, this.mat)
    this.mesh.name = 'precipitation'
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 10
  }

  /** materials that include ACCUM_PARS; their uniforms are driven from here */
  follow(u: Record<string, THREE.IUniform>) {
    this.followers.push(u)
  }

  get current(): Weather {
    return this.weather
  }

  set(w: Weather) {
    this.weather = w
    this.look = WEATHER[w]
    const m = this.mat.uniforms
    ;(m.uColour.value as THREE.Color).copy(this.look.colour)
    m.uSize.value.set(this.look.width, this.look.length)
    m.uFall.value = this.look.fall
    m.uFlutter.value = this.look.flutter
    for (const u of this.followers) (u.uAccumColour.value as THREE.Color).copy(this.look.accumColour)
  }

  /** the settled layer, 0…1 — probes and the HUD read it */
  get settled(): number {
    return this.accum
  }

  /** instances actually drawn */
  get count(): number {
    return this.geo.instanceCount
  }

  private prevT = -1

  /** `time` is the scene clock; dt comes from it, so the caller needs nothing it does not have */
  tick(eye: THREE.Vector3, time: number) {
    const dt = this.prevT < 0 ? 0 : Math.min(0.25, Math.max(0, time - this.prevT))
    this.prevT = time
    const m = this.mat.uniforms
    const box = m.uBox.value as THREE.Vector3
    const side = this.look.box * T.WEATHER_BOX
    box.set(side, side * 0.6, side)
    m.uTime.value = time
    m.uDrift.value = this.look.drift * T.WEATHER_WIND
    ;(m.uCam.value as THREE.Vector3).copy(eye)
    m.uOpacity.value = this.look.opacity * T.WEATHER_OPACITY
    const want = Math.min(this.capacity, Math.round(this.look.density * T.WEATHER_RATE * box.x * box.y * box.z))
    this.geo.instanceCount = want

    // settle and thaw on a clock, so a change of weather is a change of scene and not a cut. The
    // build is slower than the melt on purpose: snow takes a while to lie and goes quickly.
    const target = this.look.accum * T.WEATHER_ACCUM
    const rate = target > this.accum ? T.WEATHER_SETTLE_RATE : T.WEATHER_MELT_RATE
    this.accum += Math.max(-rate * dt, Math.min(rate * dt, target - this.accum))
    this.wet += Math.max(-dt * 0.6, Math.min(dt * 0.6, this.look.wet - this.wet))
    for (const u of this.followers) {
      u.uAccum.value = this.accum
      u.uWet.value = this.wet
    }
  }

  dispose() {
    this.geo.dispose()
    this.mat.dispose()
  }
}

function hash(n: number): number {
  let x = (n | 0) ^ 0x5bd1e995
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d)
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39)
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296
}
