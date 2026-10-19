#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  printf 'usage: %s DOCKER_SERVER_VERSION\n' "${0##*/}" >&2
  exit 2
fi

case "$1" in
  29.1.3 | 29.1.4) ;;
  *)
    printf 'unsupported installation Docker server version: %s\n' "$1" >&2
    exit 2
    ;;
esac
