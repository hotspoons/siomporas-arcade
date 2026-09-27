// Drive the bench the way a person would, and check it made a noise.
//
// The package probes (measure.mjs, verify-browser.mjs) test the engine. This tests the INTERFACE:
// that clicking Start actually starts, that the engine list is populated from the catalog, that
// moving a knob reaches the audio thread, and that the preset comes out sparse. A tuning tool whose
// sliders are wired to nothing looks identical to one that works.
//
//   node packages/enginesim/scripts/verify-bench.mjs

import { createServer } from 'vite'
import { chromium } from 'playwright'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import process from 'node:process'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '..', '..')

const failures = []
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

const server = await createServer({
  root: join(packageRoot, 'bench'),
  server: { port: 5198, strictPort: false },
  logLevel: 'error',
})
await server.listen()
const port = server.config.server.port ?? server.httpServer.address().port

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
})

try {
  const page = await browser.newPage({ viewport: { width: 1180, height: 1500 } })
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))

  await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' })

  // Start, exactly as a person does: one click on the button.
  await page.click('#power')
  await page.waitForSelector('#main:not([hidden])', { timeout: 40_000 })
  await page.waitForFunction(() => document.querySelectorAll('#spec dd').length > 0,
    { timeout: 40_000 })

  check('no page errors', errors.length === 0, errors[0] ?? '')

  const engineCount = await page.$$eval('#engines option', (o) => o.length)
  check('engine picker is populated from the catalog', engineCount >= 20, `${engineCount} engines`)

  const knobCount = await page.$$eval('#params .knob', (k) => k.length)
  check('every audio parameter has a knob', knobCount === 10, `${knobCount} knobs`)

  const spec = await page.$$eval('#spec dd', (d) => d.map((e) => e.textContent))
  check('the loaded engine reports its specification',
    spec.length === 4 && Number(spec[0]) > 0 && /cc$/.test(spec[1] ?? ''), spec.join(' / '))
  const opened = await page.$eval('#engines', (el) => el.value)
  check('opens on the default V8 rather than whatever sorts first',
    opened === 'engines/atg-video-2/07_gm_ls.mr' && spec[0] === '8', `${opened}, ${spec[0]} cyl`)

  // Telemetry only arrives from the audio thread, so a value here means the worklet is running.
  await page.waitForFunction(
    () => Number(document.querySelectorAll('#telemetry dd')[0]?.textContent ?? 0) > 0,
    { timeout: 20_000 })
  const idleRpm = await page.$eval('#telemetry dd', (d) => Number(d.textContent))
  check('telemetry is live from the audio thread', idleRpm > 0, `${idleRpm} rpm`)

  // Move the RPM slider and confirm the simulation follows it. This is the whole dyno in one check.
  await page.$eval('#rpm', (el) => {
    el.value = '4200'
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.waitForFunction(
    () => Number(document.querySelectorAll('#telemetry dd')[0]?.textContent ?? 0) > 3800,
    { timeout: 20_000 })
  const heldRpm = await page.$eval('#telemetry dd', (d) => Number(d.textContent))
  check('the RPM knob reaches the simulation', Math.abs(heldRpm - 4200) < 500,
    `asked 4200, holding ${heldRpm}`)

  // A knob moves, and the preset records it — sparsely.
  const before = await page.$eval('#preset', (t) => t.value)
  check('an untouched preset names only the engine', !before.includes('params'),
    before.replace(/\s+/g, ' ').trim())
  await page.$eval('#p-convolution', (el) => {
    el.value = '400'
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const after = JSON.parse(await page.$eval('#preset', (t) => t.value))
  check('moving a knob lands in the preset',
    after.params && typeof after.params.convolution === 'number',
    JSON.stringify(after.params ?? {}))
  check('the preset stays sparse', Object.keys(after.params ?? {}).length === 1,
    `${Object.keys(after.params ?? {}).length} of 10 knobs recorded`)

  mkdirSync(join(repoRoot, 'shots'), { recursive: true })
  const shot = join(repoRoot, 'shots', 'enginesim-bench.png')
  await page.screenshot({ path: shot, fullPage: true })
  console.log(`\n  wrote ${shot}`)
} finally {
  await browser.close()
  await server.close()
}

console.log('')
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('the bench works')
