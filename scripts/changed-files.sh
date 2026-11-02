#!/usr/bin/env bash
set -euo pipefail

# Prints the files added, copied, modified or renamed since the merge base with <base-ref>, keeping only the given extensions.
# Usage: scripts/changed-files.sh <base-ref> <ext>...

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <base-ref> <ext>..." >&2
  exit 1
fi

base_ref=$1
shift

changed=$(git diff --name-only --diff-filter=ACMR "$(git merge-base "$base_ref" HEAD)")

while IFS= read -r file; do
  for ext in "$@"; do
    case "$file" in
      *."$ext")
        printf '%s\n' "$file"
        break
        ;;
    esac
  done
done <<< "$changed"
