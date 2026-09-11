#!/usr/bin/env node
// Record each game's title screen as the loop that plays on its cabinet.
//
//   node scripts/capture-attract.mjs              # all three, needs their dev servers up
//   node scripts/capture-attract.mjs radrun       # just one
//   node scripts/capture-attract.mjs --seconds 14
//
// A dark rectangle where the screen should be is the one thing that stops a cabinet reading as a
// machine that is switched on. Every game already draws something behind its title menu, so this
// loads each one on its own dev server, hides the menu, lets the scene settle and films it.
//
// Playwright's own recorder does the work: it captures the page at exactly the size asked for and
// writes webm, which is what a <video> feeding a texture wants anyway — no encoder, no ffmpeg, no
// frame-by-frame screenshotting.
//
// The result goes to apps/arcade/public/cabinets/<game>/attract.webm, where the cabinet finds it.

import { chromium } from 'playwright'
import { copyFileSync, mkdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Which dev server each game's own entry point is on; see the justfile. */
const GAMES = {
  radrun: { port: 5182, app: 'coast' },
  stuntin: { port: 5181, app: 'stuntin' },
  apex: { port: 5180, app: 'conduit' },
}

/** 4:3, because that is the shape of the hole in a cabinet. */
const SIZE = { width: 640, height: 480 }

const args = process.argv.slice(2)
const seconds = Number(args.includes('--seconds') ? args[args.indexOf('--seconds') + 1] : 10)
const wanted = args.filter((a) => !a.startsWith('--') && a in GAMES)
const list = wanted.length ? wanted : Object.keys(GAMES)

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] })

for (const id of list) {
  const { port, app } = GAMES[id]
  const url = `http://localhost:${port}/`
  const tmp = path.join(ROOT, 'shots', `.attract-${id}`)
  rmSync(tmp, { recursive: true, force: true })

  const ctx = await browser.newContext({ viewport: SIZE, recordVideo: { dir: tmp, size: SIZE } })
  const page = await ctx.newPage()
  const problems = []
  page.on('pageerror', (e) => problems.push(e.message))
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
  } catch {
    console.error(`${id}: nothing answering on :${port} — run \`just dev ${app}\` first`)
    await ctx.close()
    continue
  }
  // The menu and the HUD are the parts a player is supposed to see; the cabinet wants what is
  // behind them. Hidden rather than dismissed, so the game stays on its title scene.
  await page.addStyleTag({ content: '.menu, .hud, .press-start, .perf { display: none !important }' })
  // Let it get past loading — coast bakes a sprite atlas before it draws anything at all.
  await page.waitForTimeout(6000)
  await page.waitForTimeout(seconds * 1000)
  await ctx.close()

  const video = await page.video()?.path()
  if (!video) {
    console.error(`${id}: no video came back`)
    continue
  }
  const outDir = path.join(ROOT, 'apps/arcade/public/cabinets', id)
  mkdirSync(outDir, { recursive: true })
  const out = path.join(outDir, 'attract.webm')
  copyFileSync(video, out)
  rmSync(tmp, { recursive: true, force: true })
  const mb = statSync(out).size / 1e6
  console.log(`${id}: ${seconds}s → ${path.relative(ROOT, out)} (${mb.toFixed(1)} MB)${problems.length ? ` — page errors: ${problems[0]}` : ''}`)
}

await browser.close()
