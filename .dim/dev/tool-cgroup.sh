#!/bin/sh
set -eu

test "${1:-}" = --create || {
  echo "usage: dim-tool-cgroup --create GROUP COMMAND [ARG...]" >&2
  exit 2
}
shift
group_name="${1:?cgroup name is required}"
shift
case "$group_name" in
  /*|*//*|*/|*../*|../*|*/..|..|*[!A-Za-z0-9._/-]*)
    echo "invalid delegated cgroup path: $group_name" >&2
    exit 2
    ;;
esac
test "$#" -gt 0 || { echo "tool command is required" >&2; exit 2; }
group=/run/dim/cgroup
old_ifs="$IFS"
IFS=/
for segment in $group_name; do
  available="$(cat "$group/cgroup.controllers")"
  for controller in cpu pids; do
    case " $available " in
      *" $controller "*) echo "+$controller" > "$group/cgroup.subtree_control" ;;
    esac
  done
  group="$group/$segment"
  mkdir -p "$group"
done
IFS="$old_ifs"
test -w "$group/cgroup.threads" || {
  echo "tool cgroup is not delegated: $group_name" >&2
  exit 1
}
echo 0 > "$group/cgroup.threads"
exec "$@"
