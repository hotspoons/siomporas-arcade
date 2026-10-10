// Game mode, end to end: the bar is gone, the HUD is there, Escape is a menu that pauses the
// world, the settings are screens in it, a program's policy takes rows away, a double-click on
// the map drops the car, and the developer view is one toggle away.
//
// EVERY CHECK PROVES A MECHANISM. "The menu exists" would pass with the menu permanently on
// screen, so the checks are: the menu is hidden, then Escape shows it AND the car stops ticking,
// then Escape hides it AND the car ticks again. The teleport is checked against the car's
// position before and after, and the policy check is that a row is THERE before it is hidden.
//
//   PORT=5185 node probes/corridor-gamemode.mjs [slug]
import { chromium } from 'playwright'

const slug = process.argv[2] ?? 'crofton-triangle'
const PORT = process.env.PORT ?? '5185'
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 1200, height: 760 } })
const errs = []
p.on('pageerror', (e) => errs.push(e.message.slice(0, 200)))
let fails = 0
const ok = (what, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`); if (!cond) fails++ }
const shown = (sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0 }, sel)
// a hidden menu still holds its last screen's rows in the DOM: they are not "offered"
const labels = () => p.evaluate(() => { const m = document.querySelector('.menu'); if (!m || m.classList.contains('hidden')) return []; return [...m.querySelectorAll('.item .label')].map((l) => l.firstChild?.textContent?.trim() ?? '') })
const selected = () => p.evaluate(() => { const m = document.querySelector('.menu'); if (!m || m.classList.contains('hidden')) return null; return m.querySelector('.item.selected .label')?.firstChild?.textContent?.trim() ?? null })
/** a key, then two frames of the (software-rendered, ~1.5 fps) loop so it has been polled and drawn */
const frames = () => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(0)))))
const key = async (k) => { await p.keyboard.press(k); await frames() }
const to = async (label) => { for (let i = 0; i < 14 && (await selected()) !== label; i++) await key('ArrowDown'); return (await selected()) === label }
const carX = () => p.evaluate(() => window.corridor.car ? { x: window.corridor.car.pos.x, z: window.corridor.car.pos.z } : null)

async function load(query) {
  await p.goto(`http://localhost:${PORT}/#${slug}?lite=1&fresh=1&${query}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await p.waitForFunction(() => !!window.corridor?.site, null, { timeout: 600000 })
  await p.waitForTimeout(1200)
}

/* ---- 1 · game view: the bar is gone, the HUD is on ---- */
await load('ui=game')
ok('body says game-mode', await p.evaluate(() => document.body.classList.contains('game-mode')))
ok('the bar is not drawn', !(await shown('.topbar')))
ok('the search box is not drawn', !(await shown('.search-input')))
ok('the HUD root is on the page', await p.evaluate(() => !document.querySelector('.gamehud').hidden))
ok('the menu is hidden to begin with', !(await shown('.menu')))
ok('chrome.mode reads game', (await p.evaluate(() => window.corridor.chrome.mode)) === 'game')

/* ---- 2 · drive: the dashboard fills in ---- */
await p.keyboard.press('Tab')
await p.waitForTimeout(600)
ok('Tab gets in the car', await p.evaluate(() => window.corridor.drive.on))
await p.keyboard.down('KeyW')
await p.waitForTimeout(1500)
await p.keyboard.up('KeyW')
await p.waitForTimeout(200)
const tele = await p.evaluate(() => ({
  shown: !document.querySelector('.gh-telemetry').hidden,
  speed: document.querySelector('.gh-speed-num').textContent,
  unit: document.querySelector('.gh-speed-unit').textContent,
  gear: document.querySelector('.gh-gear-num').textContent,
  pt: document.querySelector('.gh-heading-pt').textContent,
  deg: document.querySelector('.gh-heading-deg').textContent,
  road: document.querySelector('.gh-road').textContent,
  elev: document.querySelector('.gh-elev').textContent,
  rev: document.querySelector('.gh-rev-fill').style.width,
}))
console.log('    telemetry', JSON.stringify(tele))
ok('the telemetry block is shown while driving', tele.shown)
ok('the speed is a number with a unit', /^\d+$/.test(tele.speed) && tele.unit === 'mph')
ok('the heading is a compass point and degrees', /^[NESW]{1,3}$/.test(tele.pt) && /^\d{3}°$/.test(tele.deg))
ok('the elevation reads in feet', /^\d+ ft$/.test(tele.elev))
ok('the gear is a gear', /^[NR1-6]$/.test(tele.gear))

