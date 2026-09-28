// The in-editor agent's shell, worker side: coreutils (just-bash) over one in-memory filesystem,
// with `python` (Pyodide, loaded on first use), `js` (QuickJS) and `publish` as commands on the
// same files.
//
// PORTED FROM ZIP-TIES, where Rich built it first (zip-ties-ui/static/js/lib/computer/worker.js)
// and told us to copy it rather than invent a second one. What changed for corridor is the two
// vendor paths and what /workspace holds: there it is a conversation's attachments, here it is the
// editor's own documents — the worlds, the levels, the programs, the presets — projected in by
// src/agent/projection.ts and written back through the editor's API.
//
// NOTHING HERE CAN REACH THE NETWORK. just-bash ships no networking, Pyodide's fetchers are
// removed, QuickJS has no host bindings but the file bridge, and `sealNetwork` below closes every
// remaining door before any command runs — because Python's `js` module reaches this worker's
// globals, so a script could otherwise call the editor's API with the page's own credentials.
import { Bash, InMemoryFs, defineCommand, newQuickJSWASMModuleFromVariant, quickjsVariant } from './vendor/computer-vendor.js';

const ROOT = '/workspace';

let fs, bash, pyodide, pyodideLoading, quickjs, motd = '', cwd = ROOT, pyodideUrl = 'https://cdn.jsdelivr.net/pyodide/v0.28.3/full/';
const stamps = new Map();
const QUOTA = { files: 500, bytes: 64 * 1024 * 1024 };
let overQuota = '';

const post = (m) => self.postMessage(m);
const isDir = (st) => (typeof st.isDirectory === 'function' ? st.isDirectory() : st.isDirectory === true || st.type === 'directory' || st.type === 'dir');
const isText = (b) => { const n = Math.min(b.length, 1024); for (let i = 0; i < n; i++) { const c = b[i]; if (c === 0 || (c < 7) || (c > 13 && c < 32 && c !== 27)) return false; } return true; };

async function walk(dir) {
  const out = [];
  let names; try { names = await fs.readdir(dir); } catch { return out; }
  for (const n of names) {
    const p = `${dir}/${n}`;
    let st; try { st = await fs.stat(p); } catch { continue; }
    if (isDir(st)) out.push(...await walk(p)); else out.push([p, st]);
  }
  return out;
}
async function snapshot() { const m = new Map(); for (const [p, st] of await walk(ROOT)) m.set(p, +new Date(st.mtime) + ':' + (st.size ?? 0)); return m; }
async function changedSince(before) {
  const now = await snapshot(); const changed = [];
  let bytes = 0; for (const [p, s] of now) { if (before.get(p) !== s) changed.push(p); bytes += +s.split(':')[1] || 0; }
  const removed = [...before.keys()].filter((p) => !now.has(p));
  stamps.clear(); for (const [k, v] of now) stamps.set(k, v);
  overQuota = now.size > QUOTA.files ? `computer: over quota (${now.size} files, limit ${QUOTA.files}); remove some under /workspace before running more`
    : bytes > QUOTA.bytes ? `computer: over quota (${(bytes / 1048576).toFixed(1)} MB, limit ${QUOTA.bytes / 1048576} MB); remove some under /workspace before running more` : '';
  return { changed, removed, quota: { files: now.size, bytes } };
}

