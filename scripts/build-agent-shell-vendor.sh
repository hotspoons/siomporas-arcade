#!/usr/bin/env bash
# Rebuild apps/corridor/public/agent/vendor/: just-bash (Apache-2.0) + quickjs-emscripten (MIT) bundled into one
# browser ESM with esbuild; the QuickJS wasm sits next to it (the module resolves it via import.meta.url).
#
# This is the shell the in-editor agent gets — a real busybox-shaped coreutils over an in-memory
# filesystem, with the editor's own documents projected into it. Ported from zip-ties
# (scripts/build_computer_vendor.sh), where Rich built it first; the bundle is checked in because
# it is a build of two pinned packages and rebuilding it on every clone is 90 seconds of npm for a
# file that changes when we change the pins.
#
# Pyodide is loaded from jsDelivr by default; `--pyodide` also downloads the runtime and the
# preloaded packages (Pillow, PyYAML, numpy, micropip and what they need) into
# apps/corridor/public/agent/vendor/pyodide/ (gitignored, ~40 MB), which the app prefers over the
# CDN when it is there — which is what an air-gapped cluster needs.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "${1:-}" = "--pyodide" ]; then
  ver="${PYODIDE_VERSION:-0.28.3}"
  base="https://cdn.jsdelivr.net/pyodide/v${ver}/full/"
  out="apps/corridor/public/agent/vendor/pyodide"
  mkdir -p "$out"
  for f in pyodide.mjs pyodide.asm.js pyodide.asm.wasm python_stdlib.zip pyodide-lock.json; do
    echo ">>> $f"; curl -fsSL "$base$f" -o "$out/$f"
  done
  python3 - "$out" "$base" <<'PY'
import json, sys, urllib.request
out, base = sys.argv[1], sys.argv[2]
lock = json.load(open(f"{out}/pyodide-lock.json"))["packages"]
want, seen = ["pillow", "pyyaml", "numpy", "micropip"], set()
while want:
    name = want.pop()
    if name in seen or name not in lock:
        continue
    seen.add(name)
    want += lock[name].get("depends", [])
    fn = lock[name]["file_name"]
    print(">>>", fn)
    urllib.request.urlretrieve(base + fn, f"{out}/{fn}")
PY
  ls -la "$out" | head -20
  exit 0
fi
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp apps/corridor/public/agent/vendor/ENTRY.mjs "$work/entry.mjs"
cd "$work"
npm init -y >/dev/null
npm install --silent just-bash@3.4.2 quickjs-emscripten@0.32.0 esbuild >/dev/null
cat > zlib-shim.mjs <<'JS'
const no = () => { throw new Error('gzip is not available in the browser computer'); };
export const constants = {}; export const gunzipSync = no; export const gzipSync = no;
export default { constants, gunzipSync, gzipSync };
JS
npx esbuild entry.mjs --bundle --format=esm --platform=browser --target=es2022 --minify --outfile=computer-vendor.js --alias:node:zlib=./zlib-shim.mjs
cd - >/dev/null
cp "$work/computer-vendor.js" apps/corridor/public/agent/vendor/computer-vendor.js
cp "$work/node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm" apps/corridor/public/agent/vendor/emscripten-module.wasm
ls -la apps/corridor/public/agent/vendor/