/* ---- 3 · Escape: the menu, and the world stands still ---- */
const before = await carX()
await p.keyboard.down('KeyW')
await p.keyboard.press('Escape')
await p.waitForTimeout(300)
ok('Escape shows the menu', await shown('.menu'))
ok('…and pauses', await p.evaluate(() => window.corridor.chrome.paused))
ok('…and the body says so', await p.evaluate(() => document.body.classList.contains('paused')))
const rows = await labels()
console.log('    pause menu', JSON.stringify(rows))
for (const want of ['Resume', 'Restart', 'Leave the car', 'Mute', 'Settings', 'Tuning panel', 'Developer view']) ok(`the pause menu has "${want}"`, rows.includes(want))
await p.waitForTimeout(1200)
const during = await carX()
await p.keyboard.up('KeyW')
ok('the car does not move while paused (W held)', before && during && Math.hypot(during.x - before.x, during.z - before.z) < 0.05, `${JSON.stringify(before)} -> ${JSON.stringify(during)}`)

/* ---- 4 · the keys drive the menu; settings are screens ---- */
const sel0 = await selected()
await key('ArrowDown')
const sel1 = await selected()
ok('ArrowDown moves the selection', sel0 !== null && sel1 !== null && sel0 !== sel1, `${sel0} -> ${sel1}`)
ok('the cursor reaches Settings', await to('Settings'))
await key('Enter')
const settingsRows = await labels()
console.log('    settings', JSON.stringify(settingsRows))
for (const want of ['Display', 'Layers', 'Audio', 'Controls', 'Tuning panel']) ok(`settings offers "${want}"`, settingsRows.includes(want))
ok('the cursor reaches Audio', await to('Audio'))
await key('Enter')
const audioRows = await labels()
console.log('    audio', JSON.stringify(audioRows))
for (const want of ['Mute', 'Master', 'Engine', 'Interface']) ok(`audio offers "${want}"`, audioRows.includes(want))
// Mute is the first row: Enter toggles it, and the setting and the engine follow
const mutedBefore = await p.evaluate(() => window.corridor.chrome.settings.data.audio.muted)
for (let i = 0; i < 12 && (await selected()) !== 'Mute'; i++) await key('ArrowUp')
ok('the cursor is on Mute', (await selected()) === 'Mute')
await key('Enter')
const mutedAfter = await p.evaluate(() => ({ setting: window.corridor.chrome.settings.data.audio.muted, engine: window.corridor.audio().muted }))
ok('Enter on Mute flips the setting', mutedAfter.setting === !mutedBefore, JSON.stringify(mutedAfter))
ok('…and the engine is muted', mutedAfter.engine === true || mutedAfter.setting === false)
await key('Enter') // unmute again
ok('…and Enter again unmutes', (await p.evaluate(() => window.corridor.chrome.settings.data.audio.muted)) === mutedBefore)
// Escape backs out ONE screen, not out of the game
await key('Escape')
ok('Escape in a sub-screen steps back (menu still up)', (await shown('.menu')) && (await labels()).includes('Display'))
await key('Escape')
ok('…back to the pause screen', (await labels()).includes('Resume'))
await key('Escape')
ok('Escape on the pause screen resumes', !(await shown('.menu')) && !(await p.evaluate(() => window.corridor.chrome.paused)))

