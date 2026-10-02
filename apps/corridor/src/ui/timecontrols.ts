// The clock, as something you can set rather than only speed up.
//
// Rich, 2026-09-27: "we need a couple of time controls — date and time start offset (should
// constantly update with time acceleration)".
//
// Two fields, a button, and a day slider. What makes them worth their own file is the SECOND half
// of the original request: the fields show the SIMULATED time, which is running — at 600x a day
// goes by in four minutes — so they have to keep up without fighting the person typing in them. A
// field that rewrites itself under the cursor is unusable, and a field that stops updating while
// focused but never resumes is a lie.
//
// So: they refresh on a timer, they stop refreshing while focused, and they resume on blur. The
// day slider is the same: it follows the clock until a drag starts, and a drag owns it until the
// pointer comes up. The refresh is a `setTimeout` rather than a `requestAnimationFrame`, because
// rAF does not fire in a background tab and a clock that stops when you look away is the one
// thing a clock must not do (the same rule the rest of this app follows — see map.ts).

import { el } from './shell'

export interface TimeControlsOpts {
  /** the simulated time as local parts in the site's zone, and the offset from real time */
  read: () => { date: string; time: string; offsetMs: number; rate: number }
  /** set the simulated time from wall-clock parts */
  setLocal: (date: string, time: string) => void
  /** back to the real here and now */
  home: () => void
}

/** A day, in minutes. The track maps onto these, so a drag lands on the minute under the pixel rather than a twenty-minute stop. */
const DAY_MIN = 24 * 60

function minutesFromTime(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return ((h || 0) % 24) * 60 + (m || 0)
}

function timeFromMinutes(mins: number): string {
  const m = ((Math.round(mins) % DAY_MIN) + DAY_MIN) % DAY_MIN
  const h = Math.floor(m / 60)
  const min = m % 60
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

/** "+3 days 4 h", "-12 min", "real time" — the offset in words, which is what it is FOR. */
function offsetLabel(ms: number): string {
  const a = Math.abs(ms)
  if (a < 30000) return 'real time'
  const sign = ms > 0 ? '+' : '−'
  const min = Math.round(a / 60000)
  if (min < 90) return `${sign}${min} min`
  const hours = a / 3600000
  if (hours < 48) return `${sign}${hours.toFixed(1)} h`
  const days = a / 86400000
  if (days < 365) return `${sign}${days.toFixed(1)} days`
  return `${sign}${(days / 365.25).toFixed(2)} years`
}

export function timeControls(o: TimeControlsOpts): { el: HTMLElement; stop: () => void } {
  const wrap = el('div', 'timectl')
  const date = el('input', 'input') as HTMLInputElement
  date.type = 'date'
  const time = el('input', 'input') as HTMLInputElement
  time.type = 'time'
  // minutes, no seconds: the clock reads back in minutes, and a field asking for a precision it is
  // never given shows you a blank seconds box for ever
  const now = el('button', 'btn ghost timectl-now') as HTMLButtonElement
  now.type = 'button'
  now.textContent = 'now'
  now.title = 'back to the real date and time'
  const off = el('span', 'timectl-offset')

  // The whole day, one minute a step. The thumb still moves by pixels, and each pixel is the
  // minute underneath it. The time field remains for typing one exactly.
  const scrub = el('div', 'timectl-scrub')
  const scrubHead = el('div', 'timectl-scrub-head')
  const scrubRead = el('span', 'timectl-scrub-read')
  const slider = el('input', 'range') as HTMLInputElement
  slider.type = 'range'
  slider.min = '0'
  slider.max = String(DAY_MIN - 1)
  slider.step = '1'
  slider.setAttribute('aria-label', 'time of day')
  const marks = el('div', 'timectl-marks')
  for (const label of ['00', '06', '12', '18', '24']) marks.append(el('span', '', label))
  scrubHead.append(el('span', 'field-label', 'day'), scrubRead)
  scrub.append(scrubHead, slider, marks)

  const row = el('div', 'timectl-row')
  row.append(el('span', 'field-label', 'date'), date, el('span', 'field-label', 'time'), time, now)
  wrap.append(scrub, row, off)

  let dragging = false
  const push = () => {
    if (!date.value || !time.value) return
    o.setLocal(date.value, time.value)
  }
  const pushSlider = () => {
    const s = o.read()
    const t = timeFromMinutes(Number(slider.value))
    scrubRead.textContent = t
    if (time.value !== t) time.value = t
    o.setLocal(s.date, t)
  }
  date.onchange = push
  time.onchange = push
  slider.oninput = pushSlider
  const endDrag = () => {
    if (!dragging) return
    dragging = false
    refresh(true)
  }
  slider.addEventListener('pointerdown', () => { dragging = true })
  window.addEventListener('pointerup', endDrag)
  window.addEventListener('pointercancel', endDrag)
  now.onclick = () => {
    o.home()
    refresh(true)
  }

  // while a field has focus, or the day slider is being dragged, the person owns it
  const held = () => dragging || document.activeElement === date || document.activeElement === time || document.activeElement === slider
  function refresh(force = false) {
    const s = o.read()
    if (force || !held()) {
      if (date.value !== s.date) date.value = s.date
      if (time.value !== s.time) time.value = s.time
      const d = String(minutesFromTime(s.time))
      if (slider.value !== d) slider.value = d
      scrubRead.textContent = timeFromMinutes(Number(d))
    }
    off.textContent = s.rate === 1 ? offsetLabel(s.offsetMs) : `${offsetLabel(s.offsetMs)} · ${s.rate}× `
  }
  date.addEventListener('blur', () => refresh(true))
  time.addEventListener('blur', () => refresh(true))

  // four times a second is enough to read and cheap enough to ignore; setTimeout and not rAF so
  // it keeps running in a background tab
  let timer: ReturnType<typeof setTimeout> | null = null
  const loop = () => {
    // the next tick is scheduled whatever happens: a clock that stops for ever because one read
    // threw once is worse than a clock that shows the same wrong thing four times a second
    try {
      refresh()
    } finally {
      timer = setTimeout(loop, 250)
    }
  }
  loop()
  return {
    el: wrap,
    stop: () => {
      if (timer) clearTimeout(timer)
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
    },
  }
}
