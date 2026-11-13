#!/bin/sh
# Shared PR/release checks: image, architecture (amd64/arm64), target (default/browser).
set -eu
image="$1"
arch="linux/$2"
variant="$3"
case "$variant" in default|browser) ;; *) exit 2 ;; esac

docker run --rm --platform "$arch" \
  -v "$PWD/app:/opt/codex-terminal/app:ro" \
  -v "$PWD/test:/opt/codex-terminal/test:ro" \
  -v "$PWD/scripts:/opt/codex-terminal/scripts:ro" \
  -w /opt/codex-terminal "$image" \
  sh -c 'node --test --test-timeout=30000 test/*.test.mjs'

for check in smoke herdr-state-smoke; do
  docker run --rm --platform "$arch" \
    -v "$PWD/scripts:/tmp/checks:ro" "$image" node "/tmp/checks/$check.mjs"
done

state="$(docker volume create)"
workspace="$(docker volume create)"
codex="$(docker volume create)"
trap 'docker volume rm "$state" "$workspace" "$codex"' EXIT
docker run --rm --platform "$arch" --user root \
  -v "$state:/smoke-state" -v "$workspace:/workspace" -v "$codex:/home/node/.codex" \
  "$image" chown node:node /smoke-state /workspace /home/node/.codex
for phase in save restore; do
  docker run --rm --platform "$arch" -v "$state:/smoke-state" \
    -e SMOKE_STATE_HOME=/smoke-state -e SMOKE_STATE_PHASE="$phase" \
    -v "$PWD/scripts:/tmp/checks:ro" "$image" node /tmp/checks/herdr-state-smoke.mjs
done

if [ "$variant" = browser ]; then
  docker run --rm --platform "$arch" --network none \
    -v "$workspace:/workspace" -v "$codex:/home/node/.codex" \
    -v "$PWD/scripts:/tmp/checks:ro" "$image" node /tmp/checks/browser-smoke.mjs
else
  docker run --rm --platform "$arch" "$image" sh -ec \
    'if command -v playwright-cli; then exit 1; fi; test ! -e /opt/playwright-browsers; test ! -e /usr/local/lib/node_modules/@playwright; test ! -e /home/node/.playwright/cli.config.json'
fi
