#!/usr/bin/env bash
# Set up the dev environment for siomporas-arcade: a Vite/TypeScript + three.js
# game. Idempotent — safe to re-run.
set -euo pipefail

# just: the task runner (recipes live in ./justfile).
if ! command -v just >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y --no-install-recommends just
    sudo rm -rf /var/lib/apt/lists/*
fi

npm install

# Headless Chromium for the Playwright verification loop (agents drive the
# live dev server with it — see scripts/smoke.mjs). Deps go via sudo apt; the
# browser lands in the USER's cache (sudo would hide it under /root). Both
# best-effort so a flaky network can't kill container create.
(sudo npx playwright install-deps chromium && npx playwright install chromium) \
    || echo "WARN: playwright setup failed — run 'just browser' to retry"

# kubectl for the mounted ~/.kube config, with `k` aliased to it and bash
# completion for both names. Best-effort: no cluster access shouldn't block create.
if ! command -v kubectl >/dev/null 2>&1; then
    case "$(uname -m)" in aarch64|arm64) K8S_ARCH=arm64 ;; *) K8S_ARCH=amd64 ;; esac
    K8S_VERSION="$(curl -sSL https://dl.k8s.io/release/stable.txt)"
    (curl -sSL -o /tmp/kubectl "https://dl.k8s.io/release/$K8S_VERSION/bin/linux/$K8S_ARCH/kubectl" \
        && chmod +x /tmp/kubectl && sudo mv /tmp/kubectl /usr/local/bin/kubectl) \
        || echo "WARN: kubectl install failed"
fi

if command -v kubectl >/dev/null 2>&1; then
    kubectl completion bash | sudo tee /etc/bash_completion.d/kubectl >/dev/null
    # The alias needs its own completion binding, sourced after the script above.
    if ! grep -q "alias k=kubectl" ~/.bashrc; then
        cat >>~/.bashrc <<'EOF'

# kubectl
alias k=kubectl
complete -o default -F __start_kubectl k
EOF
    fi
fi

# helm: the world editor and the asset service on gh200-1 are Helm releases (tools/*/chart, values in
# deploy/gh200-1/), and a rollout is `helm upgrade` — without it, re-pinning an image means asking
# someone with a laptop. The release tarball from get.helm.sh, checked against its published sha256.
if ! command -v helm >/dev/null 2>&1; then
    case "$(uname -m)" in aarch64|arm64) HELM_ARCH=arm64 ;; *) HELM_ARCH=amd64 ;; esac
    (set -e
     HELM_VERSION="$(curl -fsSL https://get.helm.sh/helm-latest-version)"
     HELM_TGZ="helm-$HELM_VERSION-linux-$HELM_ARCH.tar.gz"
     cd "$(mktemp -d)"
     curl -fsSLO "https://get.helm.sh/$HELM_TGZ"
     echo "$(curl -fsSL "https://get.helm.sh/$HELM_TGZ.sha256sum" | awk '{print $1}')  $HELM_TGZ" | sha256sum -c -
     tar -xzf "$HELM_TGZ"
     sudo mv "linux-$HELM_ARCH/helm" /usr/local/bin/helm) \
        || echo "WARN: helm install failed — deploy/gh200-1 rollouts will not work"
fi
if command -v helm >/dev/null 2>&1; then
    helm completion bash | sudo tee /etc/bash_completion.d/helm >/dev/null
fi

# ll: the stock Debian .bashrc ships it commented out, and ~/.bashrc lives in the container layer,
# so every rebuild loses it again. The guard anchors at line start — `#alias ll=` is already in
# there and would otherwise make this look done.
if ! grep -q "^alias ll=" ~/.bashrc 2>/dev/null; then
    cat >>~/.bashrc <<'EOF'

# ls
alias ll='ls -alF'
EOF
fi

# MAME, which the fighter's tooling drives headlessly: tools/sf2-probe boots the arcade boards,
# reads their memory and dumps their graphics ROMs, and scripts/rom-sprites.mjs draws the fighters
# out of what it finds. Nothing else needs it, and nothing breaks without it — but a container
# rebuild without this line means re-installing it by hand before any of that works again.
if ! command -v mame >/dev/null 2>&1 && [ ! -x /usr/games/mame ]; then
    (sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends mame) \
        || echo "WARN: mame install failed — tools/sf2-probe will not run"
fi

# tools/corridor: the geo pipeline behind the real-road driving game. Python in a venv (this is a
# Node image; nothing else here wants Python packages) plus GDAL's CLI for warping DEMs. PDAL is
# not in Debian trixie on arm64, so the point-cloud reader is laspy+lazrs and the Entwine octree
# walk is done in corridor/lidar.py by hand. Idempotent: pip is a no-op once satisfied.
if ! command -v gdalwarp >/dev/null 2>&1 || ! python3 -c 'import venv' 2>/dev/null; then
    (sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gdal-bin python3-venv python3-pip) \
        || echo "WARN: gdal/venv install failed — tools/corridor will not run"
