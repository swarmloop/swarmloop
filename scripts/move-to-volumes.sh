#!/usr/bin/env bash
# One-time move of an installation's worktrees and checkouts into the Docker volumes.
# Run it from the installation folder (or pass that folder) with the server stopped.
# `inside` is the part that runs in the throwaway container; its paths come from env.
set -eu

inside() {
  old_worktrees="${OLD_WORKTREES:-/old/worktrees}"
  old_checkouts="${OLD_CHECKOUTS:-/old/checkouts}"
  old_data="${OLD_DATA:-/old/data}"
  worktrees="${WORKTREES:-/app/worktrees}"
  checkouts="${CHECKOUTS:-/checkouts}"
  host_checkouts="${HOST_CHECKOUTS_ROOT:-$old_checkouts}"
  names="$(mktemp)"
  trap 'rm -f "$names"' EXIT

  if [ -d "$old_worktrees" ]; then
    cp -a "$old_worktrees/." "$worktrees/"
    for run in "$old_worktrees"/*/; do
      [ -d "$run" ] && echo "Copied run folder $(basename "$run")"
    done
    for link in "$worktrees"/*/*/.git; do
      [ -f "$link" ] || continue
      target="$(sed -n 's/^gitdir: //p' "$link")"
      case "$target" in
        "$checkouts"/*/.git/*) rest="${target#"$checkouts"/}"; echo "${rest%%/*}" >> "$names" ;;
      esac
    done
  fi

  if [ -f "$old_data/swarmloop.sqlite" ]; then
    DB="$old_data/swarmloop.sqlite" node --input-type=module -e "
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync('file:' + process.env.DB + '?immutable=1', { readOnly: true });
      for (const row of db.prepare('SELECT name FROM checkouts').all()) console.log(row.name);
    " >> "$names"
  fi

  sort -u "$names" | while IFS= read -r name; do
    [ -n "$name" ] || continue
    if [ -e "$checkouts/$name" ]; then
      echo "Skipped repository $name: it is already in the volume"
      continue
    fi
    if [ ! -d "$old_checkouts/$name/.git" ]; then
      echo "Skipped repository $name: no clone at $host_checkouts/$name"
      continue
    fi
    mkdir -p "$checkouts/$name"
    cp -a "$old_checkouts/$name/.git" "$checkouts/$name/.git"
    git -c safe.directory='*' -C "$checkouts/$name" reset --hard -q HEAD
    echo "Copied repository $name"
  done

  echo "The host folders are left as they are; delete them when you no longer need them."
  echo "Run these in your own clones to drop the old worktree registrations:"
  sort -u "$names" | while IFS= read -r name; do
    [ -d "$old_checkouts/$name/.git" ] || continue
    for entry in "$old_checkouts/$name/.git/worktrees"/*/; do
      [ -f "${entry}locked" ] || continue
      registered="$(sed 's#/\.git$##' "${entry}gitdir")"
      case "$registered" in
        "$worktrees"/*) echo "git -C $host_checkouts/$name worktree unlock $registered" ;;
      esac
    done
    echo "git -C $host_checkouts/$name worktree prune"
  done
}

outside() {
  script="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  home_dir="$(cd "${1:-.}" && pwd)"
  cd "$home_dir"
  if [ -n "$(docker compose ps -q server)" ]; then
    echo "The swarmloop server is running. Stop it first (docker compose down), then run this again." >&2
    exit 1
  fi
  env_value() { [ -f .env ] && sed -n "s/^$1=//p" .env | tail -n 1 || true; }
  checkouts_root="$(env_value CHECKOUTS_ROOT)"
  swarmloop_home="$(env_value SWARMLOOP_HOME)"
  host_checkouts="$(cd "${checkouts_root:-..}" && pwd)"
  host_home="$(cd "${swarmloop_home:-.}" && pwd)"
  project="${COMPOSE_PROJECT_NAME:-swarmloop}"
  image="$(docker compose config --images server)"
  for volume in worktrees checkouts; do
    docker volume create \
      --label "com.docker.compose.project=$project" \
      --label "com.docker.compose.volume=$volume" \
      "swarmloop-$volume" > /dev/null
  done
  docker run --rm --user root --entrypoint bash \
    -v "$host_home/worktrees:/old/worktrees:ro" \
    -v "$host_checkouts:/old/checkouts:ro" \
    -v "$host_home/data:/old/data:ro" \
    -v swarmloop-worktrees:/app/worktrees \
    -v swarmloop-checkouts:/checkouts \
    -v "$script:/move-to-volumes.sh:ro" \
    -e "HOST_CHECKOUTS_ROOT=$host_checkouts" \
    "$image" /move-to-volumes.sh inside
}

if [ "${1:-}" = inside ]; then inside; else outside "$@"; fi
