#!/usr/bin/env bash
set -euo pipefail
output="$(mktemp -d /tmp/dim-pnpm-pack-XXXXXX)"
trap 'rm -rf "$output"' EXIT
pnpm --dir dist pack --pack-destination "$output"
