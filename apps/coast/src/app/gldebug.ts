// `?gldebug=1` — what this device actually gave us.
//
// Sprites arriving as black rectangles on a phone is a GPU-side story: a texture
// the driver would not allocate, a context dropped mid-bake, a limit lower than
// the atlas asks for. None of that shows up on a desktop, and a phone has no
// console to read, so this puts the answer on the screen where it can be
// photographed: the limits, what the bake decided, and the atlas itself.

import type { WebGLRenderer } from 'three'
import type { SpriteAtlas } from '../render/SpriteAtlas'

export function showGlDebug(parent: HTMLElement, renderer: WebGLRenderer, atlas: SpriteAtlas): void {
  const gl = renderer.getContext()
  const dbg = gl.getExtension('WEBGL_debug_renderer_info')
  const rows: [string, string][] = [
    ['GPU', dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'hidden'],
    ['WebGL', renderer.capabilities.isWebGL2 ? '2' : '1'],
    ['Max texture', `${gl.getParameter(gl.MAX_TEXTURE_SIZE)} px`],
    ['Max renderbuffer', `${gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)} px`],
    ['Atlas', `${atlas.size} px, cells ×${atlas.cellScale}`],
    ['From cache', atlas.fromCache ? 'yes' : 'no (baked now)'],
    ['Kinds baked', `${atlas.kinds.size}`],
    ['Context lost', gl.isContextLost() ? 'YES' : 'no'],
    ['Pixel ratio', `${window.devicePixelRatio}`],
    ['Screen', `${window.innerWidth}×${window.innerHeight}`],
  ]

  const box = document.createElement('div')
  box.className = 'gldebug'
  box.innerHTML =
    `<h2>GL debug</h2><table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>` +
    `<p>The atlas as the GPU holds it — black or empty here is the bug:</p>`
  const preview = document.createElement('canvas')
  preview.width = 240
  preview.height = 240
  box.appendChild(preview)
  const close = document.createElement('button')
  close.textContent = 'Close'
  close.addEventListener('click', () => box.remove())
  box.appendChild(close)
  parent.appendChild(box)

  // The atlas lives in a render target, so the only way to look at it is to read it back.
  try {
    const rt = atlas.target
    const size = atlas.size
    const ctx = preview.getContext('2d')
    if (!rt || !size || !ctx) return
    const px = new Uint8Array(size * size * 4)
    renderer.readRenderTargetPixels(rt, 0, 0, size, size, px)
    const full = document.createElement('canvas')
    full.width = size
    full.height = size
    full.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px.buffer), size, size), 0, 0)
    // Checkerboard behind it, so transparent and black look different.
    ctx.fillStyle = '#333'
    ctx.fillRect(0, 0, 240, 240)
    ctx.fillStyle = '#666'
    for (let y = 0; y < 240; y += 16) for (let x = (y / 16) % 2 ? 16 : 0; x < 240; x += 32) ctx.fillRect(x, y, 16, 16)
    ctx.drawImage(full, 0, 0, 240, 240)
  } catch (err) {
    box.appendChild(Object.assign(document.createElement('p'), { textContent: `readback failed: ${String(err)}` }))
  }
}
