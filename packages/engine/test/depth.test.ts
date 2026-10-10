import { describe, expect, it } from 'vitest'
import { EventDispatcher, MeshBasicMaterial, WebGLRenderTarget, FloatType, HalfFloatType, type WebGLRenderer } from 'three'
import {
  FAR_PLANE_GLSL,
  composerTarget,
  depthRequestFromURL,
  depthSign,
  forwardDepthInXR,
  hasClipControl,
  installDepthSorts,
  isReversedDepth,
  parseDepthRequest,
  planDepth,
  reversedOpaqueSort,
  reversedTransparentSort,
  setDepthClear,
  setPolygonOffset,
  setReversedDepth,
  shadowBias,
  useFloatDepth,
  type DepthSortItem,
} from '../src/render/depth'

/* A stand-in for the parts of WebGLRenderer the helpers touch: no GPU in a unit test. */
function fakeRenderer(reversed: boolean, capable = reversed) {
  let rev = reversed
  const calls: string[] = []
  let opaque: unknown = 'three-default'
  let transparent: unknown = 'three-default'
  let clear: number | null = null
  const r = {
    capabilities: { reversedDepthBuffer: capable, logarithmicDepthBuffer: false },
    state: {
      buffers: {
        depth: {
          getReversed: () => rev,
          setReversed: (on: boolean) => { calls.push(`setReversed(${on})`); rev = on },
          setClear: (d: number) => { clear = d },
        },
      },
    },
    xr: new EventDispatcher(),
    setOpaqueSort: (f: unknown) => { opaque = f },
    setTransparentSort: (f: unknown) => { transparent = f },
  }
  return {
    r: r as unknown as WebGLRenderer,
    calls,
    get opaque() { return opaque },
    get transparent() { return transparent },
    get clear() { return clear },
    get reversed() { return rev },
  }
}

describe('choosing the depth buffer', () => {
  it('parses a request, and nothing else', () => {
    expect(parseDepthRequest('reversed')).toBe('reversed')
    expect(parseDepthRequest(' LOG ')).toBe('log')
    expect(parseDepthRequest('standard')).toBe('standard')
    expect(parseDepthRequest('auto')).toBe('auto')
    expect(parseDepthRequest('logarithmic')).toBeNull()
    expect(parseDepthRequest('')).toBeNull()
    expect(parseDepthRequest(null)).toBeNull()
    expect(parseDepthRequest(undefined)).toBeNull()
  })

  it('reads ?depth= from a query string, or another parameter', () => {
    expect(depthRequestFromURL('?depth=log')).toBe('log')
    expect(depthRequestFromURL('?x=1&depth=reversed')).toBe('reversed')
    expect(depthRequestFromURL('?depth=nonsense')).toBeNull()
    expect(depthRequestFromURL('')).toBeNull()
    expect(depthRequestFromURL('?z=standard', 'z')).toBe('standard')
  })

  it('auto is reversed with EXT_clip_control and the fallback without', () => {
    expect(planDepth('auto', 'standard', true)).toMatchObject({ reversed: true, log: false })
    expect(planDepth('auto', 'log', true)).toMatchObject({ reversed: true, log: false })
    expect(planDepth('auto', 'standard', false)).toMatchObject({ reversed: false, log: false })
    expect(planDepth('auto', 'log', false)).toMatchObject({ reversed: false, log: true })
  })

  it('an explicit request is passed to three whatever the extension says', () => {
    for (const clip of [true, false]) {
      expect(planDepth('reversed', 'log', clip)).toMatchObject({ reversed: true, log: false })
      expect(planDepth('log', 'standard', clip)).toMatchObject({ reversed: false, log: true })
      expect(planDepth('standard', 'log', clip)).toMatchObject({ reversed: false, log: false })
    }
  })

  it('never asks for log and reversed together, and always says why', () => {
    for (const req of ['auto', 'reversed', 'log', 'standard'] as const)
      for (const fb of ['log', 'standard'] as const)
        for (const clip of [true, false]) {
          const p = planDepth(req, fb, clip)
          expect(p.reversed && p.log).toBe(false)
          expect(p.reason.length).toBeGreaterThan(0)
        }
  })

  it('has no EXT_clip_control where there is no document (node)', () => {
    expect(hasClipControl()).toBe(false)
  })
})

/*
 * THE ORDER THREE ENDS UP DRAWING IN. three's WebGLRenderList.sort: sort with the custom comparator
 * (or its own painter sorts), then — if the camera's depth is reversed — reverse() each list. The
 * test runs the same two steps and asks for the order a FORWARD buffer draws in with three's own
 * sorts: renderOrder ascending, opaque near-to-far, transparent far-to-near.
 */
