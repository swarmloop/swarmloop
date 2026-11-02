#!/usr/bin/env bash
set -euo pipefail

# Usage: changed-files.sh <base-ref> [glob...]
# Prints the files added, copied, modified or renamed between the merge base of <base-ref> and HEAD.
base_ref="$1"
shift
merge_base=$(git merge-base "$base_ref" HEAD)
git diff --name-only --diff-filter=ACMR "$merge_base...HEAD" -- "$@"
