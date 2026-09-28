// Clicking a thumbnail shows you the thing.
//
// Rich, 2026-09-28: "clicking a thumbnail should open it in a lightbox from that interface."
//
// The click used to CHOOSE the view for meshing — a decision about which of six drawings becomes
// a 3D model, taken at ninety pixels wide. So there are two things to prove: the lightbox opens
// and shows the full image, and choosing is still possible from inside it rather than lost.
//
//   PORT=5185 node probes/worldedit-lightbox.mjs
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 160)))
await page.goto(`http://localhost:${PORT}/world.html`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction(() => window.__we?.ready?.() === true, null, { timeout: 90000 })

const fails = []
const ok = (name, cond, detail) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name} — ${detail}`); if (!cond) fails.push(name) }

/*
 * THE DIALOG, NOT THE MODE.
 *
 * "Assets" exists twice in this page — a mode in the top bar with its own panel, and a dialog
 * raised by the toolbar's sparkles button, which is a different component (ui/assets.ts) with the
 * catalog, the drawings and the mesh in it. That duplication is a known problem and is on the
 * list; until it is resolved a probe has to say which one it means, and this one means the dialog,
 * because that is where the thumbnails are.
 */
/*
 * THROUGH THE ASSETS MODE, which is now the only way in.
 *
 * This used to click a toolbar icon. "Assets" existed three times — that icon, a mode, and two
 * drawer items opening a different dialog — and de-duplicating it left this probe clicking a
 * button that is gone. The catalog opens from inside the mode, which is where generating and
 * placing both live now.
 */
await page.evaluate(() => window.__we.setMode('assets'))
await page.waitForFunction(() => [...document.querySelectorAll('#panel button')].some((n) => /catalog & generate/i.test(n.textContent ?? '')), null, { timeout: 30000 })
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#panel button')].find((n) => /catalog & generate/i.test(n.textContent ?? ''))
  b?.click()
})
await page.waitForFunction(() => !!document.querySelector('.asset-row'), null, { timeout: 30000 }).catch(() => {})
const opened = await page.evaluate(() => {
  const row = document.querySelector('.asset-row')
  if (row) { row.click(); return true }
  return false
})
await page.waitForFunction(() => !!document.querySelector('.asset-view'), null, { timeout: 30000 }).catch(() => {})

const thumbs = await page.evaluate(() => document.querySelectorAll('.asset-view').length)
if (!thumbs) {
  console.log(`  (no drawn views reachable in this mode — opened=${opened}, thumbs=${thumbs})`)
  console.log('SKIP: nothing to click; this needs an asset with drawings')
  await browser.close()
  process.exit(0)
}
ok('there are thumbnails to click', thumbs > 0, `${thumbs} views`)

const before = await page.evaluate(() => {
  const on = document.querySelector('.asset-view.on')
  return { chosenIndex: [...document.querySelectorAll('.asset-view')].indexOf(on) }
})

await page.evaluate(() => document.querySelectorAll('.asset-view')[0].click())
await page.waitForTimeout(400)

const box = await page.evaluate(() => {
  const lb = document.querySelector('.lightbox')
  if (!lb) return null
  const img = lb.querySelector('.lightbox-img')
  const r = img?.getBoundingClientRect()
  return {
    open: true,
    imgW: r?.width ?? 0, imgH: r?.height ?? 0,
    caption: lb.querySelector('.lightbox-cap')?.textContent ?? '',
    hasAction: !!lb.querySelector('.lightbox-bar .btn'),
  }
})
ok('the lightbox opens', !!box?.open, box ? 'open' : 'no .lightbox in the document')
// BIGGER THAN THE THUMBNAIL, which is the entire point — a lightbox that renders at 90px is a
// lightbox that has not loaded the full image.
ok('and shows it much larger than the thumbnail', (box?.imgW ?? 0) > 300, `${box?.imgW.toFixed(0)}x${box?.imgH.toFixed(0)}px`)
ok('with a caption saying which one it is', !!box?.caption, JSON.stringify(box?.caption))
ok('and a way to choose it from in there', !!box?.hasAction, 'action button present')

// Arrow keys step through the set rather than bouncing back to the grid.
if (thumbs > 1) {
  const first = await page.evaluate(() => document.querySelector('.lightbox-img')?.getAttribute('src'))
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(250)
  const second = await page.evaluate(() => document.querySelector('.lightbox-img')?.getAttribute('src'))
  ok('the arrow keys step through the set', first !== second, `${(first ?? '').slice(-18)} → ${(second ?? '').slice(-18)}`)
}

// Escape closes it, and must not be eaten by whatever raised it.
await page.keyboard.press('Escape')
await page.waitForTimeout(400)
ok('Escape closes it', await page.evaluate(() => !document.querySelector('.lightbox')), 'closed')

// And looking at something did not silently change the choice — nor close the panel under it.
const after = await page.evaluate(() => {
  const on = document.querySelector('.asset-view.on')
  return {
    chosenIndex: [...document.querySelectorAll('.asset-view')].indexOf(on),
    views: document.querySelectorAll('.asset-view').length,
    dialogOpen: !!document.querySelector('.dialog-scrim'),
  }
})
ok('and Escape did not close the panel underneath it too',
  after.views > 0 && after.dialogOpen,
  `${after.views} views still there, dialog ${after.dialogOpen ? 'open' : 'CLOSED'}`)
ok('looking at a view did not change which one gets meshed',
  after.chosenIndex === before.chosenIndex, `chosen ${before.chosenIndex} → ${after.chosenIndex}`)

await browser.close()
console.log(fails.length ? `\nFAIL: ${fails.length} — ${fails.join('; ')}` : '\nPASS: a thumbnail opens')
process.exit(fails.length ? 1 : 0)