function painterSortStable(a: DepthSortItem, b: DepthSortItem): number {
  return a.groupOrder !== b.groupOrder ? a.groupOrder - b.groupOrder
    : a.renderOrder !== b.renderOrder ? a.renderOrder - b.renderOrder
    : a.material.id !== b.material.id ? a.material.id - b.material.id
    : (a.materialVariant ?? 0) !== (b.materialVariant ?? 0) ? (a.materialVariant ?? 0) - (b.materialVariant ?? 0)
    : a.z !== b.z ? a.z - b.z
    : a.id - b.id
}
function reversePainterSortStable(a: DepthSortItem, b: DepthSortItem): number {
  return a.groupOrder !== b.groupOrder ? a.groupOrder - b.groupOrder
    : a.renderOrder !== b.renderOrder ? a.renderOrder - b.renderOrder
    : a.z !== b.z ? b.z - a.z
    : a.id - b.id
}
function threeSort(items: DepthSortItem[], cmp: (a: DepthSortItem, b: DepthSortItem) => number, reversed: boolean): number[] {
  const list = [...items].sort(cmp)
  if (reversed) list.reverse()
  return list.map((i) => i.id)
}

/** objects at view distances; z is the NDC depth each buffer would give them */
function scene(): { forward: DepthSortItem[]; reversed: DepthSortItem[] } {
  const near = 0.5
  const far = 3000
  const specs = [
    { id: 1, d: 1200, renderOrder: -1000, mat: 7 }, // a sky dome, first whatever its distance
    { id: 2, d: 5, renderOrder: 0, mat: 3 },
    { id: 3, d: 50, renderOrder: 0, mat: 3 },
    { id: 4, d: 500, renderOrder: 0, mat: 3 },
    { id: 5, d: 20, renderOrder: 0, mat: 9 },
    { id: 6, d: 200, renderOrder: 0, mat: 9 },
    { id: 7, d: 10, renderOrder: 5, mat: 1 }, // drawn last on purpose
    { id: 8, d: 10, renderOrder: -1, mat: 2 }, // a depth-only proxy, before the solids
    { id: 9, d: 50, renderOrder: 0, mat: 3, groupOrder: 1 },
  ]
  // forward NDC z grows with distance; reversed NDC z shrinks with it
  const fz = (d: number) => (far + near) / (far - near) - (2 * far * near) / ((far - near) * d)
  const rz = (d: number) => (near * (far - d)) / (d * (far - near))
  const mk = (z: (d: number) => number) =>
    specs.map((s) => ({ id: s.id, groupOrder: s.groupOrder ?? 0, renderOrder: s.renderOrder, material: { id: s.mat }, materialVariant: 0, z: z(s.d) }))
  return { forward: mk(fz), reversed: mk(rz) }
}

describe('render-list order under a reversed buffer', () => {
  it('sanity: three’s own sorts, reversed, get renderOrder backwards (the bug)', () => {
    const { reversed } = scene()
    const order = threeSort(reversed, painterSortStable, true)
    expect(order[0]).toBe(9) // groupOrder 1 should be LAST; three puts it first
    expect(order.indexOf(1)).toBeGreaterThan(order.indexOf(2)) // the sky after the world
  })

  it('opaque: the reversed comparator, then three’s reverse(), is the forward order', () => {
    const { forward, reversed } = scene()
    const want = threeSort(forward, painterSortStable, false)
    expect(threeSort(reversed, reversedOpaqueSort, true)).toEqual(want)
    // and that order is what it should be: sky first, proxy before solids, renderOrder 5 last of
    // its group, group 1 at the very end, near before far within a material
    expect(want[0]).toBe(1)
    expect(want.indexOf(8)).toBeLessThan(want.indexOf(2))
    expect(want.indexOf(7)).toBe(want.length - 2)
    expect(want[want.length - 1]).toBe(9)
    expect(want.indexOf(2)).toBeLessThan(want.indexOf(3))
    expect(want.indexOf(3)).toBeLessThan(want.indexOf(4))
  })

  it('transparent: back to front, renderOrder first', () => {
    const { forward, reversed } = scene()
    const want = threeSort(forward, reversePainterSortStable, false)
    expect(threeSort(reversed, reversedTransparentSort, true)).toEqual(want)
    const zero = want.filter((id) => [2, 3, 4, 5, 6].includes(id))
    expect(zero).toEqual([4, 6, 3, 5, 2]) // 500, 200, 50, 20, 5 m
  })

  it('installs the comparators only when the buffer is reversed', () => {
    const on = fakeRenderer(true)
    installDepthSorts(on.r)
    expect(on.opaque).toBe(reversedOpaqueSort)
    expect(on.transparent).toBe(reversedTransparentSort)
    const off = fakeRenderer(false)
    installDepthSorts(off.r)
    expect(off.opaque).toBeNull()
    expect(off.transparent).toBeNull()
  })
})

describe('switching depth on a live renderer', () => {
  it('turns reversed off for an XR session and back on after, sorts with it', () => {
    const f = fakeRenderer(true)
    installDepthSorts(f.r)
    const stop = forwardDepthInXR(f.r)
    f.r.xr.dispatchEvent({ type: 'sessionstart' })
    expect(f.reversed).toBe(false)
    expect(f.opaque).toBeNull()
    f.r.xr.dispatchEvent({ type: 'sessionend' })
    expect(f.reversed).toBe(true)
    expect(f.opaque).toBe(reversedOpaqueSort)
    stop()
    f.r.xr.dispatchEvent({ type: 'sessionstart' })
    expect(f.reversed).toBe(true)
  })

  it('will not turn reversed on where the renderer cannot', () => {
    const f = fakeRenderer(false, false)
    setReversedDepth(f.r, true)
    expect(f.calls).toEqual([])
    expect(isReversedDepth(f.r)).toBe(false)
  })
})