fi
if [ ! -x tools/corridor/.venv/bin/python ]; then
    python3 -m venv tools/corridor/.venv || echo "WARN: could not create tools/corridor/.venv"
fi
[ -x tools/corridor/.venv/bin/pip ] && (tools/corridor/.venv/bin/pip install -q -r tools/corridor/requirements.txt \
    || echo "WARN: corridor requirements failed — re-run: tools/corridor/.venv/bin/pip install -r tools/corridor/requirements.txt")

# cloudflared for `just tunnel` (anonymous quick tunnels; no account needed).
if ! command -v cloudflared >/dev/null 2>&1; then
    case "$(uname -m)" in aarch64|arm64) CF_ARCH=arm64 ;; *) CF_ARCH=amd64 ;; esac
    (curl -sSL -o /tmp/cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$CF_ARCH" \
        && chmod +x /tmp/cloudflared && sudo mv /tmp/cloudflared /usr/local/bin/cloudflared) \
        || echo "WARN: cloudflared install failed — 'just tunnel' will not work"
fi

# opencode: the coding agent this workspace is driven from. The binary sits in the container layer
# (~/.opencode/bin), so a rebuild drops it and leaves `opencode` missing until it's reinstalled by
# hand. State (config, auth, sessions) is bind-mounted from the host — see devcontainer.json — but
# the binary has to be fetched fresh for this container's architecture. Idempotent.
if ! command -v opencode >/dev/null 2>&1 && [ ! -x "$HOME/.opencode/bin/opencode" ]; then
    (curl -fsSL https://opencode.ai/install | bash) \
        || echo "WARN: opencode install failed — run: curl -fsSL https://opencode.ai/install | bash"
fi
# ~/.bashrc lives in the container layer too, so the installer's PATH line goes with it. Re-add it.
if [ -x "$HOME/.opencode/bin/opencode" ] && ! grep -q "\.opencode/bin" ~/.bashrc 2>/dev/null; then
    cat >>~/.bashrc <<'EOF'

# opencode
export PATH="$HOME/.opencode/bin:$PATH"
EOF
fi

# Blender, pinned by .devcontainer/blender.env. tools/rigging/rig_character.py needs >= 5.1 and
# Debian ships 4.3, so this either fetches the official binary (x86_64) or builds from source
# against Blender's own precompiled libraries (arm64, which blender.org does not ship).
#
# Backgrounded, because the source build is tens of minutes and nothing else here waits on it —
# container create finishes, the games run, and Blender appears when it appears. The script takes
# a lock, so a second run while one is in flight is a no-op. BLENDER_SKIP_INSTALL=1 opts out.
_HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
mkdir -p "$HOME/.cache"
# The build tree is a named volume (see devcontainer.json) so it outlives container rebuilds. Docker
# creates the volume root-owned AND materialises its parent directories root-owned to hang the mount
# on — so ~/.cache itself is not ours either, and the log redirect below is the first thing to hit
# that. Both, or the build never starts and leaves no log to say why.
for _d in "$HOME/.cache" "$HOME/.cache/blender-source"; do
    [ -d "$_d" ] && [ ! -w "$_d" ] && { sudo chown "$(id -u):$(id -g)" "$_d" || echo "WARN: could not chown $_d"; }
done
unset _d
nohup bash "$_HERE/build-blender.sh" > "$HOME/.cache/blender-build.log" 2>&1 &
echo "Blender install/build started in the background (log: ~/.cache/blender-build.log)"

# Say where that got to on each new shell: a build that died at 3am is otherwise invisible until
# something tries to rig a character and fails for a reason nobody connects to this.
if ! grep -q "blender-build-status" ~/.bashrc 2>/dev/null; then
    cat >>~/.bashrc <<'EOF'

# blender-build-status: the pinned Blender's state, reported once per shell.
if [ -f /workspaces/apex-conduit/.devcontainer/blender.env ]; then
    . /workspaces/apex-conduit/.devcontainer/blender.env
    _bl=$(command -v blender >/dev/null 2>&1 && blender --version 2>/dev/null | head -n1 | awk '{print $2}' || true)
    if [ "$_bl" != "$BLENDER_VERSION" ]; then
        if pgrep -f "build-blender.sh" >/dev/null 2>&1; then
            echo "[arcade] Blender ${BLENDER_VERSION} is still building (found: ${_bl:-none})."
            echo "[arcade] Watch it:  tail -f ~/.cache/blender-build.log"
        else
            echo "[arcade] Blender ${BLENDER_VERSION} is not installed (found: ${_bl:-none}); tools/rigging needs it."
            echo "[arcade] Check ~/.cache/blender-build.log, then: just blender"
        fi
    fi
    unset _bl
fi
EOF
fi

echo "Done. \`just dev\` starts the dev server on :5180; \`just tunnel\` shares it."
