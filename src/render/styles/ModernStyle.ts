// Modern look: HDR framebuffer, thresholded bloom, speed-scaled radial motion
// blur and chromatic aberration, film grain, ACES tone mapping, SMAA. All of it
// is a single merged EffectPass, and all of it is off in XR.

import { HalfFloatType, type Camera, type Scene, type WebGLRenderer, Uniform, Vector2 } from 'three'
import {
  BlendFunction,
  BloomEffect,
  ChromaticAberrationEffect,
  Effect,
  EffectAttribute,
  EffectComposer,
  EffectPass,
  NoiseEffect,
  RenderPass,
  SMAAEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing'
import type { Style, StyleFrameInfo } from './Style'
import type { SettingsData } from '../../app/Settings'

/** Radial blur toward the screen centre, strength driven per frame. */
class RadialBlurEffect extends Effect {
  constructor() {
    super(
      'RadialBlurEffect',
      /* glsl */ `
      uniform float strength;
      uniform float shock;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec2 dir = uv - 0.5;
        float dist = length(dir);
        // Shockwave: a ripple displacing samples outward.
        vec2 ruv = uv;
        if (shock > 0.0) {
          float ring = sin((dist - shock * 0.9) * 40.0) * exp(-abs(dist - shock * 0.9) * 18.0);
          ruv += normalize(dir + 1e-5) * ring * 0.02 * (1.0 - shock);
        }
        float amt = strength * dist * dist;
        vec4 sum = vec4(0.0);
        const int N = 8;
        for (int i = 0; i < N; i++) {
          float t = float(i) / float(N - 1) - 0.5;
          sum += texture2D(inputBuffer, ruv - dir * amt * t);
        }
        outputColor = sum / float(N);
      }`,
      {
        blendFunction: BlendFunction.SRC,
        attributes: EffectAttribute.CONVOLUTION,
        uniforms: new Map<string, Uniform>([
          ['strength', new Uniform(0)],
          ['shock', new Uniform(0)],
        ]),
      },
    )
  }
  set strength(v: number) {
    this.uniforms.get('strength')!.value = v
  }
  set shock(v: number) {
    this.uniforms.get('shock')!.value = v
  }
}

export class ModernStyle implements Style {
  readonly name = 'modern' as const
  private composer: EffectComposer | null = null
  private renderer: WebGLRenderer | null = null
  private scene: Scene | null = null
  private camera: Camera | null = null
  private bloom: BloomEffect | null = null
  private chroma: ChromaticAberrationEffect | null = null
  private blur: RadialBlurEffect | null = null
  private noise: NoiseEffect | null = null
  private vignette: VignetteEffect | null = null
  private xr = false
  private readonly opts: SettingsData['modern']
  private readonly chromaOffset = new Vector2()
  reducedMotion = false

  constructor(opts: SettingsData['modern']) {
    this.opts = opts
  }

  attach(renderer: WebGLRenderer, scene: Scene, camera: Camera): void {
    this.renderer = renderer
    this.scene = scene
    this.camera = camera
    this.rebuild()
  }

  /** Rebuild the pass chain from the option flags. */
  rebuild(): void {
    if (!this.renderer || !this.scene || !this.camera) return
    this.composer?.dispose()
    const composer = new EffectComposer(this.renderer, { frameBufferType: HalfFloatType, multisampling: 0 })
    composer.addPass(new RenderPass(this.scene, this.camera))
    const effects: Effect[] = []
    const o = this.opts
    // Convolution effects can't share a pass: the blur gets its own.
    if (o.motionBlur) {
      this.blur = new RadialBlurEffect()
      composer.addPass(new EffectPass(this.camera, this.blur))
    } else this.blur = null
    if (o.bloom) {
      this.bloom = new BloomEffect({ intensity: 0.7, luminanceThreshold: 0.7, luminanceSmoothing: 0.25, mipmapBlur: true, radius: 0.55 })
      effects.push(this.bloom)
    } else this.bloom = null
    if (o.chromatic) {
      this.chroma = new ChromaticAberrationEffect({ offset: this.chromaOffset, radialModulation: true, modulationOffset: 0.35 })
      effects.push(this.chroma)
    } else this.chroma = null
    this.vignette = new VignetteEffect({ darkness: 0.55, offset: 0.3 })
    effects.push(this.vignette)
    if (o.grain) {
      this.noise = new NoiseEffect({ blendFunction: BlendFunction.SOFT_LIGHT, premultiply: true })
      this.noise.blendMode.opacity.value = 0.18
      effects.push(this.noise)
    } else this.noise = null
    effects.push(new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }))
    composer.addPass(new EffectPass(this.camera, ...effects))
    if (o.smaa) composer.addPass(new EffectPass(this.camera, new SMAAEffect()))
    this.composer = composer
  }

  detach(): void {
    this.composer?.dispose()
    this.composer = null
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.renderer?.setPixelRatio(pixelRatio)
    this.renderer?.setSize(width, height, false)
    this.composer?.setSize(width, height)
  }

  setXr(active: boolean): void {
    this.xr = active
  }

  render(info: StyleFrameInfo): void {
    if (!this.renderer || !this.scene || !this.camera) return
    if (this.xr || !this.composer) {
      // Per-eye post reads as broken depth: draw straight to the XR layer.
      this.renderer.render(this.scene, this.camera)
      return
    }
    const motion = this.reducedMotion ? 0.25 : 1
    if (this.blur) {
      this.blur.strength = (0.12 + 0.55 * Math.max(0, info.speedT) + 0.5 * info.boost) * motion
      this.blur.shock = info.shockAge >= 0 && info.shockAge < 0.6 ? info.shockAge / 0.6 : 0
    }
    if (this.chroma) {
      const c = (0.0004 + 0.0016 * Math.max(0, info.speedT) + 0.003 * info.hit) * motion
      this.chromaOffset.set(c, c)
    }
    if (this.vignette) {
      // Low shield closes the frame in red; the HUD overlay adds the colour.
      const low = info.shield < 35 ? (35 - info.shield) / 35 : 0
      this.vignette.darkness = 0.5 + low * 0.35 + info.hit * 0.3
    }
    this.composer.render(info.dt)
  }
}
