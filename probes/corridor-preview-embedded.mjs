// The preview, in the EMBEDDED editor — where the canvas is a pane, not the window.
//
// Rich, 2026-09-29: "the dark mask and blur is over top of the preview and the main editor … half
// the screen is covered". The preview clipped its canvas and set its GL viewport in WINDOW
// coordinates, which is the same thing as canvas coordinates only when the canvas fills the window.
// Embedded in the world editor it does not, so the whole thing came out offset and clipped.
//
// The check therefore has to run on `world.html` — on `editor.html` the two frames coincide and a
// broken version passes.
import { chromium } from 'playwright'

const SLUG = process.env.SLUG ?? 'bowie-racetrack-rd'
/*
 * THE STANDALONE EDITOR, WITH ITS CANVAS SHRUNK INTO A PANE.
 *
 * The bug only exists when the canvas does not fill the window, which is the embedded case — but
 * driving the world editor's own UI to reach the site editor is a lot of clicking for a test about
 * two rectangles. Shrinking the canvas reproduces the exact condition (`canvas box ≠ window box`)
 * on a page this probe can already load, and the assertion below refuses to run unless it took.
 */
const URL = process.env.EDITOR ?? 'http://127.0.0.1:5185/editor.html'

const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 1100, height: 760 } })
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)))
let bad = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }

