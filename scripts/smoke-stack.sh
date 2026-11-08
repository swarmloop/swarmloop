#!/usr/bin/env bash
# Starts a compose file in an empty directory and checks the stack answers.
# Usage: smoke-stack.sh <compose.yml> <env.example>
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
docker compose up -d --wait
curl -fsS http://127.0.0.1:3920/health
curl -fsS http://127.0.0.1:3921/ > /dev/null
curl -fsS http://127.0.0.1:3921/swarmloop-api/health
SWARMLOOP_SOCKET_URL=http://live.example:4000 docker compose up -d --wait
curl -fsS http://127.0.0.1:3921/ | grep -F 'http://live.example:4000'
