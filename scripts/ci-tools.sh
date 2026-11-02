#!/usr/bin/env bash
set -euo pipefail

# Installs the pinned tools for one CI group into the repository root, without saving them to package.json.
# Usage: scripts/ci-tools.sh <group>

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <group>" >&2
  exit 1
fi

case "$1" in
  lint)
    packages=(
      eslint@9
      @eslint/js@9
      typescript-eslint@8
      globals@16
      eslint-config-prettier@10
      @next/eslint-plugin-next@15
      eslint-plugin-react-hooks@5
      eslint-plugin-jsx-a11y@6
      typescript@5
    )
    ;;
  *)
    echo "ci-tools: unknown group '$1'" >&2
    exit 1
    ;;
esac

cd "$(dirname "$0")/.."
npm install --no-save --no-package-lock --no-audit --no-fund "${packages[@]}"
