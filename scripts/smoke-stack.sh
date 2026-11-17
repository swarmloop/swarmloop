#!/usr/bin/env bash
# Starts compose.yml alone, with no .env, in an empty directory and checks the stack answers.
# The caller exports SWARMLOOP_REGISTRY and SWARMLOOP_VERSION of images that are already on this host.
set -eu

repo="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
mkdir -p "$work/home" "$work/checkouts/fixture" "$work/stack"
git -C "$work/checkouts/fixture" init -q
git -C "$work/checkouts/fixture" -c user.name=ci -c user.email=ci@example.com commit -q --allow-empty -m fixture
cp "$repo/compose.yml" "$work/stack/compose.yml"
# No person exists in this stack: only what needs none is checked. Every other route answers 401 without a token.
cd "$work/stack"
export SWARMLOOP_HOME="$work/home" CHECKOUTS_ROOT="$work/checkouts"
trap 'docker compose logs; docker compose down -v' EXIT
# Under QEMU a service can be up before it answers: retry the first request to each.
retry=(--retry 20 --retry-all-errors --retry-delay 3)
docker compose up -d --wait --pull never
curl -fsS "${retry[@]}" http://127.0.0.1:3920/health
curl -fsS "${retry[@]}" http://127.0.0.1:3920/auth/first-run
curl -fsS "${retry[@]}" http://127.0.0.1:3921/ > /dev/null
curl -fsS http://127.0.0.1:3921/swarmloop-api/health
curl -fsS http://127.0.0.1:3921/swarmloop-api/auth/first-run
curl -fsS http://127.0.0.1:3921/login > /dev/null
SWARMLOOP_SOCKET_URL=http://live.example:4000 docker compose up -d --wait --pull never
curl -fsS "${retry[@]}" http://127.0.0.1:3921/ | grep -F 'http://live.example:4000'
# Files a leaked data folder would expose, written by the server's own user so the folder keeps its owner.
docker compose exec -T server sh -c 'mkdir -p /app/data/codex && echo "{}" > /app/data/codex/auth.json && echo "{}" > /app/data/x-session.json'
assert_status() {
  status="$(curl --path-as-is -s -o /dev/null -w '%{http_code}' "$2")"
  if [ "$status" != "$1" ]; then
    echo "expected $1 from $2, got $status" >&2
    exit 1
  fi
}
# The dashboard serves no data folder.
for path in /run-logs/swarmloop.sqlite /run-logs/codex/auth.json /run-logs/x-session.json /run-logs/../.env; do
  assert_status 404 "http://127.0.0.1:3921$path"
done
# Without a token every route but /health and /auth answers 401, the log routes included.
for base in http://127.0.0.1:3921/swarmloop-api http://127.0.0.1:3920; do
  for path in /readiness /runs /runs/nope/steps/plan/log; do
    assert_status 401 "$base$path"
  done
done
