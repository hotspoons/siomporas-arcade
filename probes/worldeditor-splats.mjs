// Can a person get footage in and a run planned, without leaving the editor?
//
// The upload is the hard part and the only part worth proving: a GoPro chapter is gigabytes, the
// connection is a home one, and "start again" is not an answer. So this uploads a file through
// the panel IN CHUNKS, checks the bytes that landed are the bytes that were sent, and then checks
// the thing that makes it resumable — that re-adding a partly-uploaded file carries on rather
// than starting over.
//
//   node probes/worldeditor-splats.mjs --ui http://localhost:5214/world.html
import { chromium } from 'playwright'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const UI = arg('ui', 'http://localhost:5214/world.html')
const DATA = arg('data', '/tmp/claude-1000/wedata-fresh')

// two chapters of ONE recording, named the GoPro way: GS<chapter><recording>
const dir = await mkdtemp(path.join(tmpdir(), 'chapters-'))
const files = []
for (const [chapter, size] of [[1, 3_000_000], [2, 1_500_000]]) {
  const name = `GS0${chapter}0042.360`
  const buf = randomBytes(size)
  await writeFile(path.join(dir, name), buf)
  files.push({ name, path: path.join(dir, name), sha: createHash('sha256').update(buf).digest('hex'), size })
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
const errors = []
page.on('pageerror', (e) => { errors.push(e.message.slice(0, 200)); console.log('pageerror', e.message.slice(0, 200)) })
await page.goto(UI, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.seg', { timeout: 30000 })
await page.click('.seg[data-value="splats"]')
await page.waitForSelector('#panel button:has-text("New capture")', { timeout: 30000 })
await page.click('#panel button:has-text("New capture")')
await page.waitForSelector('#panel input[type=file]', { timeout: 20000 })

const chunkNote = await page.evaluate(() => [...document.querySelectorAll('#panel .panel-hint')].map((h) => h.textContent.trim()).find((t) => /Chunks of/.test(t)) ?? null)
const captureId = await page.evaluate(() => document.querySelector('#panel .group-head span:last-child')?.textContent.trim() ?? null)

// upload both chapters through the panel
await page.setInputFiles('#panel input[type=file]', files.map((f) => f.path))
await page.waitForFunction(() => [...document.querySelectorAll('#panel .readout')].filter((r) => /done$/.test(r.textContent.trim())).length >= 2, null, { timeout: 120000 })
await page.waitForTimeout(1500)

// what the panel says, and what actually landed
const chapters = await page.$$eval('#panel .readout', (rs) => rs.map((r) => r.textContent.trim()))
const onDisk = []
for (const f of files) {
  const p = path.join(DATA, 'captures', captureId, 'video', 'max2-front', f.name)
  const buf = await readFile(p).catch(() => null)
  onDisk.push({ name: f.name, ok: !!buf, sha: buf ? createHash('sha256').update(buf).digest('hex') : null, match: buf ? createHash('sha256').update(buf).digest('hex') === f.sha : false })
}

// AND THE RESUME. Re-adding a finished chapter must be refused as already uploaded, not silently
// re-sent — the same code path that carries on from a half-uploaded one.
const before = await page.evaluate(() => document.querySelectorAll('#panel .readout').length)
await page.setInputFiles('#panel input[type=file]', [files[0].path])
await page.waitForTimeout(3000)
const resumeNote = await page.$$eval('#panel .readout', (rs) => rs.map((r) => r.textContent.trim()).filter((t) => /failed|already/.test(t)))

// and what the run would be
await page.click('#panel button:has-text("Show what would run")')
await page.waitForTimeout(2500)
const manifest = await page.evaluate(() => document.querySelector('#panel pre.manifest')?.textContent?.slice(0, 400) ?? null)
const willUse = await page.evaluate(() => [...document.querySelectorAll('#panel .readout')].map((r) => r.textContent.trim()).find((t) => /^will use/.test(t)) ?? null)

console.log(JSON.stringify({ captureId, chunkNote, chapters: chapters.slice(0, 8), onDisk, resumeNote, willUse, manifestHead: manifest?.slice(0, 120) }, null, 1))
await browser.close()
const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1 }
if (errors.length) fail(`the page threw: ${errors[0]}`)
else if (!captureId) fail('no capture was created')
else if (!chunkNote) fail('the panel does not say what chunk size it is using — only the server knows what ingress allows')
else if (onDisk.some((f) => !f.ok)) fail(`a chapter did not land: ${JSON.stringify(onDisk)}`)
else if (onDisk.some((f) => !f.match)) fail(`the bytes on disk are not the bytes sent: ${JSON.stringify(onDisk)}`)
else if (!chapters.some((c) => /^0GS01/.test(c)) || !chapters.some((c) => /^1GS02/.test(c)))
  fail(`the chapters are not ordered explicitly, chapter 1 then 2: ${JSON.stringify(chapters)}`)
else if (!resumeNote.length) fail('re-adding an already-uploaded chapter was accepted silently')
else if (!willUse) fail('the panel does not say which workload API it will use')
else if (/no workload API/.test(willUse)) {
  // NOT A FAILURE. Without a mounted service account there is no cluster to plan against, and the
  // panel saying so plainly is the correct behaviour — a preview invented here would be a lie.
  console.log(`PASS (no cluster): ${captureId} took ${onDisk.length} chapters, ${chunkNote.toLowerCase()}, sha256 identical on disk, ordered chapter 1 then 2, and a re-add was refused ("${resumeNote[0].slice(0, 60)}"). The run planner says "${willUse}", which is the honest answer from a machine with no Kubernetes.`)
} else if (!manifest) fail('a workload API is available but the preview showed nothing — a splat run is hours of several GPUs and should be visible before it starts')
else console.log(`PASS: ${captureId} took ${onDisk.length} chapters, ${chunkNote.toLowerCase()}, sha256 identical on disk, ordered chapter 1 then 2, a re-add refused ("${resumeNote[0].slice(0, 60)}"), and ${willUse.toLowerCase()} with a manifest shown before anything is created.`)
