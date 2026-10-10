// The finish screen, end to end: a program that pays and then finishes puts the car on a
// turntable with the winnings counted up; Restart runs the program's setup again from a zero clock;
// Escape is "Exit to menu" and lands on the Escape menu's root, with the level select on it; and
// the same run ending on foot (or asking for 'character') puts the figure there instead.
//
// THE LEVEL AND THE PROGRAM ARE THE PROBE'S OWN, served by routes — nothing is written to any
// world editor. The program is plain JS (what `?js=1` would hand back), switched between runs by
// changing what the route serves and pressing Restart, which fetches it again.
//
// EVERY CHECK PROVES A MECHANISM: the screen is hidden before the finish; the world's draw calls
// stop under it (counted before and after); the count-up lands on the total the program reported;
// Restart is a second `setup` and a clock under a second; the turntable says what it holds.
//
//   PORT=5198 OUT=/tmp/shots node probes/corridor-finish.mjs [slug]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const slug = process.argv[2] ?? 'crofton-triangle'
const PORT = process.env.PORT ?? '5198'
const OUT = process.env.OUT ?? '/tmp/corridor-finish'
mkdirSync(OUT, { recursive: true })

/**
 * The probe's program: a bonus at the start, two "hits" at the end, and it finishes when the probe
 * sets `window.__finishGo` — on the probe's clock, not the run's, because under software GL one
 * frame can be seconds of run time and a timed finish lands before the probe has looked.
 */
const program = ({ show, walk = false }) => `
import { defineGame } from '@apex/program'
export default defineGame({
  setup(api) {
    window.__finishSetups = (window.__finishSetups ?? 0) + 1
    api.ui.mode('game')
    ${walk ? "api.transport('walk')" : "api.transport('drive')"}
    api.score.currency('$')
    api.score.add(500, 'Time bonus')
    api.each(() => {
      if (!window.__finishGo) return
      window.__finishGo = false
      api.score.add(20, 'Hits')
      api.score.add(20, 'Hits')
      api.finish({
      title: 'Probe run',
      text: 'Paid for every hit, then a bonus for being on time.',
      stats: [{ label: 'Deliveries', value: '5/5' }, { label: 'Top speed', value: '88 mph' }],
      ${show ? `show: '${show}',` : ''}
      })
    })
  },
})
`
let js = program({})

const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 1280, height: 760 } })
const errs = []
p.on('pageerror', (e) => errs.push(e.message.slice(0, 300)))
await p.route('**/api/levels', (r) => r.fulfill({ json: { levels: [
  { id: 'finish-probe', world: slug, name: 'Finish probe' },
  { id: 'finish-probe-2', world: slug, name: 'Another stage' },
] } }))
await p.route('**/api/levels/finish-probe', (r) => r.fulfill({ json: { id: 'finish-probe', world: slug, name: 'Finish probe', program: 'probe/finish.ts' } }))
await p.route('**/api/programs/probe/finish.ts?js=1', (r) => r.fulfill({ json: { js, errors: [] } }))

