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
# Image labels. A CLAUDE_VERSION, CODEX_VERSION or CURSOR_VERSION in the env overrides the Dockerfile default.
revision="${REVISION:-$(git -C "$dir" rev-parse HEAD 2>/dev/null || echo unknown)}"
labels="--build-arg REVISION=$revision --build-arg VERSION=${VERSION:-dev} --build-arg SOURCE_URL=${SOURCE_URL:-unknown}"
for runtime in cursor claude codex; do
  upper=$(echo "$runtime" | tr '[:lower:]' '[:upper:]')
  eval "cli_version=\${${upper}_VERSION:-}"
  version_arg=""
  [ -z "$cli_version" ] || version_arg="--build-arg ${upper}_VERSION=$cli_version"
  # shellcheck disable=SC2086
  docker build $fresh $labels $version_arg -f "$dir/Dockerfile.$runtime" -t "swarmloop-agent-$runtime" "$dir"
done
# shellcheck disable=SC2086
docker build $fresh $labels -t swarmloop-egress "$dir/../egress"
