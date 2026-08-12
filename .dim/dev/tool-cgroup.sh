#!/bin/sh
set -eu

slot="${1:?usage: dim-tool-cgroup SLOT COMMAND [ARG...] }"
shift
case "$slot" in
  tools-0|tools-1|tools-2|tools-3) ;;
  *) echo "unknown tool cgroup slot: $slot" >&2; exit 2 ;;
esac
test "$#" -gt 0 || { echo "tool command is required" >&2; exit 2; }
group="/run/dim/cgroup/$slot"
test -w "$group/cgroup.threads" || {
  echo "tool cgroup slot is not delegated: $slot" >&2
  exit 1
}
echo 0 > "$group/cgroup.threads"
exec "$@"