let fails = 0
const ok = (what, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`); if (!cond) fails++ }
const frames = (n = 2) => p.evaluate((n) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? r(0) : requestAnimationFrame(f)); requestAnimationFrame(f) }), n)
const fin = () => p.evaluate(() => {
  const f = window.corridor.finish
  const root = document.querySelector('.finish')
  return {
    open: f.open, buttons: f.buttons, draws: f.draws, result: f.result,
    show: root?.dataset.show ?? null, counted: root?.classList.contains('counted') ?? false,
    total: document.querySelector('.fin-total-num')?.textContent ?? '',
    lines: [...document.querySelectorAll('.fin-line')].map((l) => l.textContent),
    selected: document.querySelector('.fin-btn.selected')?.dataset.id ?? null,
    visible: !!root && !root.hidden && root.getBoundingClientRect().height > 0,
  }
})
/** frame-to-frame ms over n frames, sorted — the software renderer's own clock */
const frameMs = (n) => p.evaluate((n) => new Promise((r) => {
  const ts = []
  const f = (t) => { ts.push(t); if (ts.length > n) r(ts.slice(1).map((x, i) => x - ts[i]).sort((a, b) => a - b)); else requestAnimationFrame(f) }
  requestAnimationFrame(f)
}), n)
const pct = (a, q) => a[Math.min(a.length - 1, Math.floor(q * a.length))].toFixed(0)
const waitFinish = async () => {
  await p.evaluate(() => { window.__finishGo = true })
  await p.waitForFunction(() => window.corridor.finish.open && document.querySelector('.finish.counted'), null, { timeout: 240000 })
  await frames(2)
  return fin()
}

/* ---- 1 · the run, driving: the screen is not up until the program finishes ---- */
await p.goto(`http://127.0.0.1:${PORT}/?lite=1&fresh=1&ui=game&level=finish-probe#${slug}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.corridor?.site && !!window.corridor?.game, null, { timeout: 600000 })
ok('the screen is hidden while the run is on', !(await fin()).visible)
const world = await p.evaluate(() => ({ calls: window.corridor.renderer.info.render.calls, tris: window.corridor.renderer.info.render.triangles }))
await p.waitForTimeout(3000)
const worldMs = await frameMs(20)

let f = await waitFinish()
ok('the finish screen is up', f.visible && f.open)
ok('it holds the car (driving, no show given)', f.show === 'car', f.show)
const want = f.result?.winnings
ok('the result carries the winnings', !!want && want.currency === '$' && want.total === 500 + 20 * (want.lines.find((l) => l.label === 'Hits')?.count ?? -1), JSON.stringify(want))
ok('the count-up landed on the total', f.total === `$${want.total.toLocaleString('en-US')}`, `${f.total} vs ${want?.total}`)
ok('the breakdown is listed', f.lines.length === 2 && f.lines.some((l) => /Hits ×\d+/.test(l)) && f.lines.some((l) => /Time bonus\$500/.test(l)), f.lines.join(' | '))
ok('the buttons are Restart and Exit (no next stage named)', JSON.stringify(f.buttons) === '["restart","exit"]', f.buttons.join(','))
ok('the turntable is drawn: backdrop + car', f.draws.calls >= 2, JSON.stringify(f.draws))
ok('the world is not drawn under it', f.draws.calls < world.calls / 4, `${f.draws.calls} calls vs the world's ${world.calls}`)
await p.waitForTimeout(3000)
const finMs = await frameMs(20)
console.log(`     frame ms (swiftshader): world p50 ${pct(worldMs, 0.5)} p95 ${pct(worldMs, 0.95)} · finish p50 ${pct(finMs, 0.5)} p95 ${pct(finMs, 0.95)}; draws world ${world.calls} calls / ${world.tris} tris, finish ${f.draws.calls} / ${f.draws.triangles}`)
await p.screenshot({ path: `${OUT}/finish-car.png`, timeout: 180000 })
// the turntable turns: two frames apart, the pixels in the car's half differ
const spin = await p.evaluate(async () => {
  const c = document.querySelector('canvas')
  const grab = () => { const g = document.createElement('canvas'); g.width = 96; g.height = 64; const x = g.getContext('2d'); x.drawImage(c, c.width * 0.15, c.height * 0.25, c.width * 0.4, c.height * 0.5, 0, 0, 96, 64); return x.getImageData(0, 0, 96, 64).data }
  await new Promise((r) => requestAnimationFrame(r))
  const a = grab()
  await new Promise((r) => setTimeout(r, 1500))
  await new Promise((r) => requestAnimationFrame(r))
  const b2 = grab()
  let d = 0
  for (let i = 0; i < a.length; i += 4) d += Math.abs(a[i] - b2[i]) + Math.abs(a[i + 1] - b2[i + 1]) + Math.abs(a[i + 2] - b2[i + 2])
  return d / (a.length / 4)
})
ok('the turntable turns', spin > 0.5, `mean pixel change ${spin.toFixed(2)}`)

/* ---- 2 · the keys: arrows move, Enter on Restart restarts ---- */
await p.keyboard.press('ArrowRight'); await frames()
ok('→ moves the selection to Exit', (await fin()).selected === 'exit')
await p.keyboard.press('ArrowLeft'); await frames()
ok('← moves it back to Restart', (await fin()).selected === 'restart')
const setups0 = await p.evaluate(() => window.__finishSetups)
await p.keyboard.press('Enter')
await p.waitForFunction((n) => window.__finishSetups === n + 1, setups0, { timeout: 60000 })
await frames(1)
const after = await p.evaluate(() => ({ open: window.corridor.finish.open, t: window.corridor.game?.facts().time ?? -1, outcome: window.corridor.game?.outcome ?? null, paused: window.corridor.chrome.paused, finishedClass: document.body.classList.contains('finished') }))
ok('Restart ran the setup again', (await p.evaluate(() => window.__finishSetups)) === setups0 + 1)
ok('…on a fresh clock, unfinished, the world running', !after.open && after.t >= 0 && after.t < 2 && after.outcome === null && !after.paused && !after.finishedClass, JSON.stringify(after))

/* ---- 3 · Exit to menu: Escape on the screen is the menu's root, with the level select ---- */
f = await waitFinish()
ok('it finished again after the restart', f.open && f.show === 'car')
ok('…with the score from nothing again', f.result?.winnings?.total === 540, JSON.stringify(f.result?.winnings))
await p.keyboard.press('Escape'); await frames()
const menu = await p.evaluate(() => {
  const m = document.querySelector('.menu')
  return { shown: !!m && !m.classList.contains('hidden'), title: m?.querySelector('h1')?.textContent ?? '', items: [...(m?.querySelectorAll('.item .label') ?? [])].map((l) => l.firstChild?.textContent?.trim() ?? '') }
})
ok('Escape took the screen down', !(await fin()).visible)
ok('…and opened the menu at its root', menu.shown && menu.title === 'Paused', JSON.stringify(menu))
ok('…which offers the level select', menu.items.includes('Levels'), menu.items.join(', '))
await p.screenshot({ path: `${OUT}/finish-exit-menu.png`, timeout: 180000 })

/* ---- 4 · show: 'character', from the menu's Restart ---- */
js = program({ show: 'character' })
await p.evaluate(() => window.corridor.chrome.menu.stack.current.items.find((i) => i.label === 'Restart').onSelect())
f = await waitFinish()
ok("show: 'character' puts the figure on the turntable", f.show === 'character', f.show)
ok('…and it is drawn', f.draws.calls >= 3, JSON.stringify(f.draws))
await p.screenshot({ path: `${OUT}/finish-character.png`, timeout: 180000 })

/* ---- 5 · on foot with nothing said: the character by default ---- */
js = program({ walk: true })
await p.evaluate(() => window.corridor.finish.choose('restart'))
f = await waitFinish()
ok('on foot, the default is the character', f.show === 'character', f.show)
await p.screenshot({ path: `${OUT}/finish-onfoot.png`, timeout: 180000 })

/* ---- 6 · a phone-shaped screen: the panel goes to the bottom, nothing scrolls sideways ---- */
await p.setViewportSize({ width: 390, height: 844 })
await frames(3)
const tall = await p.evaluate(() => {
  const r = document.querySelector('.fin-panel').getBoundingClientRect()
  return { bottom: Math.round(innerHeight - r.bottom), left: Math.round(r.left), right: Math.round(innerWidth - r.right), scrollW: document.documentElement.scrollWidth, w: innerWidth }
})
ok('tall: the panel sits along the bottom inside the gutters', tall.bottom < 40 && tall.left >= 12 && tall.right >= 12 && tall.scrollW <= tall.w, JSON.stringify(tall))
await p.screenshot({ path: `${OUT}/finish-phone.png`, timeout: 180000 })

ok('no page errors', errs.length === 0, errs.join(' | '))
console.log(fails ? `${fails} FAILED` : 'all ok')
await b.close()
process.exit(fails ? 1 : 0)