// -- python (Pyodide): the VFS is mirrored into Pyodide's FS before a run and back after -------------------------
async function loadPy() {
  if (pyodide) return pyodide;
  if (!pyodideLoading) pyodideLoading = (async () => {
    post({ type: 'status', text: 'loading Python (Pyodide, ~15 MB, once)…' });
    const mod = await import(/* @vite-ignore */ `${pyodideUrl}pyodide.mjs`);
    const py = await mod.loadPyodide({ indexURL: pyodideUrl });
    try { await py.loadPackage(['Pillow', 'pyyaml', 'numpy'], { messageCallback: () => {} }); } catch (e) { post({ type: 'status', text: `packages: ${e.message}` }); }
    py.runPython(`import sys, builtins\nfor m in ('pyodide.http', 'pyodide_js'):\n    sys.modules.pop(m, None)\nimport pyodide\nif hasattr(pyodide, 'http'): pyodide.http = None`);
    try { py.FS.mkdirTree(ROOT); } catch {}
    post({ type: 'status', text: 'Python ready' });
    return py;
  })();
  return (pyodide = await pyodideLoading);
}
async function vfsToPy(py) {
  for (const [p] of await walk(ROOT)) {
    const dir = p.slice(0, p.lastIndexOf('/')); try { py.FS.mkdirTree(dir); } catch {}
    py.FS.writeFile(p, await fs.readFileBuffer(p));
  }
}
function pyWalk(py, dir) {
  const out = []; let names; try { names = py.FS.readdir(dir); } catch { return out; }
  for (const n of names) { if (n === '.' || n === '..') continue; const p = `${dir}/${n}`; const st = py.FS.stat(p); if (py.FS.isDir(st.mode)) out.push(...pyWalk(py, p)); else out.push(p); }
  return out;
}
async function pyToVfs(py) {
  for (const p of pyWalk(py, ROOT)) {
    const bytes = py.FS.readFile(p);
    let same = false;
    try { const cur = await fs.readFileBuffer(p); same = cur.length === bytes.length && cur.every((b, i) => b === bytes[i]); } catch {}
    if (!same) { await fs.mkdir(p.slice(0, p.lastIndexOf('/')), { recursive: true }); await fs.writeFile(p, bytes); }
  }
}
const python = defineCommand('python', async (args, ctx) => {
  let py;
  try { py = await loadPy(); } catch (e) { return { stdout: '', stderr: `python: cannot load the interpreter: ${e.message}\n`, exitCode: 127 }; }
  let code;
  if (args[0] === '-c') code = args.slice(1).join(' ');
  else if (args[0] === '-m' && args[1] === 'micropip') { try { await py.loadPackage('micropip'); const mp = py.pyimport('micropip'); await mp.install(args.slice(3)); return { stdout: `installed ${args.slice(3).join(' ')}\n`, stderr: '', exitCode: 0 }; } catch (e) { return { stdout: '', stderr: `micropip: ${e.message}\n`, exitCode: 1 }; } }
  else if (args[0]) { try { code = await fs.readFile(fs.resolvePath(ctx.cwd || ROOT, args[0])); } catch { return { stdout: '', stderr: `python: can't open file '${args[0]}'\n`, exitCode: 2 }; } }
  else code = ctx.stdin ? String(ctx.stdin) : '';
  await vfsToPy(py);
  let out = '', err = '';
  py.setStdout({ batched: (s) => { out += s + '\n'; } }); py.setStderr({ batched: (s) => { err += s + '\n'; } });
  let exitCode = 0;
  try {
    py.runPython(`import os, sys\nos.chdir(${JSON.stringify(ctx.cwd || ROOT)})\nsys.argv = ${JSON.stringify(args[0] && args[0] !== '-c' ? args : ['-c'])}`);
    await py.runPythonAsync(code);
  } catch (e) { err += String(e.message || e) + '\n'; exitCode = 1; }
  await pyToVfs(py);
  return { stdout: out, stderr: err, exitCode };
}, { trusted: true });
const python3 = defineCommand('python3', (a, c) => python.execute(a, c), { trusted: true });

