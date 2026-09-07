#!/usr/bin/env bash
# Set up the dev environment for apex-conduit: a Vite/TypeScript + three.js
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

echo "Done. \`just dev\` starts the dev server on :5180."
