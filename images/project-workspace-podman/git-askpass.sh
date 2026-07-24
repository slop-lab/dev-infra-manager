#!/usr/bin/env sh
set -eu

case "${1:-}" in
  *Username*) printf '%s\n' "${DIM_GIT_USERNAME:?DIM_GIT_USERNAME is required}" ;;
  *Password*) printf '%s\n' "${DIM_GIT_TOKEN:?DIM_GIT_TOKEN is required}" ;;
  *) exit 1 ;;
esac
