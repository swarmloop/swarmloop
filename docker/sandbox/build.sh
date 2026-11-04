#!/bin/sh
# Builds the agent images. Docker reuses cached layers, so a plain run does not fetch a newer CLI or newer
# CA certificates. Use --fresh for that: it pulls the base image again and rebuilds every layer.
# The last image is the egress proxy, the only way out of a sandbox.
set -eu
dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
fresh=""
case "${1:-}" in
  "") ;;
  --fresh) fresh="--pull --no-cache" ;;
  *) echo "usage: $0 [--fresh]" >&2; exit 1 ;;
esac
for runtime in cursor claude codex; do
  # shellcheck disable=SC2086
  docker build $fresh -f "$dir/Dockerfile.$runtime" -t "swarmloop-agent-$runtime" "$dir"
done
# shellcheck disable=SC2086
docker build $fresh -t swarmloop-egress "$dir/../egress"
