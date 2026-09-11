#!/usr/bin/env node
// Headless verification of the arcade shell: the contract between the shell and a game module.
// `just smoke` checks that a game plays; this checks that games can be mounted, walked away from
// and mounted again without the page filling up with dead renderers.
//
//   just dev arcade      # in one terminal
//   just arcade-smoke    # in another
//
// Three things, in order:
//
//   routes   the URL is the app's state — a nested menu is a history entry, Back escapes one
//            level at a time, Forward retraces, a deep link boots into the right game, and an
//            address naming no game lands in the lobby.
//   leaks    mount and unmount all three games ROUNDS times over. What must not grow: live
//            canvases, unclosed AudioContexts, the JS heap. This is the check that a `dispose()`
//            somewhere has quietly stopped matching its constructor.
//   play     start a run in each game from inside the arcade and confirm the sim actually moved,
//            because a game can mount cleanly and still be a black rectangle.
//
// ARCADE_URL overrides the target; ROUNDS the number of mount cycles.

import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const url = process.env.ARCADE_URL ?? 'http://localhost:5183'
const rounds = Number(process.env.ROUNDS ?? 2)
const outDir = 'shots'
const GAMES = ['radrun', 'stuntin', 'apex']

const errors = []
const note = (s) => console.log('  ' + s)

const browser = await chromium.launch({
  // SwiftShader: the container has no GPU, and WebGL must still initialise.
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--enable-precise-memory-info', '--js-flags=--expose-gc'],
})
const page = await browser.newPage({ viewport: { width: 1100, height: 640 } })
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`)
})
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

// Count AudioContexts by wrapping the constructor before any app code runs. A game that leaves one
// open is invisible until the fifth game a player starts has no sound: browsers cap them per page.
await page.addInitScript(() => {
  window.__audio = { made: 0, closed: 0 }
  const Real = window.AudioContext
  window.AudioContext = class extends Real {
    constructor(...a) {
      super(...a)
      window.__audio.made++
    }
    close() {
      window.__audio.closed++
      return super.close()
    }
  }
})

const state = () =>
  page.evaluate(() => ({
    url: location.pathname,
    mount: document.querySelector('.arcade-mount')?.dataset.game ?? null,
    menu: document.querySelector('.menu:not(.hidden) h1')?.textContent ?? null,
  }))

const census = () =>
  page.evaluate(() => {
    if (window.gc) window.gc()
    return {
      canvases: document.querySelectorAll('canvas').length,
      audioOpen: window.__audio.made - window.__audio.closed,
      heapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1),
    }
  })

/** Navigate the way the shell does, without a page load. */
const go = async (path, settle = 7000) => {
  await page.evaluate((p) => {
    history.pushState({ apex: true }, '', p)
    dispatchEvent(new PopStateEvent('popstate'))
  }, path)
  await page.waitForTimeout(settle)
}

const expect = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  note(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n      wanted ${JSON.stringify(want)}\n      got    ${JSON.stringify(got)}`}`)
  if (!ok) errors.push(`${label}: wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
}

