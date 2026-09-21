// Stochastic texturing for the pavement: hex tiling over a library of variants.
//
// A single tile repeated is found by the eye in seconds, however good the tile. Hex tiling
// (Mikkelsen, "Practical Real-Time Hex-Tiling", JCGT 2022) lays a triangular grid over the
// surface, and at every point blends the three nearest cells, each of which samples the texture at
// its own random offset — and here from its own random VARIANT of a small library, so the same
// square metre never recurs. Weights are sharpened so one cell dominates and the blend does not
// wash the detail out. The same lookup drives the normal map, so relief follows colour.
//
// The library is a `DataArrayTexture`: N tiles of one size stacked, sampled as `sampler2DArray`
// (WebGL2). `textureGrad` with the un-offset uv's derivatives keeps mipmapping honest across the
// per-cell offsets.
import * as THREE from 'three'

export const HEX_GLSL = /* glsl */ `
uniform sampler2DArray hexAlbedo;
uniform sampler2DArray hexNormal;
uniform float hexLayers;
uniform float hexCell; // hex cell size in tile units (how many tiles wide one cell is)

void hexTriangleGrid(vec2 uv, out float w1, out float w2, out float w3, out ivec2 v1, out ivec2 v2, out ivec2 v3) {
  const mat2 gridToSkewedGrid = mat2(1.0, -0.57735027, 0.0, 1.15470054);
  vec2 skewed = gridToSkewedGrid * uv;
  ivec2 baseId = ivec2(floor(skewed));
  vec3 temp = vec3(fract(skewed), 0.0);
  temp.z = 1.0 - temp.x - temp.y;
  if (temp.z > 0.0) {
    w1 = temp.z; w2 = temp.y; w3 = temp.x;
    v1 = baseId; v2 = baseId + ivec2(0, 1); v3 = baseId + ivec2(1, 0);
  } else {
    w1 = -temp.z; w2 = 1.0 - temp.y; w3 = 1.0 - temp.x;
    v1 = baseId + ivec2(1, 1); v2 = baseId + ivec2(1, 0); v3 = baseId + ivec2(0, 1);
  }
}

vec3 hexHash(ivec2 p) {
  vec2 q = vec2(p);
  vec3 h = vec3(dot(q, vec2(127.1, 311.7)), dot(q, vec2(269.5, 183.3)), dot(q, vec2(419.2, 371.9)));
  return fract(sin(h) * 43758.5453);
}

// returns albedo in .rgb (alpha 1) and writes the blended tangent-space normal to n
vec4 hexSample(vec2 uv, out vec3 n) {
  float w1, w2, w3; ivec2 v1, v2, v3;
  hexTriangleGrid(uv / hexCell, w1, w2, w3, v1, v2, v3);
  vec3 h1 = hexHash(v1), h2 = hexHash(v2), h3 = hexHash(v3);
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  vec3 uv1 = vec3(uv + h1.xy, floor(h1.z * hexLayers));
  vec3 uv2 = vec3(uv + h2.xy, floor(h2.z * hexLayers));
  vec3 uv3 = vec3(uv + h3.xy, floor(h3.z * hexLayers));
  vec3 w = pow(vec3(w1, w2, w3), vec3(4.0));
  w /= (w.x + w.y + w.z);
  vec4 c = textureGrad(hexAlbedo, uv1, dx, dy) * w.x + textureGrad(hexAlbedo, uv2, dx, dy) * w.y + textureGrad(hexAlbedo, uv3, dx, dy) * w.z;
  vec3 nn = textureGrad(hexNormal, uv1, dx, dy).xyz * w.x + textureGrad(hexNormal, uv2, dx, dy).xyz * w.y + textureGrad(hexNormal, uv3, dx, dy).xyz * w.z;
  n = nn * 2.0 - 1.0;
  return vec4(c.rgb, 1.0);
}
`

/** Stack same-sized images into a texture array. */
export async function arrayTexture(urls: string[], srgb: boolean): Promise<THREE.DataArrayTexture> {
  const imgs = await Promise.all(
    urls.map(
      (u) =>
        new Promise<HTMLImageElement>((ok, fail) => {
          const im = new Image()
          im.crossOrigin = 'anonymous'
          im.onload = () => ok(im)
          im.onerror = () => fail(new Error(u))
          im.src = u
        }),
    ),
  )
  const w = imgs[0].naturalWidth, h = imgs[0].naturalHeight
  const data = new Uint8Array(w * h * 4 * imgs.length)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  imgs.forEach((im, i) => {
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(im, 0, 0, w, h)
    data.set(ctx.getImageData(0, 0, w, h).data, i * w * h * 4)
  })
  const t = new THREE.DataArrayTexture(data, w, h, imgs.length)
  t.format = THREE.RGBAFormat
  t.type = THREE.UnsignedByteType
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.magFilter = THREE.LinearFilter
  t.generateMipmaps = true
  t.anisotropy = 8
  t.flipY = false
  if (srgb) t.colorSpace = THREE.SRGBColorSpace
  t.needsUpdate = true
  return t
}