/* ---- 5 · the map: a double-click drops the car; the policy can refuse ---- */
const mm = await p.evaluate(() => { const r = document.querySelector('#minimap canvas').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
const at0 = await carX()
// a spot 40 px up and right of the car's marker (the map follows the car, so the centre is the car)
await p.mouse.dblclick(mm.x + mm.w / 2 + 40, mm.y + mm.h / 2 - 40)
await p.waitForTimeout(400)
const at1 = await carX()
const moved = Math.hypot(at1.x - at0.x, at1.z - at0.z)
ok('a double-click on the map moves the car', moved > 20, `${moved.toFixed(1)} m`)
ok('…and does not expand the map', !(await p.evaluate(() => window.corridor.minimap?.expanded ?? document.querySelector('#minimap').classList.contains('expanded'))))
await p.evaluate(() => window.corridor.chrome.policy.allow('teleport', false))
const at2 = await carX()
await p.mouse.dblclick(mm.x + mm.w / 2 - 40, mm.y + mm.h / 2 + 40)
await p.waitForTimeout(400)
const at3 = await carX()
ok('with teleport refused by the policy the double-click does nothing', Math.hypot(at3.x - at2.x, at3.z - at2.z) < 0.5)
await p.evaluate(() => window.corridor.chrome.policy.allow('teleport', true))

/* ---- 6 · the policy: rows go away, the developer view goes away ---- */
await p.evaluate(() => { window.corridor.chrome.policy.hide('audio', 'display.theme'); window.corridor.chrome.policy.allow('developer', false) })
await key('Escape')
const pauseRows2 = await labels()
ok('with the developer view taken away its row is gone', !pauseRows2.includes('Developer view'), JSON.stringify(pauseRows2))
ok('the cursor reaches Settings again', await to('Settings'))
await key('Enter')
const settingsRows2 = await labels()
ok('the hidden Audio tab is gone from the settings screen', !settingsRows2.includes('Audio') && settingsRows2.includes('Display'), JSON.stringify(settingsRows2))
await key('Enter') // Display, the first row
const displayRows = await labels()
ok('the hidden Theme control is gone from Display, its neighbours are not', !displayRows.includes('Theme') && displayRows.includes('Season'), JSON.stringify(displayRows))
await p.evaluate(() => window.corridor.chrome.policy.reset())
await p.waitForTimeout(200)
ok('reset brings Theme back to the open screen', (await labels()).includes('Theme'))
await p.evaluate(() => window.corridor.chrome.resume())
await p.waitForTimeout(400)
ok('resume() from the surface closes the menu', !(await shown('.menu')) && !(await p.evaluate(() => window.corridor.chrome.paused)))

/* ---- 7 · the Tab (transport) switch can be refused ---- */
await p.evaluate(() => window.corridor.chrome.policy.allow('transport', false))
await key('Tab')
ok('with transport refused, Tab keeps you in the car', await p.evaluate(() => window.corridor.drive.on))
await p.evaluate(() => window.corridor.chrome.policy.allow('transport', true))
await key('Tab')
ok('…and allowed again, Tab gets you out', !(await p.evaluate(() => window.corridor.drive.on)))

/* ---- 8 · the developer view, and the way back ---- */
// the page was opened with ?ui=game: the toggle is still the player's afterwards
await p.evaluate(() => window.corridor.chrome.set('dev'))
await p.waitForTimeout(300)
ok('choosing the developer view brings the bar back (even on a ?ui=game link)', await shown('.topbar'))
ok('…and takes the HUD away', await p.evaluate(() => document.querySelector('.gamehud').hidden))
await key('Escape')
ok('Escape in the developer view opens the same menu', await shown('.menu'))
await key('Escape')
await p.evaluate(() => window.corridor.chrome.set('game'))
await p.waitForTimeout(200)
ok('…and back to the game view hides the bar again', !(await shown('.topbar')))

/* ---- 9 · a fresh load without ?ui= on the dev server is the developer view ---- */
await load('nothing=1')
const chosen = await p.evaluate(() => window.corridor.chrome.mode)
console.log('    a plain load chooses', chosen, '(the player chose game above, so it is remembered)')
ok('the remembered choice is honoured', chosen === 'game')
await p.evaluate(() => window.corridor.chrome.set('dev')) // leave the browser as it was
await p.waitForTimeout(100)

if (errs.length) { console.log('page errors:', errs); fails++ }
console.log(fails ? `FAIL ${fails}` : 'PASS')
await b.close()
process.exit(fails ? 1 : 0)