try {
  mkdirSync(outDir, { recursive: true })
  await page.goto(url, { waitUntil: 'load', timeout: 40_000 })
  // The lobby loads three cabinet textures and compiles a post stack before it is worth looking at.
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(4000)
  await page.screenshot({ path: `${outDir}/arcade-lobby.png` })

  // --- routes ---------------------------------------------------------------
  console.log('routes')
  expect('lobby at /', await state(), { url: '/', mount: 'lobby', menu: null })

  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(700)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(8000)
  expect('Enter on the 2nd cabinet enters it', await state(), { url: '/stuntin', mount: 'stuntin', menu: 'STUNTIN' })

  // Open a nested menu by clicking its row, whatever position it is in.
  const opened = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.menu .item')].find((r) => /SETTINGS/.test(r.textContent || ''))
    row?.click()
    return Boolean(row)
  })
  if (!opened) errors.push('no SETTINGS row on the title menu')
  await page.waitForTimeout(1200)
  expect('a nested menu is a path', await state(), { url: '/stuntin/settings', mount: 'stuntin', menu: 'SETTINGS' })

  await page.goBack()
  await page.waitForTimeout(1500)
  expect('Back escapes the menu, not the game', await state(), { url: '/stuntin', mount: 'stuntin', menu: 'STUNTIN' })

  await page.goBack()
  await page.waitForTimeout(4500)
  expect('Back again leaves the game', await state(), { url: '/', mount: 'lobby', menu: null })

  await page.goForward()
  await page.waitForTimeout(8000)
  expect('Forward retraces into the game', await state(), { url: '/stuntin', mount: 'stuntin', menu: 'STUNTIN' })

  await page.goto(`${url}/apex`, { waitUntil: 'load' })
  await page.waitForTimeout(9000)
  expect('a cold deep link boots that game', await state(), { url: '/apex', mount: 'apex', menu: 'APEX CONDUIT' })

  await page.goto(`${url}/nonsense`, { waitUntil: 'load' })
  await page.waitForTimeout(6000)
  expect('an unknown path lands in the lobby', await state(), { url: '/', mount: 'lobby', menu: null })

  // --- leaks ----------------------------------------------------------------
  console.log(`leaks (${rounds} rounds of all ${GAMES.length} games)`)
  const first = await census()
  note(`baseline ${JSON.stringify(first)}`)
  let last = first
  for (let r = 1; r <= rounds; r++) {
    for (const id of GAMES) await go(`/${id}`)
    await go('/', 4000)
    last = await census()
    note(`round ${r}  ${JSON.stringify(last)}`)
  }
  // Back in the lobby there is exactly one live canvas: the lobby's own.
  if (last.canvases !== 1) errors.push(`${last.canvases} canvases live in the lobby, expected 1 — a game is not releasing its canvas`)
  if (last.audioOpen !== 0) errors.push(`${last.audioOpen} AudioContexts still open — a game's AudioWorld.dispose() is not being reached`)
  // Growth across rounds is the signal; absolute size is not, since the lobby's own textures vary.
  const growth = last.heapMB - first.heapMB
  if (growth > 40) errors.push(`heap grew ${growth.toFixed(1)} MB over ${rounds} rounds — something is retained per mount`)
  else note(`heap moved ${growth >= 0 ? '+' : ''}${growth.toFixed(1)} MB over ${rounds} rounds`)

  // --- play -----------------------------------------------------------------
  console.log('play')
  for (const id of GAMES) {
    await go(`/${id}`, 9000)
    await page.keyboard.press('Enter') // start the run from the title menu
    await page.waitForTimeout(1200)
    await page.keyboard.down('KeyW')
    await page.waitForTimeout(3500)
    await page.keyboard.up('KeyW')
    await page.screenshot({ path: `${outDir}/arcade-${id}.png` })
    // Each game's HUD says it differently; any of them proves the sim advanced.
    const moved = await page.evaluate(() => {
      const num = (sel, attr) => {
        const el = document.querySelector(sel)
        if (!el) return 0
        return parseFloat(attr === 'width' ? el.style.width : (el.textContent ?? '0')) || 0
      }
      return Math.max(num('.hud [data-progress]', 'width'), num('.hud [data-speed]'), num('.hud .speedo .value'), num('.hud .speed .value'))
    })
    if (moved > 1) note(`✓ ${id} played (${moved})`)
    else {
      note(`✗ ${id} did not move`)
      errors.push(`${id}: nothing moved after 3.5s of throttle`)
    }
    await go('/', 3000)
  }
  const end = await census()
  note(`after playing all three: ${JSON.stringify(end)}`)
  if (end.audioOpen !== 0) errors.push(`${end.audioOpen} AudioContexts still open after playing — audio is not being closed on unmount`)
} finally {
  await browser.close()
}

if (errors.length) {
  console.error('\narcade-smoke FAILED:')
  for (const e of errors) console.error('  ' + e)
  process.exit(1)
}
console.log(`\narcade-smoke OK → ${outDir}/arcade-*.png`)
