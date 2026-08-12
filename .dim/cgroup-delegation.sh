#!/bin/sh
set -eu

action="${1:?action is required}"
cgroup_root=/sys/fs/cgroup/dim-agent

case "$action" in
  setup)
    uid="${2:?agent uid is required}"
    gid="${3:?agent gid is required}"
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
    chown "$uid:$gid" "$cgroup_root/cgroup.procs" "$cgroup_root/cgroup.threads"
    for slot in 0 1 2 3; do
      group="$cgroup_root/tools-$slot"
      mkdir -p "$group"
      if [ "$(cat "$group/cgroup.type")" != threaded ]; then
        echo threaded > "$group/cgroup.type"
      fi
      chown "$uid:$gid" "$group/cgroup.threads"
      for control in cpu.weight pids.max; do
        if [ -e "$group/$control" ]; then
          chown "$uid:$gid" "$group/$control"
        fi
      done
    done
    ;;
  teardown)
    if [ -d "$cgroup_root" ]; then
      for slot in 0 1 2 3; do
        rmdir "$cgroup_root/tools-$slot" 2>/dev/null || true
      done
      rmdir "$cgroup_root" 2>/dev/null || true
    fi
    ;;
  *)
    echo "unknown cgroup delegation action: $action" >&2
    exit 2
    ;;
esac
