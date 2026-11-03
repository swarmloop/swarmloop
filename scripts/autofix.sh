#!/usr/bin/env bash
set -euo pipefail

# Runs the ESLint fixers and Prettier on the files changed since <base-ref>, then fails with the diff if they changed anything.
# Usage: scripts/autofix.sh <base-ref>

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <base-ref>" >&2
  exit 1
fi

base_ref=$1
fixer_status=0

eslint_changed=$(bash "$(dirname "$0")/changed-files.sh" "$base_ref" ts tsx mjs)
prettier_changed=$(bash "$(dirname "$0")/changed-files.sh" "$base_ref" ts tsx js jsx mjs cjs json yml yaml css scss html)

# A fixer that fails, for example on a lint error it cannot fix, must not hide the diff of the files it did change.
if [ -n "$eslint_changed" ]; then
  mapfile -t eslint_files <<< "$eslint_changed"
  npx eslint --fix "${eslint_files[@]}" || fixer_status=$?
  bash "$(dirname "$0")/lint-changed.sh" "$base_ref" --fix || fixer_status=$?
fi

if [ -n "$prettier_changed" ]; then
  mapfile -t prettier_files <<< "$prettier_changed"
  npx --yes prettier@3 --write --ignore-unknown "${prettier_files[@]}" || fixer_status=$?
fi

if ! git diff --quiet; then
  echo "autofix: apply this diff exactly as it is"
  git --no-pager diff
  exit 1
fi

exit "$fixer_status"
