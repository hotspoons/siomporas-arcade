#!/usr/bin/env bash
# Fetch Khronos' `ktx` encoder into tools/corridor/.bin — used to write the .ktx2 texture twins.
#
# Not vendored: it is a 7 MB binary plus shared libraries and the repo should not carry one. The
# bake skips KTX2 encoding entirely when it is absent, so this is optional — the .jpg fallback is
# always written. CORRIDOR_KTX overrides the location.
set -euo pipefail
VER="${KTX_VERSION:-4.4.2}"
case "$(uname -m)" in
  aarch64|arm64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=x86_64 ;;
  *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
esac
DEST="$(cd "$(dirname "$0")/.." && pwd)/.bin"
URL="https://github.com/KhronosGroup/KTX-Software/releases/download/v${VER}/KTX-Software-${VER}-Linux-${ARCH}.tar.bz2"
mkdir -p "$DEST"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
echo "fetching $URL"
curl -fsSL -o "$tmp/ktx.tar.bz2" "$URL"
tar xjf "$tmp/ktx.tar.bz2" -C "$tmp"
rm -rf "$DEST/KTX-Software"
mv "$tmp/KTX-Software-${VER}-Linux-${ARCH}" "$DEST/KTX-Software"
"$DEST/KTX-Software/bin/ktx" --version
echo "-> $DEST/KTX-Software/bin/ktx"
