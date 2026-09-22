// Loading a baked texture, GPU-compressed when we have one.
//
// A 4076x3762 NAIP overview decodes to about 82 MB of RGBA plus mipmaps on the GPU, from a 4.3 MB
// JPEG — a 19x inflation, and it is why the viewer holds 226 MB of texture for a single site.
// ETC1S (BasisU, transcoded to whatever the client supports) is 4 bits a pixel: the same image is
// ~10 MB resident, and the .ktx2 is smaller on the wire as well because it carries its own mips
// instead of having them generated on upload. Measured on a crofton-triangle tile, 292 KB jpg ->
// 176 KB ktx2.
//
// The bake writes .ktx2 as a TWIN, never a replacement (corridor/ktx2.py), so this is a preference
// and not a requirement: no `ktx2` in the manifest, a browser without the transcoder, or a
// transcode failure all fall back to the .jpg and the site looks the same.
import * as THREE from 'three'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'

let ktx2: KTX2Loader | null = null
let ktx2Broken = false

/** The shared KTX2 loader. Needs the renderer to know which compressed formats the GPU has. */
function loader(renderer: THREE.WebGLRenderer): KTX2Loader | null {
  if (ktx2Broken) return null
  if (!ktx2) {
    try {
      ktx2 = new KTX2Loader().setTranscoderPath('/basis/').detectSupport(renderer)
    } catch (e) {
      console.warn('KTX2 unavailable, falling back to jpg', e)
      ktx2Broken = true
      return null
    }
  }
  return ktx2
}

export interface TexChoice {
  /** the baked jpg — always present */
  file: string
  /** the ktx2 twin, when the bake made one */
  ktx2?: string
}

/**
 * Load a baked texture, preferring the compressed twin.
 *
 * Returns immediately with a texture that fills in when it decodes, like `TextureLoader.load` —
 * the callers hand it straight to a material. If the ktx2 fails for any reason the jpg is loaded
 * into the SAME texture object, so nothing downstream has to know which one it got.
 */
export function loadBakedTexture(base: string, choice: TexChoice, renderer?: THREE.WebGLRenderer, onLoad?: (t: THREE.Texture) => void): THREE.Texture {
  const jpg = () => {
    const t = new THREE.TextureLoader().load(base + choice.file, onLoad)
    t.colorSpace = THREE.SRGBColorSpace
    return t
  }
  const l = choice.ktx2 && renderer ? loader(renderer) : null
  if (!l || !choice.ktx2) return jpg()

  // a placeholder the caller can attach now; swapped for the real image when it arrives
  const out = new THREE.Texture()
  out.colorSpace = THREE.SRGBColorSpace
  l.load(
    base + choice.ktx2,
    (t) => {
      out.image = t.image
      out.mipmaps = t.mipmaps
      out.format = t.format
      out.minFilter = t.minFilter
      out.magFilter = t.magFilter
      out.anisotropy = t.anisotropy
      ;(out as unknown as { isCompressedTexture: boolean }).isCompressedTexture = true
      out.generateMipmaps = false // the ktx2 brought its own
      out.needsUpdate = true
      onLoad?.(out)
    },
    undefined,
    (e) => {
      console.warn(`ktx2 ${choice.ktx2} failed, using ${choice.file}`, e)
      const f = jpg()
      out.image = f.image
      out.needsUpdate = true
    },
  )
  return out
}