// -- js (QuickJS): a sandboxed interpreter with a file bridge (snapshot in, writes out) ------------------------
async function loadJs() { return (quickjs ||= await newQuickJSWASMModuleFromVariant(quickjsVariant)); }
const js = defineCommand('js', async (args, ctx) => {
  let code;
  if (args[0] === '-e') code = args.slice(1).join(' ');
  else if (args[0]) { try { code = await fs.readFile(fs.resolvePath(ctx.cwd || ROOT, args[0])); } catch { return { stdout: '', stderr: `js: cannot open ${args[0]}\n`, exitCode: 2 }; } }
  else code = ctx.stdin ? String(ctx.stdin) : '';
  const QJS = await loadJs(); const vm = QJS.newContext(); const logs = [];
  const files = {}; for (const [p] of await walk(ROOT)) { try { const b = await fs.readFileBuffer(p); if (isText(b)) files[p] = new TextDecoder().decode(b); } catch {} }
  const writes = {};
  const log = vm.newFunction('log', (...a) => { logs.push(a.map((h) => vm.dump(h)).map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ')); });
  const con = vm.newObject(); vm.setProp(con, 'log', log); vm.setProp(con, 'error', log); vm.setProp(vm.global, 'console', con); log.dispose(); con.dispose();
  const rf = vm.newFunction('readFile', (h) => { const p = vm.dump(h); return p in files ? vm.newString(files[p]) : vm.undefined; });
  const wf = vm.newFunction('writeFile', (h, c) => { writes[vm.dump(h)] = String(vm.dump(c)); });
  vm.setProp(vm.global, 'readFile', rf); vm.setProp(vm.global, 'writeFile', wf); rf.dispose(); wf.dispose();
  const filesH = vm.newString(JSON.stringify(Object.keys(files))); vm.setProp(vm.global, '__files', filesH); filesH.dispose();
  vm.runtime.setMemoryLimit(64 * 1024 * 1024); vm.runtime.setMaxStackSize(1024 * 512);
  let exitCode = 0, err = '';
  const r = vm.evalCode(`(function(){ globalThis.files = JSON.parse(__files); ${code}\n})()`, 'script.js');
  if (r.error) { err = String(vm.dump(r.error)?.message || vm.dump(r.error)) + '\n'; r.error.dispose(); exitCode = 1; } else r.value.dispose();
  vm.dispose();
  for (const [p, c] of Object.entries(writes)) { const abs = fs.resolvePath(ctx.cwd || ROOT, p); await fs.mkdir(abs.slice(0, abs.lastIndexOf('/')), { recursive: true }); await fs.writeFile(abs, c); }
  return { stdout: logs.length ? logs.join('\n') + '\n' : '', stderr: err, exitCode };
}, { trusted: true });

const publish = defineCommand('publish', async (args, ctx) => {
  if (!args[0]) return { stdout: '', stderr: 'usage: publish <path> [title…]\n', exitCode: 2 };
  const p = fs.resolvePath(ctx.cwd || ROOT, args[0]);
  let bytes; try { bytes = await fs.readFileBuffer(p); } catch { return { stdout: '', stderr: `publish: ${args[0]}: no such file\n`, exitCode: 1 }; }
  post({ type: 'publish', path: p, title: args.slice(1).join(' ') || p.split('/').pop(), bytes }, [bytes.buffer]);
  return { stdout: `published ${p} (${bytes.length} bytes)\n`, stderr: '', exitCode: 0 };
}, { trusted: true });

async function seed(files) {
  for (const [p, content] of Object.entries(files || {})) {
    const abs = p.startsWith('/') ? p : `${ROOT}/${p}`;
    await fs.mkdir(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
    await fs.writeFile(abs, typeof content === 'string' ? content : new Uint8Array(content));
  }
}

// -- no network for what runs on the machine (27 §3) ---------------------------------------------------------------
// Python's `js` module reaches this worker's globals, so a script could otherwise fetch the gateway API (on a dev box
// the loopback authenticator makes that admin) or post data anywhere. The loader keeps a private fetch limited to the
// Python runtime's own files and PyPI (micropip); every other network door in the worker is closed before any command.
const REAL_FETCH = self.fetch.bind(self);
const VENDOR = new URL('./vendor/', import.meta.url).href;
function netAllowed(url) {
  let u; try { u = new URL(String(url), self.location.href); } catch { return false; }
  if (pyodideUrl && u.href.startsWith(new URL(pyodideUrl, self.location.href).href)) return true;
  if (u.href.startsWith(VENDOR)) return true;  // the machine's own static files (QuickJS's wasm, a vendored Pyodide)
  return u.protocol === 'https:' && ['pypi.org', 'files.pythonhosted.org', 'cdn.jsdelivr.net'].includes(u.hostname)
    && (u.hostname !== 'cdn.jsdelivr.net' || u.pathname.startsWith('/pyodide/'));
}
function sealNetwork() {
  const guarded = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? String(input);
    if (!netAllowed(url)) return Promise.reject(new TypeError(`network is not available on the browser computer (${url})`));
    return REAL_FETCH(input, { ...(init || {}), credentials: 'omit' });
  };
  try { Object.defineProperty(self, 'fetch', { value: guarded, writable: false, configurable: false }); } catch { self.fetch = guarded; }
  for (const k of ['XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'BroadcastChannel', 'RTCPeerConnection']) {
    try { Object.defineProperty(self, k, { value: undefined, writable: false, configurable: false }); } catch { try { self[k] = undefined; } catch {} }
  }
}
sealNetwork();

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      if (m.pyodideUrl) pyodideUrl = m.pyodideUrl.endsWith('/') ? m.pyodideUrl : m.pyodideUrl + '/';
      motd = m.motd || '';
      fs = new InMemoryFs();
      await fs.mkdir(`${ROOT}/out`, { recursive: true }); await fs.mkdir('/etc', { recursive: true }); await fs.writeFile('/etc/motd', motd);
      bash = new Bash({ fs, cwd: ROOT, customCommands: [python, python3, js, publish], env: { HOME: ROOT, USER: 'agent', TERM: 'dumb' } });
      await seed(m.files);
      const s = await snapshot(); stamps.clear(); for (const [k, v] of s) stamps.set(k, v);
      post({ type: 'ready', motd });
    } else if (m.type === 'exec') {
      const before = new Map(stamps);
      const t0 = Date.now();
      if (overQuota && !/^\s*(rm|rmdir|ls|du|find|cat|head|tail|wc|echo|pwd|cd)\b/.test(m.cmd)) { post({ type: 'result', id: m.id, stdout: '', stderr: overQuota + '\n', exitCode: 122, ms: 0, cwd, changed: [], removed: [] }); return; }
      // the panel's shell keeps its working directory between commands (an explicit cwd — the agent's terminal/create —
      // is one-off): the command runs in it and reports where it ended up
      const here = m.cwd || cwd;
      const r = await bash.exec(`${m.cmd}\nprintf '\\001%s\\001' "$PWD"`, { cwd: here });
      let stdout = r.stdout || '';
      const mark = stdout.lastIndexOf('\u0001');
      if (mark >= 0) { const head = stdout.lastIndexOf('\u0001', mark - 1); if (head >= 0) { const at = stdout.slice(head + 1, mark); stdout = stdout.slice(0, head); if (!m.cwd && at) cwd = at; } }
      const delta = await changedSince(before);
      post({ type: 'result', id: m.id, stdout, stderr: r.stderr, exitCode: r.exitCode, ms: Date.now() - t0, cwd: m.cwd ? cwd : cwd, ...delta });
    } else if (m.type === 'read') {
      const p = m.path.startsWith('/') ? m.path : `${ROOT}/${m.path}`;
      try { const b = await fs.readFileBuffer(p); post({ type: 'file', id: m.id, path: p, bytes: b, text: isText(b) ? new TextDecoder().decode(b) : null }, [b.buffer]); }
      catch (e) { post({ type: 'file', id: m.id, path: p, error: String(e.message || e) }); }
    } else if (m.type === 'write') {
      const p = m.path.startsWith('/') ? m.path : `${ROOT}/${m.path}`;
      await fs.mkdir(p.slice(0, p.lastIndexOf('/')), { recursive: true });
      await fs.writeFile(p, typeof m.content === 'string' ? m.content : new Uint8Array(m.content));
      const delta = await changedSince(new Map(stamps));
      post({ type: 'wrote', id: m.id, path: p, ...delta });
    } else if (m.type === 'list') {
      const rows = []; for (const [p, st] of await walk(ROOT)) rows.push({ path: p, size: st.size ?? 0, mtime: +new Date(st.mtime) });
      post({ type: 'listing', id: m.id, files: rows });
    } else if (m.type === 'warm-python') { await loadPy(); post({ type: 'result', id: m.id, stdout: '', stderr: '', exitCode: 0, changed: [], removed: [] }); }
  } catch (e) {
    const text = `computer: ${e && e.message ? e.message : e}`;
    if (m.type === 'init') post({ type: 'status', text: `${text} (the machine did not start)` });
    post({ type: 'result', id: m.id, stdout: '', stderr: text + '\n', exitCode: 70, changed: [], removed: [] });
  }
};
