// The 1989 look, done as deliberate degradation: render the scene into a tiny
// nearest-filtered target, then present it through one shader that posterises,
// dithers, draws scanlines, bends the glass and bleeds phosphor. Each element
// is a toggle. The 20 Hz cadence lives in the loop, not here. In XR the target
// and flat shading survive; the CRT overlay and cadence are forced off.

import {
  LinearSRGBColorSpace,
  Mesh,
  NearestFilter,
  NoToneMapping,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  UnsignedByteType,
  Vector2,
  WebGLRenderTarget,
  type Camera,
  type WebGLRenderer,
} from 'three'
import type { RetroOptions, Style, StyleFrameInfo } from './Style'

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tFrame;
uniform vec2 uRes;      // low-res target size
uniform vec2 uScreen;   // output size
uniform float uLevels;
uniform float uScan;
uniform float uBarrel;
uniform float uDither;
uniform float uPhosphor;
uniform float uTime;

const mat4 BAYER = mat4(
   0.0,  8.0,  2.0, 10.0,
  12.0,  4.0, 14.0,  6.0,
   3.0, 11.0,  1.0,  9.0,
  15.0,  7.0, 13.0,  5.0);

float bayer(vec2 p) {
  int x = int(mod(p.x, 4.0));
  int y = int(mod(p.y, 4.0));
  // mat4 indexing by variable is legal in GLSL ES 3.00 for column vectors
  vec4 col = BAYER[x];
  return (y == 0 ? col.x : y == 1 ? col.y : y == 2 ? col.z : col.w) / 16.0;
}

void main() {
  // The low-res buffer is cut to the window's own aspect (see resize), so the picture fills the
  // screen: no letterbox, and the tube curves over the whole area.
  vec2 uv = vUv;
  if (uBarrel > 0.0) {
    vec2 c = uv - 0.5;
    float r2 = dot(c, c);
    // Bulge, then pull back in by the same amount at the corners so the bulge can't reveal the edge.
    uv = 0.5 + c * (1.0 + uBarrel * 0.18 * r2) / (1.0 + uBarrel * 0.09);
  }
  uv = clamp(uv, vec2(0.0), vec2(1.0));
  // Nearest sample: the whole look hinges on this.
  vec2 px = floor(uv * uRes) + 0.5;
  vec3 col = texture2D(tFrame, px / uRes).rgb;

  if (uPhosphor > 0.0) {
    // Cheap horizontal bleed of bright neighbours.
    vec3 l = texture2D(tFrame, (px + vec2(-1.0, 0.0)) / uRes).rgb;
    vec3 r = texture2D(tFrame, (px + vec2(1.0, 0.0)) / uRes).rgb;
    col += (l + r) * 0.18 * uPhosphor;
  }

  // Posterise with optional ordered dithering.
  float levels = max(uLevels, 2.0);
  float d = uDither > 0.0 ? (bayer(px) - 0.5) * 0.55 / levels : 0.0;
  col = floor((col + d) * levels + 0.5) / levels;

  if (uScan > 0.0) {
    float line = mod(floor(vUv.y * uScreen.y), 3.0);
    float s = line < 1.0 ? 1.0 - 0.45 * uScan : 1.0;
    col *= s;
    // Slight vertical aperture flicker.
    col *= 1.0 - 0.03 * uScan * sin(uTime * 120.0);
  }
  gl_FragColor = vec4(col, 1.0);
}
`
const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

export class RetroStyle implements Style {
  readonly name = 'retro' as const
  private renderer: WebGLRenderer | null = null
  private scene: Scene | null = null
  private camera: Camera | null = null
  private target: WebGLRenderTarget | null = null
  /** Size of the low-res buffer: the option's line count, widened to the window's aspect. */
  private bufW = 320
  private bufH = 240

  /** Lines in the low-res buffer — one "retro pixel" is this fraction of the window's height. */
  get bufferHeight(): number {
    return this.bufH
  }
  private readonly quadScene = new Scene()
  private readonly quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly material: ShaderMaterial
  private xr = false
  private width = 1
  private height = 1
  readonly opts: RetroOptions

  constructor(opts: RetroOptions) {
    this.opts = opts
    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        tFrame: { value: null },
        uRes: { value: new Vector2(320, 240) },
        uScreen: { value: new Vector2(1, 1) },
        uLevels: { value: 5 },
        uScan: { value: 1 },
        uBarrel: { value: 1 },
        uDither: { value: 1 },
        uPhosphor: { value: 1 },
        uTime: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    })
    this.quadScene.add(new Mesh(new PlaneGeometry(2, 2), this.material))
  }

  attach(renderer: WebGLRenderer, scene: Scene, camera: Camera): void {
    this.renderer = renderer
    this.scene = scene
    this.camera = camera
    this.rebuild()
  }

  rebuild(): void {
    this.target?.dispose()
    const o = this.opts
    // The chosen resolution sets the line count; the width follows the window so the image fills it.
    const lines = Math.max(120, Math.round(o.height))
    const aspect = this.height > 0 ? this.width / this.height : o.width / o.height
    this.bufW = Math.max(lines, Math.min(lines * 3, Math.round((lines * aspect) / 2) * 2))
    this.bufH = lines
    this.target = new WebGLRenderTarget(this.bufW, this.bufH, {
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      generateMipmaps: false,
      format: RGBAFormat,
      type: UnsignedByteType,
      colorSpace: SRGBColorSpace,
      depthBuffer: true,
    })
    this.material.uniforms.tFrame.value = this.target.texture
    this.material.uniforms.uRes.value.set(this.bufW, this.bufH)
  }

  detach(): void {
    this.target?.dispose()
    this.target = null
  }

  resize(width: number, height: number, _pixelRatio: number): void {
    this.width = width
    this.height = height
    // Present at device resolution 1: the upscale is the effect.
    this.renderer?.setPixelRatio(1)
    this.renderer?.setSize(width, height, false)
    this.material.uniforms.uScreen.value.set(width, height)
    // The buffer is as wide as the window needs; rebuild when that changes.
    const lines = Math.max(120, Math.round(this.opts.height))
    const want = Math.max(lines, Math.min(lines * 3, Math.round((lines * (height > 0 ? width / height : 1.33)) / 2) * 2))
    if (this.target && (want !== this.bufW || lines !== this.bufH)) this.rebuild()
  }

  setXr(active: boolean): void {
    this.xr = active
  }

  render(info: StyleFrameInfo): void {
    const r = this.renderer
    if (!r || !this.scene || !this.camera) return
    const o = this.opts
    if (this.xr || !this.target) {
      // XR: no CRT overlay and no offscreen present — the runtime owns the eye buffers.
      r.render(this.scene, this.camera)
      return
    }
    const prevTone = r.toneMapping
    const prevSpace = r.outputColorSpace
    r.toneMapping = NoToneMapping
    r.outputColorSpace = LinearSRGBColorSpace
    r.setRenderTarget(this.target)
    r.clear()
    r.render(this.scene, this.camera)
    r.setRenderTarget(null)
    r.outputColorSpace = prevSpace
    r.toneMapping = prevTone
    const u = this.material.uniforms
    u.uLevels.value = o.paletteLevels
    u.uScan.value = o.scanlines ? 1 : 0
    u.uBarrel.value = o.barrel ? 1 : 0
    u.uDither.value = o.dither ? 1 : 0
    u.uPhosphor.value = o.phosphor ? 1 : 0
    u.uTime.value = info.time
    r.render(this.quadScene, this.quadCamera)
    void this.width
    void this.height
  }
}
