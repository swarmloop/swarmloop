#!/usr/bin/env bash
set -euo pipefail

# Usage: lint-changed.sh <base-ref> [eslint args...]
# Runs the strict ESLint config on the .ts and .tsx files changed since <base-ref>.
# Extra arguments such as --fix are passed to ESLint.
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
base_ref="$1"
shift
changed=$(bash "$script_dir/changed-files.sh" "$base_ref" '*.ts' '*.tsx')
if [ -z "$changed" ]; then
  exit 0
fi
mapfile -t files <<< "$changed"
npx eslint -c eslint.strict.config.mjs "$@" "${files[@]}"