await p.goto(`${URL}#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.corridor?.site, null, { timeout: 240000 }).catch(() => {})
await p.waitForTimeout(8000)

// make the canvas a pane: a bar above it and an inspector beside it, as the world editor does
await p.evaluate(() => {
  const c = document.querySelector('canvas#gl') ?? document.querySelector('canvas')
  c.style.position = 'absolute'
  c.style.left = '180px'
  c.style.top = '64px'
  c.style.width = 'calc(100% - 420px)'
  c.style.height = 'calc(100% - 128px)'
  dispatchEvent(new Event('resize'))
})
await p.waitForTimeout(1500)

const ready = await p.evaluate(() => !!window.corridor?.site)
check(ready, 'the embedded site editor loaded')
if (!ready) { console.log('FAILED (could not reach the editor)'); await b.close(); process.exit(1) }

const framed = await p.evaluate(() => {
  const c = document.querySelector('canvas#gl') ?? document.querySelector('canvas')
  const r = c.getBoundingClientRect()
  return { canvas: { x: r.x, y: r.y, w: r.width, h: r.height }, window: { w: innerWidth, h: innerHeight } }
})
console.log('frames', JSON.stringify(framed))
/*
 * THE PRECONDITION. If the canvas happens to fill the window then this probe cannot tell a fixed
 * preview from a broken one, and a pass would mean nothing.
 */
check(framed.canvas.x > 1 || framed.canvas.y > 1 || framed.canvas.w < framed.window.w - 1,
  'the canvas is a PANE, not the window — so this test can see the bug')

await p.evaluate(() => window.corridor.preview.show(window.corridor.site, 'summer'))
await p.waitForTimeout(3000)

const geom = await p.evaluate(() => {
  const c = document.querySelector('canvas#gl') ?? document.querySelector('canvas')
  const cr = c.getBoundingClientRect()
  const vr = document.querySelector('.pv-view').getBoundingClientRect()
  // what the clip-path actually says, in the canvas's own frame
  /*
   * `inset()` IS A BOX SHORTHAND, and the browser collapses it: `inset(71px 22px 106px 22px)` comes
   * back as `inset(71px 22px 106px)` the moment left and right agree. A four-value regex reports
   * "the canvas is not clipped" about a canvas that is perfectly clipped.
   */
  const raw = c.style.clipPath || getComputedStyle(c).clipPath || ''
  const nums = [...raw.matchAll(/(-?[\d.]+)px/g)].map((x) => +x[1])
  const box = (v) => v.length === 1 ? [v[0], v[0], v[0], v[0]]
    : v.length === 2 ? [v[0], v[1], v[0], v[1]]
    : v.length === 3 ? [v[0], v[1], v[2], v[1]]
    : v.slice(0, 4)
  const b = nums.length ? box(nums) : null
  const inset = b ? { top: b[0], right: b[1], bottom: b[2], left: b[3] } : null
  return {
    canvas: { x: cr.x, y: cr.y, w: cr.width, h: cr.height },
    view: { x: vr.x, y: vr.y, w: vr.width, h: vr.height },
    inset, raw,
    // where the clip puts the visible window, back in page coordinates
    clipped: inset ? { x: cr.x + inset.left, y: cr.y + inset.top, w: cr.width - inset.left - inset.right, h: cr.height - inset.top - inset.bottom } : null,
    open: window.corridor.preview.open,
  }
})
console.log('preview', JSON.stringify(geom, null, 1))

/*
 * AND IT MUST BE ABOVE THE GLASS.
 *
 * `.preview` is a full-screen scrim with `background: var(--scrim)` and `backdrop-filter:
 * blur(6px)`; the canvas is lifted over it so the preview is drawn at full strength while the
 * surround stays dark. The lift was the literal `21` against a `--z-modal` of `50`, so the canvas
 * sat UNDER the very backdrop it was meant to clear and the whole preview came out dark and soft.
 * Nothing about that looks like a failure — it renders, it is just behind the glass.
 */
const stack = await p.evaluate(() => {
  const c = document.querySelector('canvas#gl') ?? document.querySelector('canvas')
  const pv = document.querySelector('.preview')
  const num = (el) => Number(getComputedStyle(el).zIndex) || 0
  return {
    canvas: num(c),
    scrim: num(pv),
    filter: getComputedStyle(pv).backdropFilter,
    bar: num(document.querySelector('.pv-bar')),
  }
})
console.log('stacking', JSON.stringify(stack))
check(stack.canvas > stack.scrim, `the canvas is above the scrim (${stack.canvas} against ${stack.scrim})`)
check(stack.bar > stack.canvas, `and the toolbar is above the canvas (${stack.bar})`)

/*
 * AND THE WHOLE WINDOW SITS ON THE CANVAS. `.preview` is `inset: 0` — the page — while the canvas
 * stops at the inspector, so the right-hand strip of the preview had nothing underneath it to
 * reveal and you saw the panel through the scrim.
 */
const framed2 = await p.evaluate(() => {
  const c = (document.querySelector('canvas#gl') ?? document.querySelector('canvas')).getBoundingClientRect()
  const d = document.querySelector('.preview').getBoundingClientRect()
  const v = document.querySelector('.pv-view').getBoundingClientRect()
  return {
    dialog: { x: d.x, y: d.y, w: d.width, h: d.height },
    canvas: { x: c.x, y: c.y, w: c.width, h: c.height },
    viewInsideCanvas: v.left >= c.left - 0.5 && v.right <= c.right + 0.5 && v.top >= c.top - 0.5 && v.bottom <= c.bottom + 0.5,
  }
})
console.log('framing', JSON.stringify(framed2))
check(Math.abs(framed2.dialog.x - framed2.canvas.x) < 1 && Math.abs(framed2.dialog.w - framed2.canvas.w) < 1,
  'the preview window is framed to the canvas, not to the page')
check(framed2.viewInsideCanvas, 'so every pixel of the viewport has canvas under it')
check(geom.open, 'the preview opened')
check(!!geom.inset, 'the canvas is clipped to a hole')
if (geom.clipped) {
  const off = Math.max(Math.abs(geom.clipped.x - geom.view.x), Math.abs(geom.clipped.y - geom.view.y))
  const size = Math.max(Math.abs(geom.clipped.w - geom.view.w), Math.abs(geom.clipped.h - geom.view.h))
  check(off < 2, `the visible hole is where the preview viewport is (${off.toFixed(1)} px out)`)
  check(size < 2, `and the same size as it (${size.toFixed(1)} px out)`)
}

/*
 * NO SCREENSHOT. The checks above are rectangles and they are the whole point; a picture of the
 * preview adds nothing to them and is the first thing to time out when this box is short of
 * memory, turning a passing run into a failing one for a reason that is not about the code.
 */
console.log(bad ? `FAILED (${bad})` : 'OK')
await b.close()
process.exit(bad ? 1 : 0)
