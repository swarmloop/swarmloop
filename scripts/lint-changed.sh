#!/usr/bin/env bash
set -euo pipefail

# Runs the strict ESLint config on the .ts and .tsx files changed since <base-ref>. Errors fail anywhere in a changed
# file; warnings fail only on lines the change added or modified.
# Usage: scripts/lint-changed.sh <base-ref> [--fix]

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <base-ref> [--fix]" >&2
  exit 1
fi

base_ref=$1
shift

changed=$(bash "$(dirname "$0")/changed-files.sh" "$base_ref" ts tsx)

if [ -z "$changed" ]; then
  exit 0
fi

mapfile -t files <<< "$changed"
node "$(dirname "$0")/lint-added-lines.mjs" "$@" "$(git merge-base "$base_ref" HEAD)" "${files[@]}"
