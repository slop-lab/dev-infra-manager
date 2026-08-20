#!/bin/sh
set -eu

action="${1:?action is required}"
cgroup_root=/sys/fs/cgroup/dim-agent

case "$action" in
  setup)
    uid="${2:?agent uid is required}"
    gid="${3:?agent gid is required}"
    option="${4:-}"
    if [ "$option" != --delegate-subtree ]; then
      echo "setup requires explicit --delegate-subtree opt-in" >&2
      exit 2
    fi
    mkdir -p "$cgroup_root"
    if [ "$(cat "$cgroup_root/cgroup.type")" != threaded ]; then
      echo threaded > "$cgroup_root/cgroup.type"
    fi
    available="$(cat "$cgroup_root/cgroup.controllers")"
    for controller in cpu pids; do
      case " $available " in
        *" $controller "*) echo "+$controller" > "$cgroup_root/cgroup.subtree_control" ;;
      esac
    done
    chown "$uid:$gid" "$cgroup_root" \
      "$cgroup_root/cgroup.procs" \
      "$cgroup_root/cgroup.threads" \
      "$cgroup_root/cgroup.subtree_control"
    ;;
  teardown)
    if [ -d "$cgroup_root" ]; then
      find "$cgroup_root" -mindepth 1 -depth -type d \
        -exec rmdir {} \; 2>/dev/null || true
      rmdir "$cgroup_root" 2>/dev/null || true
    fi
    ;;
  *)
    echo "unknown cgroup delegation action: $action" >&2
    exit 2
    ;;
esac
