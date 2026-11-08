#!/usr/bin/env bash
set -euo pipefail

# Installs the pinned tools for one CI group into the group's directory, without saving them to package.json.
# lint installs into the repository root (one install: a second --no-save install there would prune the first); dashboard-test installs into dashboard/.
# Usage: scripts/ci-tools.sh <group>

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <group>" >&2
  exit 1
fi

case "$1" in
  lint)
    dir=.
    packages=(
      eslint@9
      @eslint/js@9
      typescript-eslint@8
      globals@16
      eslint-config-prettier@10
      prettier@3
      @next/eslint-plugin-next@15
      eslint-plugin-react-hooks@5
      eslint-plugin-jsx-a11y@6
      eslint-plugin-boundaries@5
      typescript@5
      knip@5
      madge@8
    )
    ;;
  dashboard-test)
    dir=dashboard
    packages=(
      vitest@3
      jsdom@26
      @vitejs/plugin-react@4
      @testing-library/react@16
      @testing-library/dom@10
      @testing-library/user-event@14
      @testing-library/jest-dom@6
    )
    ;;
  *)
    echo "ci-tools: unknown group '$1'" >&2
    exit 1
    ;;
esac

cd "$(dirname "$0")/../$dir"
npm install --no-save --no-package-lock --no-audit --no-fund "${packages[@]}"
