#!/bin/sh
# Refresh stable Herdr, Remobi and browser tooling even with cached stages.
set -eu
exec docker buildx build "$@" --no-cache-filter remobi,herdr,browser
