#!/usr/bin/env bash
set -euo pipefail

# Runs the strict ESLint config on the .ts and .tsx files changed since <base-ref>.
# Usage: scripts/lint-changed.sh <base-ref> [eslint args]

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <base-ref> [eslint args]" >&2
  exit 1
fi

base_ref=$1
shift

changed=$(bash "$(dirname "$0")/changed-files.sh" "$base_ref" ts tsx)

if [ -z "$changed" ]; then
  exit 0
fi

mapfile -t files <<< "$changed"
npx eslint -c eslint.strict.config.mjs "$@" "${files[@]}"
