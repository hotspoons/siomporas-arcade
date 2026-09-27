// Renderer settings that have to be decided BEFORE the WebGL context exists.
//
// Anti-aliasing is the whole reason this file exists. MSAA is a context
// attribute: it cannot be toggled on a live renderer, only chosen when the
// context is created. So it cannot live in the tuning panel with the things
// that can be nudged while you watch them — it needs somewhere it can be set
// and then take effect on the next load.
//
// WHY IT MATTERS HERE. Spark asks for `antialias: false` ("WebGL anti-aliasing
// doesn't improve Gaussian Splatting rendering and significantly reduces
// performance") and on this hardware it is not a small effect. Measured at the
// Gosheff stance with a capture attached:
//
//     antialias: true    p50 29.4 ms   p90 42.9   p99 135.5   18 stalls
//     antialias: false   p50 16.7 ms   p90 18.4   p99  23.7    0 stalls
//
// — and the second row had 62% MORE gaussians resident. Spark sorts in a
// worker, so the stall was never the sort; it is the synchronous GPU work
// around it, which MSAA makes expensive.
//
// AND WHY IT IS NOT FREE. Turning MSAA off makes the procedural world sparkle,
// most visibly in grass. That is not ordinary edge aliasing: the viewer
// dissolves tree impostors and the splat seam with a SCREEN-DOOR DITHER
// (scene.ts, splatmask.ts) precisely because hundreds of thousands of
// alpha-blended fragments cannot be depth-sorted — and MSAA was quietly
// smoothing that dither. Remove it and the pattern is visible as shimmer.
//
// So this is a genuine trade and the default is `auto`: keep MSAA for the
// procedural world, drop it on sites where a capture is attached and the
// stalls would otherwise be felt.

export type AAMode = 'auto' | 'msaa' | 'fxaa' | 'smaa' | 'off'

const MODE_KEY = 'corridor.aa'
const CAPTURE_KEY = 'corridor.captureSites'

/** `?aa=0` / `?aa=1` win over the stored setting, for a one-off A/B. */
function fromUrl(): AAMode | null {
  const v = new URLSearchParams(location.search).get('aa')
  if (v === '0' || v === 'off') return 'off'
  if (v === '1' || v === 'on' || v === 'msaa') return 'msaa'
  if (v === 'fxaa' || v === 'smaa' || v === 'auto') return v
  return null
}

export function aaMode(): AAMode {
  return fromUrl() ?? ((localStorage.getItem(MODE_KEY) as AAMode | null) ?? 'auto')
}

export function setAAMode(m: AAMode) {
  localStorage.setItem(MODE_KEY, m)
}

/** Is the stored mode being overridden by the URL right now? */
export function aaOverriddenByUrl(): boolean {
  return fromUrl() !== null
}

function captureSites(): string[] {
  try {
    return JSON.parse(localStorage.getItem(CAPTURE_KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}

/**
 * Remember that this site had a capture attached.
 *
 * `auto` has to answer "does this site have a capture?" BEFORE the renderer is
 * built, which is before anything has been fetched. Rather than block startup
 * on a network round trip, it answers from what the last visit saw. The cost is
 * that the FIRST ever load of a capture site still gets MSAA; the second is
 * right. The alternative — an await before the context — buys one load at the
 * price of delaying every other site's first frame.
 */
export function noteCaptureAttached(slug: string) {
  const s = captureSites()
  if (s.includes(slug)) return
  s.push(slug)
  localStorage.setItem(CAPTURE_KEY, JSON.stringify(s.slice(-64)))
}

export function siteHasCapture(slug: string): boolean {
  return captureSites().includes(slug)
}

/** What to pass to WebGLRenderer for this site. */
/**
 * Resolve `auto` for this site.
 *
 * MSAA is the best-looking option and the one that costs ~135 ms of stall per
 * splat sort. Post-process AA costs about a millisecond and does not touch
 * Spark's path at all, so on a site with a capture it is strictly the better
 * trade -- and it also smooths the screen-door dither, which MSAA was doing by
 * accident and which is what sparkles in grass when AA is simply removed.
 */
export function resolvedAA(slug: string): Exclude<AAMode, 'auto'> {
  const m = aaMode()
  if (m !== 'auto') return m
  return siteHasCapture(slug) ? 'fxaa' : 'msaa'
}

/** MSAA is a context attribute, so it is the only mode decided before startup. */
export function antialiasFor(slug: string): boolean {
  return resolvedAA(slug) === 'msaa'
}

/** Post-process AA can be switched at any time; MSAA cannot. */
export function postAAFor(slug: string): 'fxaa' | 'smaa' | null {
  const m = resolvedAA(slug)
  return m === 'fxaa' || m === 'smaa' ? m : null
}

/** The slug the page is about to load, as main.ts resolves it. */
export function bootSlug(): string {
  try {
    const p = new URLSearchParams(location.search).get('stance')
    if (p) {
      const s = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')))?.site
      if (typeof s === 'string' && s) return s
    }
  } catch {
    /* a malformed stance must not stop the page booting */
  }
  return location.hash.slice(1)
}
