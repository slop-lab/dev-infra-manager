#!/usr/bin/env bash

qemu_preflight_error() {
  QEMU_PREFLIGHT_FAILURES+=("$1")
}

qemu_host_architecture() {
  /usr/bin/uname -m
}

qemu_check_host_architecture() {
  local architecture
  architecture="$(qemu_host_architecture)"
  [[ "$architecture" == x86_64 ]] ||
    qemu_preflight_error "unsupported QEMU KVM host architecture: $architecture (requires x86_64)"
}

qemu_validate_trusted_node() {
  local node_path="$1" component metadata mode version
  if [[ "$node_path" != /* || ! -f "$node_path" || ! -x "$node_path" || -L "$node_path" ]]; then
    printf 'trusted Node.js interpreter must be an absolute, non-symlink regular executable: %s\n' "$node_path" >&2
    return 1
  fi
  if [[ "$(/usr/bin/readlink -f -- "$node_path")" != "$node_path" ]] ||
    [[ "$(/usr/bin/stat -c '%u:%g:%a' -- "$node_path")" != 0:0:755 ]]; then
    printf 'trusted Node.js interpreter must be canonical root:root mode-0755: %s\n' "$node_path" >&2
    return 1
  fi
  component="$(/usr/bin/dirname -- "$node_path")"
  while true; do
    if [[ -L "$component" || ! -d "$component" ]]; then
      printf 'trusted Node.js interpreter ancestor must be a real directory: %s\n' "$component" >&2
      return 1
    fi
    metadata="$(/usr/bin/stat -c '%u:%a' -- "$component")"
    mode="${metadata#*:}"
    if [[ "${metadata%%:*}" != 0 ]] || (( (8#$mode & 8#022) != 0 )); then
      printf 'trusted Node.js interpreter ancestor must be root-owned and not group/world-writable: %s\n' "$component" >&2
      return 1
    fi
    [[ "$component" == / ]] && break
    component="$(/usr/bin/dirname -- "$component")"
  done
  version="$($node_path --version 2>/dev/null)" || version=""
  if [[ "$version" != v24.* && "$version" != v26.* ]]; then
    printf 'trusted Node.js interpreter must be supported Node.js 24 or 26: %s\n' "$node_path" >&2
    return 1
  fi
}

qemu_check_command() {
  local command_name="$1"
  PATH="$runtime_path" command -v "$command_name" >/dev/null 2>&1 ||
    qemu_preflight_error "missing KVM smoke dependency: $command_name (run: bash verification/scripts/install-kvm-verify-deps-ubuntu.bash)"
}

qemu_host_preflight() {
  local file node_error passwd_record
  QEMU_PREFLIGHT_FAILURES=()
  qemu_check_host_architecture

  passwd_record="$(/usr/bin/getent passwd "$invoking_uid" 2>/dev/null)" || passwd_record=""
  if [[ -z "$passwd_record" || "${passwd_record%%:*}" == root ]]; then
    qemu_preflight_error "invoking UID $invoking_uid must identify a non-root passwd user"
  else
    IFS=: read -r invoking_user _ passwd_uid _ _ invoking_home _ <<<"$passwd_record"
    [[ "$passwd_uid" == "$invoking_uid" && "$invoking_uid" != 0 ]] ||
      qemu_preflight_error "run QEMU host verification as a non-root invoking user"
  fi

  [[ -r "$launcher" ]] || qemu_preflight_error "protected QEMU verification launcher is not readable: $launcher"
  for file in "$client" "${root_modules[@]/#/$repository_root/verification/qemu/}"; do
    [[ -r "$file" ]] || qemu_preflight_error "protected QEMU verification component is not readable: $file"
  done

  if ! node_error="$(qemu_validate_trusted_node "$node" 2>&1)"; then
    qemu_preflight_error "$node_error"
  fi
  [[ -x "$setpriv_command" ]] || qemu_preflight_error "util-linux setpriv is required for QEMU verification: $setpriv_command"
  if [[ ! -x "$sudo_command" ]]; then
    qemu_preflight_error "sudo is required for the root-owned QEMU verification service: $sudo_command"
  elif ! "$sudo_command" -n /usr/bin/true >/dev/null 2>&1; then
    qemu_preflight_error "cached noninteractive sudo authorization is required for the root-owned QEMU verification service; sudo -n preflight failed"
  fi
  [[ -c "$kvm_device" && -r "$kvm_device" && -w "$kvm_device" ]] ||
    qemu_preflight_error "/dev/kvm must be a readable and writable character device"

  for file in qemu-system-x86_64 qemu-img curl ssh ssh-keygen tar; do qemu_check_command "$file"; done
  if ! PATH="$runtime_path" command -v cloud-localds >/dev/null 2>&1 &&
    ! PATH="$runtime_path" command -v genisoimage >/dev/null 2>&1; then
    qemu_preflight_error "missing KVM smoke dependency: cloud-localds or genisoimage (run: bash verification/scripts/install-kvm-verify-deps-ubuntu.bash)"
  fi

  if (( ${#QEMU_PREFLIGHT_FAILURES[@]} > 0 )); then
    printf 'QEMU host prerequisite preflight found %d problem(s):\n' "${#QEMU_PREFLIGHT_FAILURES[@]}" >&2
    printf ' - %s\n' "${QEMU_PREFLIGHT_FAILURES[@]}" >&2
    return 1
  fi
}
