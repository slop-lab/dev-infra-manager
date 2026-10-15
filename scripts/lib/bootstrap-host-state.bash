#!/usr/bin/env bash

dim_docker_resources_are_empty() {
  local resources nondefault_networks
  command -v docker >/dev/null 2>&1 || return 0
  resources="$(docker ps -aq)" && [[ -z "$resources" ]] || return 1
  resources="$(docker volume ls -q)" && [[ -z "$resources" ]] || return 1
  resources="$(docker image ls -q)" && [[ -z "$resources" ]] || return 1
  nondefault_networks="$(docker network ls --format '{{.Name}}' | LC_ALL=C sort | grep -Ev '^(bridge|host|none)$' || true)"
  [[ -z "$nondefault_networks" ]]
}

dim_docker_config_identity() {
  local metadata mode
  if [[ ! -e "$docker_daemon_config" && ! -L "$docker_daemon_config" ]]; then printf 'absent\n'; return; fi
  [[ ! -L "$docker_daemon_config" && -f "$docker_daemon_config" && -r "$docker_daemon_config" ]] || return 1
  metadata="$(stat -c '%u:%a' "$docker_daemon_config")"; mode="${metadata#*:}"
  [[ "${metadata%%:*}" == 0 ]] && (( (8#$mode & 8#022) == 0 )) || return 1
  sha256sum "$docker_daemon_config" | cut -d ' ' -f 1
}

dim_marker_content() {
  local phase="$1" config_sha256="$2" docker_config_sha256="$3"
  printf 'schema=1\nphase=%s\nrole=%s\nsource-sha=%s\nversion=%s\noperator-uid=%s\nconfig-sha256=%s\ndocker-config-sha256=%s\n' \
    "$phase" "$role" "$source_sha" "$expected_version" "$operator_uid" "$config_sha256" "$docker_config_sha256"
}

dim_write_marker() {
  local phase="$1" config_sha256="$2" docker_config_sha256="$3" temporary
  mkdir -p -m 0700 "$resume_marker_root"
  [[ ! -L "$resume_marker_root" && "$(stat -c '%u:%a' "$resume_marker_root")" == "$operator_uid:700" ]] || { echo "unsafe bootstrap resume marker directory" >&2; return 2; }
  temporary="$(mktemp "$resume_marker_root/.ubuntu-vm.XXXXXX")"
  dim_marker_content "$phase" "$config_sha256" "$docker_config_sha256" >"$temporary"
  chmod 0600 "$temporary"
  mv -T "$temporary" "$resume_marker"
}

dim_open_bootstrap_state() {
  resume=0
  if [[ -e "$resume_marker" || -L "$resume_marker" ]]; then
    [[ ! -L "$resume_marker" && -f "$resume_marker" && "$(stat -c '%u:%a' "$resume_marker")" == "$operator_uid:600" ]] || { echo "unsafe bootstrap resume marker" >&2; return 2; }
    marker_config_sha256="$(awk -F= '$1=="config-sha256" {print $2}' "$resume_marker")"
    marker_docker_config_sha256="$(awk -F= '$1=="docker-config-sha256" {print $2}' "$resume_marker")"
    [[ "$marker_config_sha256" =~ ^[0-9a-f]{64}$ && ( "$marker_docker_config_sha256" == absent || "$marker_docker_config_sha256" =~ ^[0-9a-f]{64}$ ) &&
      "$(<"$resume_marker")" == "$(dim_marker_content awaiting-login "$marker_config_sha256" "$marker_docker_config_sha256")" ]] || {
      echo "bootstrap resume marker does not match this role, source, version, owner, or phase" >&2; return 2;
    }
    resume=1
  elif [[ -e "$resume_marker_root" || -L "$resume_marker_root" ]]; then echo "refusing foreign bootstrap resume state" >&2; return 2; fi
  [[ ! -e "$docker_systemd_overrides" && ! -L "$docker_systemd_overrides" ]] || { echo "refusing existing Docker systemd overrides" >&2; return 2; }
  dim_docker_resources_are_empty || { echo "refusing existing Docker containers, volumes, images, or networks" >&2; return 2; }
  if [[ "$resume" -eq 0 ]]; then
    [[ "$(dim_docker_config_identity 2>/dev/null || printf unsafe)" == absent ]] || { echo "refusing existing Docker daemon configuration" >&2; return 2; }
    for path in "$docker_data_root" "$containerd_data_root" "$dim_config_root" "$dim_state_root" "$dim_data_root" \
      "$HOME/.local/lib/dim-candidates" "$candidate_facade" "$repo_root/.local/prepared-local.state" "$repo_root/.local/dim-packages"; do
      [[ ! -e "$path" && ! -L "$path" ]] || { echo "refusing pre-existing host or DIM state: $path" >&2; return 2; }
    done
    dim_write_marker installing none none
    return
  fi
  config_path="$dim_config_root/config.json"
  [[ ! -L "$config_path" && -f "$config_path" && "$(stat -c '%u:%a' "$config_path")" == "$operator_uid:600" ]] || { echo "resume requires bootstrap-created owner-only DIM backend config" >&2; return 2; }
  [[ "$(sha256sum "$config_path" | cut -d ' ' -f 1)" == "$marker_config_sha256" ]] || { echo "DIM backend config changed after bootstrap provisioning" >&2; return 2; }
  [[ "$(dim_docker_config_identity 2>/dev/null || printf unsafe)" == "$marker_docker_config_sha256" ]] || { echo "Docker daemon configuration changed after bootstrap provisioning" >&2; return 2; }
  for path in "$dim_state_root" "$dim_data_root" "$HOME/.local/lib/dim-candidates" "$candidate_facade" "$repo_root/.local/prepared-local.state" "$repo_root/.local/dim-packages"; do
    [[ ! -e "$path" && ! -L "$path" ]] || { echo "resume found non-bootstrap DIM state: $path" >&2; return 2; }
  done
}
