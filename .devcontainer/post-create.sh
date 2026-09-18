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

# MAME, which the fighter's tooling drives headlessly: tools/sf2-probe boots the arcade boards,
# reads their memory and dumps their graphics ROMs, and scripts/rom-sprites.mjs draws the fighters
# out of what it finds. Nothing else needs it, and nothing breaks without it — but a container
# rebuild without this line means re-installing it by hand before any of that works again.
if ! command -v mame >/dev/null 2>&1 && [ ! -x /usr/games/mame ]; then
    (sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends mame) \
        || echo "WARN: mame install failed — tools/sf2-probe will not run"
fi

# cloudflared for `just tunnel` (anonymous quick tunnels; no account needed).
if ! command -v cloudflared >/dev/null 2>&1; then
    case "$(uname -m)" in aarch64|arm64) CF_ARCH=arm64 ;; *) CF_ARCH=amd64 ;; esac
    (curl -sSL -o /tmp/cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$CF_ARCH" \
        && chmod +x /tmp/cloudflared && sudo mv /tmp/cloudflared /usr/local/bin/cloudflared) \
        || echo "WARN: cloudflared install failed — 'just tunnel' will not work"
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
