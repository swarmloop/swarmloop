#!/usr/bin/env bash
# Starts compose.yml with .env.example in an empty directory and checks the stack answers.
# The caller exports SWARMLOOP_REGISTRY and SWARMLOOP_VERSION of images that are already on this host.
set -eu

repo="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
mkdir -p "$work/home" "$work/checkouts/fixture" "$work/stack"
git -C "$work/checkouts/fixture" init -q
git -C "$work/checkouts/fixture" -c user.name=ci -c user.email=ci@example.com commit -q --allow-empty -m fixture
cp "$repo/compose.yml" "$work/stack/compose.yml"
cp "$repo/.env.example" "$work/stack/.env"
# The server refuses to start when a role names a runtime without a key. The fixture never calls a model.
sed -i 's/^CURSOR_API_KEY=$/CURSOR_API_KEY=fixture-key/' "$work/stack/.env"
# Machine clients send this token as a bearer header. /health needs none.
token=smoke-machine-token
sed -i "s/^SWARMLOOP_TOKEN=\$/SWARMLOOP_TOKEN=$token/" "$work/stack/.env"
auth=(-H "Authorization: Bearer $token")
cd "$work/stack"
export SWARMLOOP_HOME="$work/home" CHECKOUTS_ROOT="$work/checkouts"
trap 'docker compose logs; docker compose down -v' EXIT
# Under QEMU a service can be up before it answers: retry the first request to each.
retry=(--retry 20 --retry-all-errors --retry-delay 3)
docker compose up -d --wait --pull never
curl -fsS "${retry[@]}" http://127.0.0.1:3920/health
# Every item must be ok except the credentials, which the fixture does not really have.
assert_ready='
  const items = JSON.parse(require("fs").readFileSync(0, "utf8")).items;
  const bad = items.filter((item) => !["model-credential", "code-host-token"].includes(item.id) && item.status !== "ok");
  if (items.length === 0 || bad.length > 0) {
    console.error("readiness is not ok:", JSON.stringify(bad, null, 2));
    process.exit(1);
  }
'
curl -fsS "${auth[@]}" http://127.0.0.1:3920/readiness | node -e "$assert_ready"
curl -fsS "${retry[@]}" http://127.0.0.1:3921/ > /dev/null
curl -fsS http://127.0.0.1:3921/swarmloop-api/health
curl -fsS "${auth[@]}" http://127.0.0.1:3921/swarmloop-api/readiness | node -e "$assert_ready"
SWARMLOOP_SOCKET_URL=http://live.example:4000 docker compose up -d --wait --pull never
curl -fsS "${retry[@]}" http://127.0.0.1:3921/ | grep -F 'http://live.example:4000'
# Files a leaked data folder would expose, written by the server's own user so the folder keeps its owner.
docker compose exec -T server sh -c 'mkdir -p /app/data/codex && echo "{}" > /app/data/codex/auth.json && echo "{}" > /app/data/x-session.json'
# The dashboard serves no data folder, and the log route refuses what is not a step log of a known run.
assert_404() {
  status="$(curl --path-as-is "${auth[@]}" -s -o /dev/null -w '%{http_code}' "$1")"
  if [ "$status" != 404 ]; then
    echo "expected 404 from $1, got $status" >&2
    exit 1
  fi
}
for path in /run-logs/swarmloop.sqlite /run-logs/codex/auth.json /run-logs/x-session.json /run-logs/../.env; do
  assert_404 "http://127.0.0.1:3921$path"
done
for base in http://127.0.0.1:3921/swarmloop-api http://127.0.0.1:3920; do
  for path in /runs/nope/steps/plan/log '/runs/..%2f..%2fetc/steps/plan/log' '/runs/nope/steps/..%2f..%2fetc/log' '/runs/nope/steps/%2fetc%2fpasswd/log'; do
    assert_404 "$base$path"
  done
done
