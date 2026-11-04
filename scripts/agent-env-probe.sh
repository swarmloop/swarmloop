#!/bin/sh
# Can the agent CLIs start inside a project image?
# Usage: scripts/agent-env-probe.sh <image>...   (for example: node:22-bookworm-slim php:8.3-cli node:22-alpine)
# Needs the agent images from docker/sandbox/build.sh. Copies /opt/swarmloop out of each agent image into a
# temporary volume and runs "<cli> --version" in every given image, the way swarmloop will mount it.
set -u
if [ "$#" -eq 0 ]; then
  echo "usage: $0 <image>..." >&2
  exit 1
fi
failed=0
for image in "$@"; do
  docker image inspect "$image" >/dev/null 2>&1 || docker pull -q "$image" >/dev/null || failed=1
done
for pair in claude:claude cursor:agent codex:codex; do
  runtime=${pair%%:*}
  cli=${pair#*:}
  agent="swarmloop-agent-$runtime"
  volume="swarmloop-probe-$runtime"
  if ! docker image inspect "$agent" >/dev/null 2>&1; then
    echo "SKIP $runtime: $agent is missing, run docker/sandbox/build.sh"
    continue
  fi
  docker volume rm -f "$volume" >/dev/null 2>&1
  docker volume create "$volume" >/dev/null
  if ! docker run --rm --network none --user 0:0 --mount "type=volume,src=$volume,dst=/out" --entrypoint sh "$agent" \
    -c 'cp -a /opt/swarmloop/. /out/' >/dev/null 2>&1; then
    echo "FAIL $runtime: $agent has no /opt/swarmloop, rebuild it with docker/sandbox/build.sh"
    failed=1
    continue
  fi
  for image in "$@"; do
    out=$(docker run --rm --network none --user 1000:1000 \
      --tmpfs /home/sandbox:rw,uid=1000,gid=1000,mode=700 --env HOME=/home/sandbox \
      --env SSL_CERT_FILE=/opt/swarmloop/certs/ca-certificates.crt \
      --env NODE_EXTRA_CA_CERTS=/opt/swarmloop/certs/ca-certificates.crt \
      --mount "type=volume,src=$volume,dst=/opt/swarmloop,readonly=true" \
      --entrypoint /opt/swarmloop/bin/"$cli" "$image" --version 2>&1)
    code=$?
    line=$(printf '%s\n' "$out" | tail -n 2 | tr '\n' ' ')
    if [ "$code" -eq 0 ]; then
      echo "OK   $runtime in $image: $line"
    else
      echo "FAIL $runtime in $image (exit $code): $line"
      failed=1
    fi
  done
  docker volume rm -f "$volume" >/dev/null 2>&1
done
exit "$failed"
