// The sound board: any clip on a waveform, played, trimmed and shaped by ear, saved as a clip
// of its own.
//
// Rich, 2026-10-09, after hearing the first bank: "Def. cringy whatever is there now and way too
// loud, tire squeals sound like a mouse. Can we get a sound board in the editor so we can listen
// to any sample and do some simple edits? I know claude is deaf" — which is the point. I cut the
// bank by spectrogram; he hears it. So the edits a person makes by ear live here, in the editor,
// not in a Python script on this side: a selection on the waveform, gain, fades, a pitch, a
// high-pass and a low-pass to get an engine out from under a tyre, normalise, and a loop-close
// that folds the tail over the head so a squeal can run. Everything is rendered through an
// OfflineAudioContext from the untouched decoded buffer — nothing is destructive until Save, and
// Save writes a NEW file: a wav uploaded to a catalog asset (`asset:<id>/<name>`), which any
// vehicle's slot can then name, or a download.
//
// It renders into any host: the Sounds tab mounts one at the top; the slot editor on a vehicle
// opens one in a dialog with the clip that was clicked and adds the saved entry to the slot.

import { assetsvc, type AssetItem } from '../../assets/assetsvc'
import { SOUND_SLOTS, type BankManifest } from '../../game/audio/soundbank'
import { readout, select, slider, textField, toggle } from '../../ui/controls'
import { button, el, toast } from '../../ui/shell'
import { describeEntry, previewSfx } from './soundpicker'

export interface SoundBoardOpts {
  /** a clip to open with: a bank entry, `asset:<id>/<file>` or a URL */
  entry?: string
  /** the asset Save uploads to by default; the board offers every catalog asset as well */
  assetId?: string | null
  /** a clip was saved: the entry a document may now name */
  onSaved?: (entry: string) => void
}

/** the shaping, all of it reversible until Save */
interface Shape {
  /** selection, seconds into the source */
  a: number
  b: number
  gainDb: number
  fadeInMs: number
  fadeOutMs: number
  semitones: number
  highpassHz: number
  lowpassHz: number
  normalise: boolean
  /** close into a loop with this crossfade; 0 = not a loop */
  loopMs: number
}