describe('window-depth signs', () => {
  it('depthSign is +1 forwards, -1 reversed, +1 with no renderer', () => {
    expect(depthSign(fakeRenderer(false).r)).toBe(1)
    expect(depthSign(fakeRenderer(true).r)).toBe(-1)
    expect(depthSign(null)).toBe(1)
  })

  it('setPolygonOffset writes forward values forwards; reversed it turns only the units (three turns the factor)', () => {
    const m = new MeshBasicMaterial()
    setPolygonOffset(m, fakeRenderer(false).r, 2, 4)
    expect([m.polygonOffset, m.polygonOffsetFactor, m.polygonOffsetUnits]).toEqual([true, 2, 4])
    setPolygonOffset(m, fakeRenderer(true).r, 2, 4)
    expect([m.polygonOffsetFactor, m.polygonOffsetUnits]).toEqual([2, -4])
    setPolygonOffset(m, fakeRenderer(true).r, -3, -3)
    expect([m.polygonOffsetFactor, m.polygonOffsetUnits]).toEqual([-3, 3])
    setPolygonOffset(m, null, -3, -3)
    expect([m.polygonOffsetFactor, m.polygonOffsetUnits]).toEqual([-3, -3])
  })

  it('what reaches GL is the forward offset turned round, both terms, under a reversed buffer', () => {
    // three r185 WebGLState.setPolygonOffset: factor = -factor when reversed; units as given
    const toGL = (m: MeshBasicMaterial, reversed: boolean) => [reversed ? -m.polygonOffsetFactor : m.polygonOffsetFactor, m.polygonOffsetUnits]
    const m = new MeshBasicMaterial()
    setPolygonOffset(m, fakeRenderer(true).r, 2, 4)
    expect(toGL(m, true)).toEqual([-2, -4])
    setPolygonOffset(m, fakeRenderer(false).r, 2, 4)
    expect(toGL(m, false)).toEqual([2, 4])
  })

  it('shadowBias follows the shadow camera three marked', () => {
    expect(shadowBias({ bias: -0.0004, camera: {} })).toBe(-0.0004)
    expect(shadowBias({ bias: -0.0004, camera: { _reversedDepth: false } })).toBe(-0.0004)
    expect(shadowBias({ bias: -0.0004, camera: { _reversedDepth: true } })).toBe(0.0004)
  })

  it('setDepthClear goes through three’s state, not GL', () => {
    const f = fakeRenderer(true)
    setDepthClear(f.r, 0)
    expect(f.clear).toBe(0)
  })
})

describe('FAR_PLANE_GLSL', () => {
  it('puts z at 0 reversed and at w forwards, keyed on three’s define', () => {
    const src = FAR_PLANE_GLSL
    expect(src).toMatch(/vec4 toFarPlane\(vec4 clip\)/)
    const rev = src.indexOf('#ifdef USE_REVERSED_DEPTH_BUFFER')
    const els = src.indexOf('#else')
    const end = src.indexOf('#endif')
    expect(rev).toBeGreaterThan(-1)
    expect(rev).toBeLessThan(els)
    expect(els).toBeLessThan(end)
    expect(src.slice(rev, els)).toContain('vec4(clip.xy, 0.0, clip.w)')
    expect(src.slice(els, end)).toContain('clip.xyww')
  })

  it('has no backtick in it (it lives in template strings)', () => {
    expect(FAR_PLANE_GLSL.includes('`')).toBe(false)
  })
})

describe('float depth for post targets', () => {
  it('composerTarget is undefined forwards and a HalfFloat target with float depth reversed', () => {
    expect(composerTarget(fakeRenderer(false).r, 64, 32)).toBeUndefined()
    const t = composerTarget(fakeRenderer(true).r, 64, 32)!
    expect(t.texture.type).toBe(HalfFloatType)
    expect(t.depthTexture?.type).toBe(FloatType)
    expect([t.width, t.height]).toEqual([64, 32])
  })

  it('useFloatDepth only touches a reversed renderer’s depth-buffered, stencil-free target', () => {
    const rev = fakeRenderer(true).r
    const plain = new WebGLRenderTarget(10, 10, { depthBuffer: true })
    expect(useFloatDepth(plain, rev)).toBe(true)
    expect(plain.depthTexture?.type).toBe(FloatType)
    expect(useFloatDepth(plain, rev)).toBe(false) // already has one
    expect(useFloatDepth(new WebGLRenderTarget(10, 10, { depthBuffer: true }), fakeRenderer(false).r)).toBe(false)
    expect(useFloatDepth(new WebGLRenderTarget(10, 10, { depthBuffer: false }), rev)).toBe(false)
    expect(useFloatDepth(new WebGLRenderTarget(10, 10, { depthBuffer: true, stencilBuffer: true }), rev)).toBe(false)
  })
})
