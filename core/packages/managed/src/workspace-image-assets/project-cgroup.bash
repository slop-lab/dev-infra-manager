#!/usr/bin/env bash
set -euo pipefail

manifest="${DIM_PROJECT_MANIFEST:-/run/dim/project.json}"
usage() {
  echo "usage: dim-project-cgroup inspect | require | create NAME UID GID [CONTROLLER...]" >&2
  exit 2
}

[[ -r "$manifest" ]] || { echo "DIM project manifest is not readable: $manifest" >&2; exit 1; }
status="$(jq -r '.runtime.cgroups.status // "unavailable"' "$manifest")"
driver="$(jq -r '.runtime.cgroups.driver // "unknown"' "$manifest")"
reason="$(jq -r '.runtime.cgroups.reason // empty' "$manifest")"

case "${1:-}" in
  inspect)
    [[ "$#" -eq 1 ]] || usage
    jq '.runtime.cgroups' "$manifest"
    ;;
  require)
    [[ "$#" -eq 1 ]] || usage
    if [[ "$status" != delegated ]]; then
      echo "project runtime cgroups are unavailable (driver: $driver): ${reason:-no delegated subtree}" >&2
      exit 1
    fi
    ;;
  create)
    [[ "$#" -ge 4 ]] || usage
    [[ "${EUID}" -eq 0 ]] || { echo "dim-project-cgroup create must run as root" >&2; exit 2; }
    [[ "$status" == delegated ]] || {
      echo "project runtime cgroups are unavailable (driver: $driver): ${reason:-no delegated subtree}" >&2
      exit 1
    }
    name="$2"
    uid="$3"
    gid="$4"
    shift 4
    [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || { echo "invalid project runtime cgroup name: $name" >&2; exit 2; }
    [[ "$uid" =~ ^[0-9]+$ && "$gid" =~ ^[0-9]+$ ]] || { echo "UID and GID must be decimal integers" >&2; exit 2; }
    requested=("$@")
    [[ "${#requested[@]}" -gt 0 ]] || requested=(cpu)
    requested+=(pids)
    root="${DIM_CGROUP_ROOT:-/sys/fs/cgroup}"
    infrastructure="$root/.dim-infrastructure"
    delegated="$root/project-runtime"
    target="$delegated/$name"
    mkdir -p "$infrastructure" "$delegated"
    while read -r pid; do
      [[ -n "$pid" ]] && printf '%s\n' "$pid" >"$infrastructure/cgroup.procs" 2>/dev/null || true
    done <"$root/cgroup.procs"
    available=" $(cat "$root/cgroup.controllers") "
    enabled=()
    for controller in "${requested[@]}"; do
      [[ " $available " == *" $controller "* ]] || continue
      [[ " ${enabled[*]} " == *" $controller "* ]] && continue
      printf '+%s\n' "$controller" >"$root/cgroup.subtree_control"
      enabled+=("$controller")
    done
    [[ " ${enabled[*]} " == *" pids "* ]] || { echo "delegated cgroup lacks required pids controller" >&2; exit 1; }
    for controller in "${enabled[@]}"; do
      printf '+%s\n' "$controller" >"$delegated/cgroup.subtree_control"
    done
    mkdir -p "$target"
    chown "$uid:$gid" "$target" "$target/cgroup.procs" "$target/cgroup.threads" "$target/cgroup.subtree_control"
    printf '%s\n' "$target"
    ;;
  *) usage ;;
esac
