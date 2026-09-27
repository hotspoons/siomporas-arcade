// What does a panned bus weigh against an unpanned one — and how badly does HRTF colour a sound?
//
// This is the measurement behind two decisions in @apex/enginesim's voice.ts, and it is kept
// because both look arbitrary written down and are not:
//
//   1. INTERIOR_MATCH = √½. A mono signal reaching a stereo output is up-mixed by COPYING, gain 1
//      into each channel, while an equal-power panner at centre puts 0.7071 into each. The
//      unpanned interior bus is therefore 3 dB louder than the panned exterior one carrying the
//      same signal, and without the correction the level STEPS as the camera leaves the cabin.
//
//   2. hrtf defaults to false. Equal-power is flat to four decimal places at every frequency and
//      every azimuth. Chromium's HRTF swings 5.25× across the same sweep, because it is a real
//      measured head — which is a fine thing to do to a footstep and the wrong thing to do to a
//      simulated combustion engine, whose timbre is the entire point.
//
//   node probes/enginesim-panlaw.mjs
import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto('about:blank')
const out = await page.evaluate(async () => {
  const RATE = 48000
  const render = async (build) => {
    const ctx = new OfflineAudioContext(2, RATE * 0.5, RATE)
    const osc = ctx.createOscillator(); osc.frequency.value = 220
    build(ctx, osc); osc.start()
    const buf = await ctx.startRendering()
    const skip = RATE * 0.1
    const rms = (c) => { const d = buf.getChannelData(c); let s = 0; for (let i = skip; i < d.length; i++) s += d[i] * d[i]; return Math.sqrt(s / (d.length - skip)) }
    return Math.hypot(rms(0), rms(1))
  }
  const rows = []
  for (const model of ['equalpower', 'HRTF']) {
    for (const hz of [80, 220, 700, 2000, 6000, 12000]) {
      for (const az of [0, 45, 90, 180]) {
        const rad = az * Math.PI / 180
        const g = await render((ctx, osc) => {
          osc.frequency.value = hz
          const p = ctx.createPanner(); p.panningModel = model; p.distanceModel = 'inverse'
          p.refDistance = 2.5; p.maxDistance = 400; p.rolloffFactor = 0.9
          // 1 m away, inside refDistance: no attenuation, pure panning gain
          p.positionX.value = Math.sin(rad); p.positionY.value = Math.cos(rad); p.positionZ.value = 0
          ctx.listener.forwardX.value = 0; ctx.listener.forwardY.value = 1; ctx.listener.forwardZ.value = 0
          ctx.listener.upX.value = 0; ctx.listener.upY.value = 0; ctx.listener.upZ.value = 1
          osc.connect(p); p.connect(ctx.destination)
        })
        rows.push({ model, hz, az, gain: +(g).toFixed(4) })
      }
    }
  }
  return rows
})
const by = {}
for (const r of out) (by[r.model] ??= []).push(r)
for (const [m, rs] of Object.entries(by)) {
  console.log(`\n${m}  (mono up-mix would be 1.0000)`)
  const hzs = [...new Set(rs.map((r) => r.hz))]
  console.log('   hz  ' + [0, 45, 90, 180].map((a) => String(a).padStart(8)).join(''))
  for (const hz of hzs) console.log(String(hz).padStart(5) + '  ' + [0, 45, 90, 180].map((a) => rs.find((r) => r.hz === hz && r.az === a).gain.toFixed(4).padStart(8)).join(''))
  const gs = rs.map((r) => r.gain)
  console.log(`  min ${Math.min(...gs).toFixed(4)}  max ${Math.max(...gs).toFixed(4)}  spread ${(Math.max(...gs) / Math.min(...gs)).toFixed(2)}×`)
}
await browser.close()
