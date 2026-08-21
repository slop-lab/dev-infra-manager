#!/usr/bin/env sh
set -eu

action="${1:?home archive action is required}"
home="${HOME:?HOME is required}"
mkdir -p "$home"

case "$action" in
  backup)
    exec tar -C "$home" -czf - .
    ;;
  restore)
    exec tar -C "$home" -xzf -
    ;;
  *)
    echo "unknown home archive action: $action" >&2
    exit 2
    ;;
esac
