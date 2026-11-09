#!/usr/bin/env bash
# Starts a compose file in an empty directory and checks the stack answers.
# Usage: smoke-stack.sh <compose.yml> <env.example> [<previous-compose.yml> <previous-registry> <previous-version>]
# With a previous release, the stack first starts that release, then upgrades to <compose.yml> with a run waiting.
# The caller exports the variables the compose file needs for its images.
set -eu

compose_file="$(realpath "$1")"
env_file="$(realpath "$2")"
work="$(mktemp -d)"
mkdir -p "$work/home" "$work/checkouts/fixture"
git -C "$work/checkouts/fixture" init -q
git -C "$work/checkouts/fixture" -c user.name=ci -c user.email=ci@example.com commit -q --allow-empty -m fixture
mkdir "$work/stack"
cp "$compose_file" "$work/stack/compose.yml"
cp "$env_file" "$work/stack/.env"
cd "$work/stack"
export SWARMLOOP_HOME="$work/home" CHECKOUTS_ROOT="$work/checkouts"
trap 'docker compose logs; docker compose down -v' EXIT
# Under QEMU a service can be up before it answers: retry the first request to each.
retry=(--retry 20 --retry-all-errors --retry-delay 3)
docker compose up -d --wait
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
SWARMLOOP_SOCKET_URL=http://live.example:4000 docker compose up -d --wait
curl -fsS "${retry[@]}" http://127.0.0.1:3921/ | grep -F 'http://live.example:4000'

[ "$#" -ge 5 ] || exit 0
# Upgrade: the previous published release starts on a new home with one run waiting, then the PR build takes over.
previous_compose="$(realpath "$3")"
docker compose down -v
export SWARMLOOP_HOME="$work/upgrade-home"
mkdir -p "$SWARMLOOP_HOME"
cp "$previous_compose" compose.yml
SWARMLOOP_REGISTRY="$4" SWARMLOOP_VERSION="$5" docker compose up -d --wait
# A run waiting for a person, stored the way the server does: the fixture has no credentials, so no step could reach it.
docker compose exec -T server node -e "
  const db = require('better-sqlite3')('/app/data/swarmloop.sqlite');
  const at = new Date().toISOString();
  db.prepare('INSERT INTO runs (key, status, current_step, runtime, requirements_via, issue_tracker, code_host, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('UPGRADE-1', 'waiting', 'requirements', 'cursor', 'agent', 'jira', '', at, at);
"
waiting='
  const run = JSON.parse(require("fs").readFileSync(0, "utf8")).runs.find((item) => item.key === "UPGRADE-1");
  process.exit(run && run.status === "waiting" ? 0 : 1);
'
curl -fsS http://127.0.0.1:3920/runs | node -e "$waiting"
# The previous release has no drain command, and a waiting run holds no step.
cp "$compose_file" compose.yml
docker compose up -d --wait
ls "$SWARMLOOP_HOME"/data/backups/swarmloop-*.sqlite
curl -fsS http://127.0.0.1:3920/runs | node -e "$waiting"
# The run is known and the resume is not refused. Whether its step then succeeds depends on credentials the fixture lacks.
code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3920/runs/UPGRADE-1/resume)"
[ "$code" != 404 ] && [ "$code" != 409 ]
