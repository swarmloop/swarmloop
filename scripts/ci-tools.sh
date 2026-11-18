#!/usr/bin/env bash
set -euo pipefail

# Installs the CI tools: the exact versions in the root package.json and package-lock.json, so a new release changes CI only through a commit.
# They install into the root's node_modules, where the root configs and dashboard/ (as a parent folder) resolve them; the projects' own trees are never changed.
# Every group installs the same tree, so a job that needs several groups runs it once (a second npm ci would reinstall the whole tree).
# The tools' peers are linked to the dashboard's copies so its tests and types see one React; that is why this runs after the dashboard's own npm ci.
# Usage: scripts/ci-tools.sh <group>

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <group>" >&2
  exit 1
fi

case "$1" in
  lint | dashboard-test) ;;
  *)
    echo "ci-tools: unknown group '$1'" >&2
    exit 1
    ;;
esac

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
npm ci --omit=peer --no-audit --no-fund

for name in react react-dom @types/react @types/react-dom; do
  if [ -e "$root/dashboard/node_modules/$name" ]; then
    mkdir -p "$(dirname "$root/node_modules/$name")"
    ln -sfn "$root/dashboard/node_modules/$name" "$root/node_modules/$name"
  fi
done
