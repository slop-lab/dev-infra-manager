#!/usr/bin/env bash

dim_example_runtime_owned() {
  [[ -n "${DIM_EXAMPLE_RUNTIME_DIR:-}" && -n "${DIM_EXAMPLE_RUNTIME_IDENTITY:-}" ]] || return 1
  [[ -d "$DIM_EXAMPLE_RUNTIME_DIR" && ! -L "$DIM_EXAMPLE_RUNTIME_DIR" ]] || return 1
  [[ "$(stat -Lc '%u:%d:%i' "$DIM_EXAMPLE_RUNTIME_DIR" 2>/dev/null)" = "$DIM_EXAMPLE_RUNTIME_IDENTITY" ]]
}

dim_prepare_example_controller_runtime() {
  [[ -n "${DIM_STATE_ROOT:-}" ]] || {
    printf 'DIM_STATE_ROOT is required before preparing the example controller runtime\n' >&2
    return 2
  }
  DIM_EXAMPLE_RUNTIME_DIR="$(mktemp -d /tmp/dim-ex-runtime.XXXXXX)"
  chmod 0700 "$DIM_EXAMPLE_RUNTIME_DIR"
  DIM_EXAMPLE_RUNTIME_IDENTITY="$(stat -Lc '%u:%d:%i' "$DIM_EXAMPLE_RUNTIME_DIR")"
  export DIM_EXAMPLE_RUNTIME_DIR DIM_EXAMPLE_RUNTIME_IDENTITY
  export XDG_RUNTIME_DIR="$DIM_EXAMPLE_RUNTIME_DIR"
  export DIM_CONTROLLER_SOCKET="$DIM_EXAMPLE_RUNTIME_DIR/w.sock"
  export DIM_AGENT_CONTROLLER_SOCKET="$DIM_EXAMPLE_RUNTIME_DIR/a.sock"
  export DIM_ADMIN_CONTROLLER_SOCKET="$DIM_EXAMPLE_RUNTIME_DIR/x.sock"
  unset DIM_CONTROLLER_API DIM_CONTROLLER_TOKEN DIM_AGENT_CONTROLLER_TOKEN
  local controller_hash
  controller_hash="$(printf '%s' "$DIM_STATE_ROOT" | sha256sum | cut -c1-16)"
  DIM_EXAMPLE_CONTROLLER_LOG="$DIM_EXAMPLE_RUNTIME_DIR/dim/$controller_hash/controller.log"
  DIM_EXAMPLE_CONTROLLER_PID="$DIM_EXAMPLE_RUNTIME_DIR/dim/$controller_hash/controller.pid"
  export DIM_EXAMPLE_CONTROLLER_LOG DIM_EXAMPLE_CONTROLLER_PID
  for socket in "$DIM_CONTROLLER_SOCKET" "$DIM_AGENT_CONTROLLER_SOCKET" "$DIM_ADMIN_CONTROLLER_SOCKET"; do
    ((${#socket} <= 107)) || return 1
  done
}

dim_capture_example_controller_failure() {
  local evidence_path="$1"
  local label="$2"
  if [[ -z "${DIM_EXAMPLE_RUNTIME_DIR:-}" && -z "${DIM_EXAMPLE_RUNTIME_IDENTITY:-}" ]]; then
    return 0
  fi
  dim_example_runtime_owned || return 1
  [[ -f "$DIM_EXAMPLE_CONTROLLER_LOG" && ! -L "$DIM_EXAMPLE_CONTROLLER_LOG" ]] || return 0
  local diagnostic
  if ! diagnostic="$(node -e '
    const fs = require("node:fs");
    const readFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
    const source = fs.openSync(process.argv[1], readFlags);
    let tail;
    try {
      const size = fs.fstatSync(source).size;
      const length = Math.min(size, 65536);
      const buffer = Buffer.alloc(length);
      fs.readSync(source, buffer, 0, length, Math.max(0, size - length));
      tail = buffer.toString("utf8");
    } finally {
      fs.closeSync(source);
    }
    const value = tail.split("\n").slice(-21).join("\n")
      .replace(/((?:"?[A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|CREDENTIAL|API_KEY)[A-Z0-9_]*"?)\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|\x27(?:\\.|[^\x27\\])*\x27|[^\s,}]+)/gi, "$1[redacted]")
      .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@").trim();
    if (value.length === 0) process.exit(0);
    const diagnostic = value.length <= 4096 ? value : `${value.slice(0, 4096)}\n[diagnostic truncated]`;
    const writeFlags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
    const destination = fs.openSync(process.argv[2], writeFlags, 0o600);
    try {
      fs.fchmodSync(destination, 0o600);
      fs.writeFileSync(destination, `${diagnostic}\n`);
    } finally {
      fs.closeSync(destination);
    }
    process.stdout.write(diagnostic);
  ' "$DIM_EXAMPLE_CONTROLLER_LOG" "$evidence_path")"; then
    return 1
  fi
  [[ -n "$diagnostic" ]] || return 0
  printf '%s startup diagnostics:\n%s\n' "$label" "$diagnostic" >&2
}

dim_stop_example_controller() {
  if [[ -z "${DIM_EXAMPLE_RUNTIME_DIR:-}" && -z "${DIM_EXAMPLE_RUNTIME_IDENTITY:-}" ]]; then
    return 0
  fi
  dim_example_runtime_owned || return 1
  if [[ -n "${DIM_EXAMPLE_DIM_BIN:-}" && -x "$DIM_EXAMPLE_DIM_BIN" ]]; then
    if ! "$DIM_EXAMPLE_DIM_BIN" controller stop >/dev/null; then
      return 1
    fi
  elif [[ -e "$DIM_EXAMPLE_CONTROLLER_PID" ]]; then
    return 1
  fi
  rm -rf "$DIM_EXAMPLE_RUNTIME_DIR"
}

# Requires verification/scripts/lib/local-npm-registry.bash to be sourced by the caller.
dim_publish_example_packages() {
  local work_dir="$1"

  dim_publish_to_local_registry \
    "$work_dir"/*dim-contracts-external-url*.tgz \
    "$work_dir"/*dim-controller-proxy*.tgz \
    "$work_dir"/*dim-core*.tgz \
    "$work_dir"/*plugin-dns-cloudflare*.tgz \
    "$work_dir"/*plugin-external-urls*.tgz \
    "$work_dir"/*plugin-host-mirrors*.tgz \
    "$work_dir"/*dim-cli*.tgz \
    "$work_dir"/*dim-installer*.tgz
}

dim_install_example_cli() {
  local repo_root="$1"
  local work_dir="$2"
  local install_prefix="$3"
  local host_mirror_version

  dim_prepare_example_controller_runtime
  bash "$repo_root/verification/scripts/pack-local-packages.bash" "$work_dir" >/dev/null
  host_mirror_version="$(jq -er \
    '.packages[] | select(.name == "@slop-lab/dim-plugin-host-mirrors") | .version' \
    "$work_dir/packages.json")"
  dim_start_local_npm_registry "$work_dir"
  dim_publish_example_packages "$work_dir"
  mkdir -p "$install_prefix"
  npm install --global --prefix "$install_prefix" \
    "$work_dir"/*dim-installer*.tgz --silent >/dev/null
  DIM_EXAMPLE_DIM_BIN="$install_prefix/bin/dim"
  export DIM_EXAMPLE_DIM_BIN
  "$DIM_EXAMPLE_DIM_BIN" installer install core --no-local-bin \
    --host-mirror-plugin "@slop-lab/dim-plugin-host-mirrors@$host_mirror_version" >/dev/null
}
