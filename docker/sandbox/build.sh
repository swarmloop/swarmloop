#!/bin/sh
set -eu
dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
docker build -f "$dir/Dockerfile.cursor" -t swarmloop-agent-cursor "$dir"
docker build -f "$dir/Dockerfile.claude" -t swarmloop-agent-claude "$dir"