export function soundBoard(host: HTMLElement, opts: SoundBoardOpts = {}): { load: (entry: string) => Promise<void> } {
  const sfx = previewSfx()
  const ctx = () => {
    sfx.unlock()
    return sfx.context
  }
  let source: AudioBuffer | null = null
  let sourceName = ''
  let shape: Shape = { a: 0, b: 0, gainDb: 0, fadeInMs: 5, fadeOutMs: 20, semitones: 0, highpassHz: 0, lowpassHz: 0, normalise: false, loopMs: 0 }
  let playing: { src: AudioBufferSourceNode; startedAt: number; length: number; loop: boolean } | null = null
  let rendered: AudioBuffer | null = null
  let renderStamp = ''
  let assets: AssetItem[] = []
  let saveTo = opts.assetId ?? ''
  let saveName = ''

  host.replaceChildren()
  host.classList.add('sndb')
  const top = el('div', 'panel-actions sndb-top')
  const canvas = el('canvas', 'sndb-wave') as HTMLCanvasElement
  canvas.width = 900
  canvas.height = 140
  const info = el('div', 'field-note sndb-info', 'no clip loaded')
  const controls = el('div', 'sndb-controls')
  const saveRow = el('div', 'sndb-save')
  host.append(top, canvas, info, controls, saveRow)

  /* ---- loading --------------------------------------------------------------------------- */

  const bankEntries = (): string[] => {
    const m: BankManifest | undefined = sfx.bank?.manifest
    return m ? SOUND_SLOTS.flatMap((s) => (m.slots[s]?.clips ?? []).map((c) => c.file.replace(/\.ogg$/, ''))) : []
  }
  const urlOf = (entry: string): string | null => {
    const b = sfx.bank
    if (!b) return null
    const r = b.resolve('tire.skid', [{ 'tire.skid': [entry] }])
    return r[0]?.url ?? null
  }
  async function loadUrl(url: string, name: string): Promise<void> {
    const c = ctx()
    if (!c) { toast('no audio in this browser', 'warn'); return }
    try {
      const r = await fetch(url)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setSource(await c.decodeAudioData(await r.arrayBuffer()), name)
    } catch (e) {
      toast(`could not load ${name}: ${(e as Error).message}`, 'warn', 5000)
    }
  }
  async function loadFile(f: File): Promise<void> {
    const c = ctx()
    if (!c) return
    try {
      setSource(await c.decodeAudioData(await f.arrayBuffer()), f.name)
    } catch (e) {
      toast(`${f.name}: ${(e as Error).message}`, 'warn', 5000)
    }
  }
  function setSource(buf: AudioBuffer, name: string): void {
    stop()
    source = buf
    sourceName = name
    shape = { ...shape, a: 0, b: buf.duration }
    saveName = saveName || name.replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase() || 'clip'
    rendered = null
    renderStamp = ''
    draw()
    renderControls()
    renderSave()
  }

  const load = async (entry: string) => {
    const url = urlOf(entry)
    if (!url) { toast(`${entry}: the bank is not loaded yet`, 'info'); return }
    await loadUrl(url, entry)
  }

  /* ---- rendering the shape --------------------------------------------------------------- */

  const stamp = () => JSON.stringify(shape)
  async function render(): Promise<AudioBuffer | null> {
    if (!source) return null
    if (rendered && renderStamp === stamp()) return rendered
    const c = ctx()
    if (!c) return null
    const sr = source.sampleRate
    const a = Math.max(0, Math.min(shape.a, shape.b))
    const b = Math.min(source.duration, Math.max(shape.a, shape.b))
    const rate = 2 ** (shape.semitones / 12)
    const srcLen = Math.max(1, Math.round((b - a) * sr))
    const outLen = Math.max(1, Math.round(srcLen / rate))
    // the selection as its own mono buffer: a slice, channels averaged
    const seg = new AudioBuffer({ length: srcLen, sampleRate: sr, numberOfChannels: 1 })
    const out = seg.getChannelData(0)
    const start = Math.round(a * sr)
    for (let ch = 0; ch < source.numberOfChannels; ch++) {
      const d = source.getChannelData(ch)
      for (let i = 0; i < srcLen; i++) out[i] += (d[start + i] ?? 0) / source.numberOfChannels
    }
    const off = new OfflineAudioContext(1, outLen, sr)
    const node = off.createBufferSource()
    node.buffer = seg
    node.playbackRate.value = rate
    let tail: AudioNode = node
    if (shape.highpassHz > 0) {
      const hp = off.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = shape.highpassHz; hp.Q.value = 0.7
      const hp2 = off.createBiquadFilter(); hp2.type = 'highpass'; hp2.frequency.value = shape.highpassHz; hp2.Q.value = 0.7
      tail.connect(hp); hp.connect(hp2); tail = hp2
    }
    if (shape.lowpassHz > 0) {
      const lp = off.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = shape.lowpassHz; lp.Q.value = 0.7
      tail.connect(lp); tail = lp
    }
    const g = off.createGain()
    const lin = 10 ** (shape.gainDb / 20)
    const dur = outLen / sr
    const fi = Math.min(dur / 2, shape.fadeInMs / 1000), fo = Math.min(dur / 2, shape.fadeOutMs / 1000)
    g.gain.setValueAtTime(fi > 0 ? 0 : lin, 0)
    if (fi > 0) g.gain.linearRampToValueAtTime(lin, fi)
    if (fo > 0) { g.gain.setValueAtTime(lin, Math.max(fi, dur - fo)); g.gain.linearRampToValueAtTime(0, dur) }
    tail.connect(g)
    g.connect(off.destination)
    node.start(0)
    let buf = await off.startRendering()
    // the loop-close and the normalise are plain arithmetic on the rendered samples
    if (shape.loopMs > 0) {
      const d = buf.getChannelData(0)
      const X = Math.min(Math.floor(d.length / 2), Math.round((shape.loopMs / 1000) * sr))
      const n = d.length - X
      const loop = new AudioBuffer({ length: n, sampleRate: sr, numberOfChannels: 1 })
      const o = loop.getChannelData(0)
      o.set(d.subarray(0, n))
      for (let i = 0; i < X; i++) {
        const r = Math.sin((i / X) * Math.PI / 2) ** 2
        o[i] = d[i] * r + d[n + i] * (1 - r)
      }
      buf = loop
    }
    if (shape.normalise) {
      const d = buf.getChannelData(0)
      let m = 0
      for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]))
      if (m > 1e-6) { const k = 0.891 / m; for (let i = 0; i < d.length; i++) d[i] *= k }
    }
    rendered = buf
    renderStamp = stamp()
    return buf
  }

  /* ---- playing --------------------------------------------------------------------------- */

  function stop(): void {
    if (playing) { try { playing.src.stop() } catch { /* done */ } playing = null }
  }
  async function play(loop: boolean): Promise<void> {
    stop()
    const c = ctx()
    const buf = await render()
    if (!c || !buf) return
    const src = c.createBufferSource()
    src.buffer = buf
    src.loop = loop
    src.connect(c.destination)
    src.start()
    playing = { src, startedAt: c.currentTime, length: buf.duration, loop }
    src.onended = () => { if (playing?.src === src) playing = null; draw() }
    draw()
  }

  /* ---- the waveform ---------------------------------------------------------------------- */

  let peaks: Float32Array | null = null
  let peaksFor: AudioBuffer | null = null
  function computePeaks(): void {
    if (!source) { peaks = null; return }
    if (peaksFor === source && peaks) return
    const w = canvas.width
    const d = source.getChannelData(0)
    const per = d.length / w
    peaks = new Float32Array(w * 2)
    for (let x = 0; x < w; x++) {
      let lo = 1, hi = -1
      const s = Math.floor(x * per), e = Math.min(d.length, Math.floor((x + 1) * per) + 1)
      for (let i = s; i < e; i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v }
      peaks[x * 2] = lo
      peaks[x * 2 + 1] = hi
    }
    peaksFor = source
  }
  function draw(): void {
    const g = canvas.getContext('2d')!
    const w = canvas.width, h = canvas.height
    g.clearRect(0, 0, w, h)
    g.fillStyle = 'rgba(128,128,128,0.08)'
    g.fillRect(0, 0, w, h)
    if (!source) return
    computePeaks()
    const dur = source.duration
    const xOf = (t: number) => (t / dur) * w
    // the selection
    const a = xOf(Math.min(shape.a, shape.b)), b = xOf(Math.max(shape.a, shape.b))
    g.fillStyle = 'rgba(80,160,255,0.18)'
    g.fillRect(a, 0, b - a, h)
    // the wave
    g.strokeStyle = 'rgba(200,200,210,0.9)'
    g.beginPath()
    for (let x = 0; x < w; x++) {
      const lo = peaks![x * 2], hi = peaks![x * 2 + 1]
      g.moveTo(x + 0.5, h / 2 - hi * (h / 2 - 2))
      g.lineTo(x + 0.5, h / 2 - lo * (h / 2 - 2))
    }
    g.stroke()
    g.strokeStyle = 'rgba(80,160,255,0.9)'
    g.beginPath(); g.moveTo(a + 0.5, 0); g.lineTo(a + 0.5, h); g.moveTo(b + 0.5, 0); g.lineTo(b + 0.5, h); g.stroke()
    // the playhead, in source seconds: the render starts at the selection and runs at the rate
    const c = sfx.context
    if (playing && c) {
      let t = (c.currentTime - playing.startedAt)
      if (playing.loop) t %= playing.length
      const rate = 2 ** (shape.semitones / 12)
      const x = xOf(Math.min(shape.a, shape.b) + t * rate)
      g.strokeStyle = 'rgba(255,200,80,0.95)'
      g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, h); g.stroke()
      requestAnimationFrame(draw)
    }
    info.textContent = `${sourceName} · ${dur.toFixed(2)} s · ${source.sampleRate} Hz · selection ${Math.min(shape.a, shape.b).toFixed(3)}–${Math.max(shape.a, shape.b).toFixed(3)} s (${Math.abs(shape.b - shape.a).toFixed(3)} s)${rendered ? ` · rendered ${rendered.duration.toFixed(3)} s` : ''}`
  }
  // drag to select; a click sets the nearer handle
  let dragging: 'a' | 'b' | null = null
  const tAt = (ev: PointerEvent) => {
    const r = canvas.getBoundingClientRect()
    return Math.max(0, Math.min(source?.duration ?? 0, ((ev.clientX - r.left) / r.width) * (source?.duration ?? 0)))
  }
  canvas.onpointerdown = (ev) => {
    if (!source) return
    canvas.setPointerCapture(ev.pointerId)
    const t = tAt(ev)
    dragging = Math.abs(t - shape.a) < Math.abs(t - shape.b) ? 'a' : 'b'
    shape[dragging] = t
    renderStamp = ''
    draw()
  }
  canvas.onpointermove = (ev) => { if (dragging && source) { shape[dragging] = tAt(ev); draw() } }
  canvas.onpointerup = () => { dragging = null; renderControls() }

  /* ---- the controls ---------------------------------------------------------------------- */

  function renderTop(): void {
    top.replaceChildren()
    const entries = bankEntries()
    top.append(select({
      label: 'Bank clip', value: '',
      options: [{ value: '', label: entries.length ? '— choose —' : 'bank loading…' }, ...entries.map((e) => ({ value: e, label: e }))],
      onChange: (v) => { if (v) void load(v) },
    }))
    const url = textField({ label: 'Or a URL / entry', value: '', placeholder: 'asset:<id>/<file> or https://…', onChange: (v) => { const t = v.trim(); if (t) void load(t) } })
    top.append(url)
    const lab = el('label', 'field text')
    lab.append(el('span', 'field-label', 'Or a file from this machine'))
    const input = el('input', 'input') as HTMLInputElement
    input.type = 'file'
    input.accept = 'audio/*,.ogg,.mp3,.wav,.m4a,.webm,.flac'
    input.onchange = () => { const f = input.files?.[0]; if (f) void loadFile(f) }
    lab.append(input)
    top.append(lab)
  }

  function renderControls(): void {
    controls.replaceChildren()
    if (!source) return
    const bump = () => { renderStamp = ''; draw() }
    const row1 = el('div', 'panel-actions')
    row1.append(button({ label: 'Play', icon: 'play', variant: 'primary', onClick: () => void play(false) }))
    row1.append(button({ label: 'Loop', icon: 'play', onClick: () => void play(true) }))
    row1.append(button({ label: 'Stop', variant: 'ghost', onClick: () => { stop(); draw() } }))
    row1.append(button({ label: 'Whole clip', variant: 'ghost', onClick: () => { shape.a = 0; shape.b = source!.duration; bump(); renderControls() } }))
    row1.append(button({ label: 'Trim to selection', variant: 'ghost', title: 'make the selection the new source, so the handles have room again', onClick: () => void (async () => { const b = await renderSelectionOnly(); if (b) setSource(b, sourceName) })() }))
    controls.append(row1)
    const grid = el('div', 'sndb-grid')
    const dur = source.duration
    grid.append(slider({ label: 'Start (s)', value: Math.min(shape.a, shape.b), min: 0, max: dur, step: 0.001, onInput: (v) => { shape.a = v; bump() } }))
    grid.append(slider({ label: 'End (s)', value: Math.max(shape.a, shape.b), min: 0, max: dur, step: 0.001, onInput: (v) => { shape.b = v; bump() } }))
    grid.append(slider({ label: 'Gain (dB)', value: shape.gainDb, min: -30, max: 24, step: 0.5, onInput: (v) => { shape.gainDb = v; bump() } }))
    grid.append(slider({ label: 'Pitch (semitones)', value: shape.semitones, min: -12, max: 12, step: 0.1, onInput: (v) => { shape.semitones = v; bump() } }))
    grid.append(slider({ label: 'Fade in (ms)', value: shape.fadeInMs, min: 0, max: 1000, step: 1, onInput: (v) => { shape.fadeInMs = v; bump() } }))
    grid.append(slider({ label: 'Fade out (ms)', value: shape.fadeOutMs, min: 0, max: 2000, step: 1, onInput: (v) => { shape.fadeOutMs = v; bump() } }))
    grid.append(slider({ label: 'High-pass (Hz, 0 = off)', value: shape.highpassHz, min: 0, max: 3000, step: 10, note: '600–800 takes a boxer out from under a tyre', onInput: (v) => { shape.highpassHz = v; bump() } }))
    grid.append(slider({ label: 'Low-pass (Hz, 0 = off)', value: shape.lowpassHz, min: 0, max: 16000, step: 100, onInput: (v) => { shape.lowpassHz = v; bump() } }))
    grid.append(slider({ label: 'Loop-close crossfade (ms, 0 = not a loop)', value: shape.loopMs, min: 0, max: 500, step: 5, note: 'folds the tail over the head so the clip runs without a seam', onInput: (v) => { shape.loopMs = v; bump() } }))
    grid.append(toggle({ label: 'Normalise to -1 dBFS', value: shape.normalise, onChange: (v) => { shape.normalise = v; bump() } }))
    controls.append(grid)
  }

  async function renderSelectionOnly(): Promise<AudioBuffer | null> {
    const keep = shape
    shape = { ...shape, gainDb: 0, fadeInMs: 0, fadeOutMs: 0, semitones: 0, highpassHz: 0, lowpassHz: 0, normalise: false, loopMs: 0 }
    renderStamp = ''
    const b = await render()
    shape = { ...keep }
    renderStamp = ''
    return b
  }

  /* ---- saving ---------------------------------------------------------------------------- */

  function renderSave(): void {
    saveRow.replaceChildren()
    if (!source) return
    const row = el('div', 'panel-actions')
    row.append(textField({ label: 'Save as', value: saveName, placeholder: 'squeal-lotus', onChange: (v) => { saveName = v.trim().replace(/[^a-z0-9_.-]+/gi, '-').toLowerCase() } }))
    const opts = [{ value: '', label: assets.length ? '— asset to store it on —' : 'reading the catalog…' }, ...assets.map((a) => ({ value: a.id, label: `${a.id} — ${a.subject}` }))]
    if (saveTo && !assets.some((a) => a.id === saveTo)) opts.splice(1, 0, { value: saveTo, label: saveTo })
    row.append(select({ label: 'On asset', value: saveTo, options: opts, onChange: (v) => { saveTo = v } }))
    row.append(button({
      label: 'Save', icon: 'arrow-up-tray', variant: 'primary',
      onClick: async () => {
        if (!saveTo) return void toast('choose the asset to store it on', 'warn')
        const buf = await render()
        if (!buf) return
        const file = new File([wavOf(buf)], `${saveName || 'clip'}.wav`, { type: 'audio/wav' })
        try {
          const r = await assetsvc.uploadSound(saveTo, file)
          toast(`saved ${r.entry} (${(r.bytes / 1024).toFixed(0)} KB)`, 'ok', 4000)
          opts_onSaved(r.entry)
        } catch (e) {
          toast(`save failed: ${(e as Error).message}`, 'warn', 6000)
        }
      },
    }))
    row.append(button({
      label: 'Download .wav', variant: 'ghost',
      onClick: async () => {
        const buf = await render()
        if (!buf) return
        const a = document.createElement('a')
        a.href = URL.createObjectURL(new Blob([wavOf(buf)], { type: 'audio/wav' }))
        a.download = `${saveName || 'clip'}.wav`
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 5000)
      },
    }))
    saveRow.append(row)
    saveRow.append(readout('Then', 'name the saved entry in a vehicle’s or actor’s slot (its Sounds tab → Edit → the URL field), or pick it from the Board on that slot', false))
  }
  const opts_onSaved = (entry: string) => { opts.onSaved?.(entry); toast(describeEntry(entry), 'info', 2000) }

  renderTop()
  draw()
  void assetsvc.list().then((items) => { assets = items; renderSave() }).catch(() => { /* no service: download still works */ })
  // the bank arrives a moment after the first paint; the clip menu fills then
  if (!sfx.bank) void sfx.loadBank().then(renderTop)
  if (opts.entry) void load(opts.entry)
  return { load }
}

/** 16-bit PCM wav, mono — what every browser decodes and the asset service stores as it is */
export function wavOf(buf: AudioBuffer): ArrayBuffer {
  const d = buf.getChannelData(0)
  const out = new ArrayBuffer(44 + d.length * 2)
  const v = new DataView(out)
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + d.length * 2, true); str(8, 'WAVE')
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, buf.sampleRate, true); v.setUint32(28, buf.sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, d.length * 2, true)
  for (let i = 0; i < d.length; i++) {
    const s = Math.max(-1, Math.min(1, d[i]))
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return out
}
