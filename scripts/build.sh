#!/bin/sh
# Always resolve npm's stable latest tag, even when other stages are cached.
set -eu
exec docker buildx build "$@" --no-cache-filter remobi
