#!/bin/sh
# Refresh stable Herdr and Remobi releases even when other stages are cached.
set -eu
exec docker buildx build "$@" --no-cache-filter remobi,herdr
