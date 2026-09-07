// Course authoring preview: top-down and side elevation of a baked track, with
// segment types coloured, gates, boost strips, rings and split branches.
// Dev-only page: http://localhost:5180/tools/preview.html

import { COURSES } from '../src/sim/track/courses/index'
import { buildTrack } from '../src/sim/track/TrackBuilder'
import { makeFrame } from '../src/sim/track/TrackSpline'
import type { SegmentType } from '../src/sim/track/SegmentDesc'

const COLORS: Record<SegmentType, string> = {
  TUBE: '#25e8ff',
  HALFPIPE: '#7ff6ff',
  OPEN: '#ffc857',
  BERM_IN: '#ffa040',
  BERM_OUT: '#ffa040',
  GAP: '#ff3b5c',
  SPLIT: '#c46bff',
  GATE: '#ffffff',
}

const canvas = document.getElementById('c') as HTMLCanvasElement
const select = document.getElementById('course') as HTMLSelectElement
const info = document.getElementById('info')!
for (const c of COURSES) {
  const o = document.createElement('option')
  o.value = c.id
  o.textContent = c.name
  select.appendChild(o)
}
select.addEventListener('change', draw)
window.addEventListener('resize', draw)
draw()

function draw(): void {
  const course = COURSES.find((c) => c.id === select.value) ?? COURSES[0]
  const track = buildTrack(course)
  const dpr = window.devicePixelRatio || 1
  canvas.width = canvas.clientWidth * dpr
  canvas.height = canvas.clientHeight * dpr
  const ctx = canvas.getContext('2d')!
  ctx.scale(dpr, dpr)
  const W = canvas.clientWidth
  const H = canvas.clientHeight
  ctx.clearRect(0, 0, W, H)

  // Bounds.
  const f = makeFrame()
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity
  for (let s = 0; s <= track.length; s += 10) {
    track.frameAt(s, 0, f)
    minX = Math.min(minX, f.pos.x); maxX = Math.max(maxX, f.pos.x)
    minZ = Math.min(minZ, f.pos.z); maxZ = Math.max(maxZ, f.pos.z)
    minY = Math.min(minY, f.pos.y); maxY = Math.max(maxY, f.pos.y)
  }
  const topH = H * 0.68
  const pad = 30
  const scale = Math.min((W - pad * 2) / Math.max(1, maxX - minX), (topH - pad * 2) / Math.max(1, maxZ - minZ))
  const tx = (x: number) => pad + (x - minX) * scale
  const tz = (z: number) => topH - pad - (z - minZ) * scale
  const sideScale = (W - pad * 2) / track.length
  const yScale = (H - topH - pad * 2) / Math.max(40, maxY - minY)
  const sx = (s: number) => pad + s * sideScale
  const sy = (y: number) => H - pad - (y - minY) * yScale

  const segOf = (s: number) => track.segmentAt(s)
  for (const branch of [0, 1]) {
    ctx.lineWidth = branch ? 2 : 3
    let prev: { x: number; z: number; s: number; y: number } | null = null
    for (let s = 0; s <= track.length; s += 6) {
      const seg = segOf(s)
      if (branch === 1 && !(seg.type === 'SPLIT' && seg.branch)) { prev = null; continue }
      track.frameAt(s, branch, f)
      const p = { x: f.pos.x, z: f.pos.z, s, y: f.pos.y }
      if (prev) {
        ctx.strokeStyle = COLORS[seg.type]
        ctx.globalAlpha = seg.type === 'GAP' ? 0.5 : 1
        ctx.beginPath(); ctx.moveTo(tx(prev.x), tz(prev.z)); ctx.lineTo(tx(p.x), tz(p.z)); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(sx(prev.s), sy(prev.y)); ctx.lineTo(sx(p.s), sy(p.y)); ctx.stroke()
        ctx.globalAlpha = 1
      }
      prev = p
    }
  }
  // Gates, boosts, rings.
  for (const g of track.gates) {
    track.frameAt(g, 0, f)
    ctx.fillStyle = '#fff'
    ctx.beginPath(); ctx.arc(tx(f.pos.x), tz(f.pos.z), 5, 0, Math.PI * 2); ctx.fill()
    ctx.fillRect(sx(g) - 1, sy(f.pos.y) - 12, 2, 24)
  }
  ctx.strokeStyle = '#ff5fd2'
  ctx.lineWidth = 6
  for (const b of track.boosts) {
    ctx.beginPath()
    for (let s = b.sStart; s <= b.sEnd; s += 6) {
      track.frameAt(s, 0, f)
      if (s === b.sStart) ctx.moveTo(tx(f.pos.x), tz(f.pos.z))
      else ctx.lineTo(tx(f.pos.x), tz(f.pos.z))
    }
    ctx.stroke()
  }
  ctx.fillStyle = '#ffd45f'
  for (const r of track.rings) { ctx.beginPath(); ctx.arc(tx(r.pos.x), tz(r.pos.z), 3, 0, Math.PI * 2); ctx.fill() }
  // Labels.
  ctx.fillStyle = '#9fb8c8'
  ctx.font = '11px ui-monospace, monospace'
  for (const seg of track.segments) {
    if (seg.type === 'GATE') continue
    track.frameAt((seg.sStart + seg.sEnd) / 2, 0, f)
    ctx.fillText(`${seg.type}${seg.difficulty ? ' ' + seg.difficulty : ''}`, tx(f.pos.x) + 6, tz(f.pos.z) - 6)
  }
  ctx.fillText('top-down (x,z)', pad, 16)
  ctx.fillText('side elevation (s, y)', pad, topH + 12)
  info.textContent = `${course.name}: ${(track.length / 1000).toFixed(2)} km · ${track.segments.length} segments · ${track.gates.length} gates · ${track.boosts.length} boosts · ${track.rings.length} rings`
}
