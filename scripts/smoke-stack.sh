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
cd "$work/stack"
export SWARMLOOP_HOME="$work/home" CHECKOUTS_ROOT="$work/checkouts"
trap 'docker compose logs; docker compose down -v' EXIT
# Under QEMU a service can be up before it answers: retry the first request to each.
retry=(--retry 20 --retry-all-errors --retry-delay 3)
docker compose up -d --wait --pull never
curl -fsS "${retry[@]}" http://127.0.0.1:3920/health
# Every item must be ok except the credentials, which the fixture does not set.
assert_ready='
  const items = JSON.parse(require("fs").readFileSync(0, "utf8")).items;
  const bad = items.filter((item) => !["model-credential", "code-host-token"].includes(item.id) && item.status !== "ok");
  if (items.length === 0 || bad.length > 0) {
    console.error("readiness is not ok:", JSON.stringify(bad, null, 2));
    process.exit(1);
  }
'
curl -fsS http://127.0.0.1:3920/readiness | node -e "$assert_ready"
curl -fsS "${retry[@]}" http://127.0.0.1:3921/ > /dev/null
curl -fsS http://127.0.0.1:3921/swarmloop-api/health
curl -fsS http://127.0.0.1:3921/swarmloop-api/readiness | node -e "$assert_ready"
SWARMLOOP_SOCKET_URL=http://live.example:4000 docker compose up -d --wait --pull never
curl -fsS "${retry[@]}" http://127.0.0.1:3921/ | grep -F 'http://live.example:4000'
