#!/usr/bin/env node
// A stable local front for a dev server that comes and goes.
//
// cloudflared quick tunnels bind to ONE local port and die with it: restart Vite and the phone
// gets a dead URL. Point the tunnel here instead. This forwards HTTP and WebSocket upgrades (Vite
// HMR) to the target, and while the target is down it answers 503 with a page that retries every
// few seconds — so the URL survives `npm run dev` restarts, crashes and port fights.
//
//   node scripts/devproxy.mjs --listen 5190 --target 5185
//   cloudflared tunnel --url http://127.0.0.1:5190
import http from 'node:http'
import net from 'node:net'

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const LISTEN = Number(arg('listen', 5190))
const TARGET = Number(arg('target', 5185))
const HOST = arg('host', '127.0.0.1')

const waitPage = (path) => `<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=3>
<title>dev server restarting</title><body style="background:#0d0f12;color:#9aa0a6;font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><div style="color:#ffdc00;letter-spacing:.1em">corridor</div><p>dev server on :${TARGET} is not answering — retrying every 3 s</p><p style="color:#555">${path}</p></div>`

const server = http.createServer((req, res) => {
  const up = http.request({ host: HOST, port: TARGET, method: req.method, path: req.url, headers: { ...req.headers, host: `${HOST}:${TARGET}` } }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers)
    r.pipe(res)
  })
  up.on('error', () => {
    if (res.headersSent) return res.destroy()
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '3' })
    res.end(waitPage(req.url ?? '/'))
  })
  req.pipe(up)
})

// WebSocket (Vite HMR): splice the raw sockets together
server.on('upgrade', (req, socket, head) => {
  const up = net.connect(TARGET, HOST, () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
    for (const [k, v] of Object.entries(req.headers)) lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    up.write(lines.join('\r\n') + '\r\n\r\n')
    if (head.length) up.write(head)
    socket.pipe(up).pipe(socket)
  })
  const drop = () => { socket.destroy(); up.destroy() }
  up.on('error', drop)
  socket.on('error', drop)
})

server.listen(LISTEN, '0.0.0.0', () => console.log(`devproxy :${LISTEN} -> ${HOST}:${TARGET}`))
