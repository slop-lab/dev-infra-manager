#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() { printf 'dim-t3-server: %s\n' "$*" >&2; exit 1; }
operation="${1:-status}"
[[ $# -le 1 ]] || fail 'usage: dim-t3-server start|stop|status|pair'
version=0.1.10
port=3773
name=dim-agent-tools-t3
helper="$HOME/.local/share/dim-agent-tools/t3-service.bash"
root="$HOME/.local/state/dim-agent-tools/t3"
base="$root/data"
runtime="$root/runtime-$version"
t3="$runtime/t3"

ready() {
  curl --noproxy '*' -fsS --max-time 2 "http://127.0.0.1:$port/api/auth/session" \
    | jq -e '.authenticated == false and (.auth.bootstrapMethods | index("one-time-token") != null)' >/dev/null
}

if [[ "$operation" = __serve ]]; then
  # This T3 version writes a startup pairing URL to stdout even without a browser.
  # Keep it out of the supervisor log; the CLI still writes errors to stderr.
  exec "$t3" --host 127.0.0.1 --port "$port" --base-dir "$base" --no-browser \
    --auto-bootstrap-project-from-cwd >/dev/null
fi

registered=false
read_registration() {
  local file="$HOME/.local/state/dim/services/$name.json"
  registered=false
  if [[ -e "$file" || -L "$file" ]]; then
    [[ -f "$file" && ! -L "$file" && -O "$file" ]] || fail 'unsafe service registration'
    jq -e --arg helper "$helper" '.schemaVersion == 1 and .argv == ["bash", $helper, "__serve"]' "$file" >/dev/null \
      || fail 'T3 service name belongs to another command'
    registered=true
  fi
}

running() {
  local pid
  [[ "$registered" = true ]] && dim-workspace service list \
    | jq -e --arg name "$name" 'any(.[]; .name == $name and .running)' >/dev/null \
    && pid="$(jq -er --argjson port "$port" 'select(.port == $port) | .pid | select(type == "number" and . > 1 and floor == .)' "$base/userdata/server-runtime.json" 2>/dev/null)" \
    && [[ "$(readlink "/proc/$pid/exe")" = "$t3" ]] \
    && ready 2>/dev/null
}

status() {
  local state=stopped
  if running; then state=running; fi
  jq -cn --arg state "$state" --argjson port "$port" '{state:$state,port:$port}'
}

download() {
  local url="$1" destination="$2" digest="$3"
  curl -fSsL --retry 2 --connect-timeout 10 --max-time 95 "$url" -o "$destination"
  printf '%s  %s\n' "$digest" "$destination" | sha256sum -c - >/dev/null
}

# The upstream Linux archive is a glibc Node SEA. Keep its loader and libraries
# private to T3 on Alpine, without changing the workspace image or the agent environment.
prepare_alpine_runtime() {
  local stage="$1" archive="$2" architecture="$3" ubuntu_base=26.04.1 cpu triplet digest
  local patchelf_version=0.18.0-r3
  case "$architecture" in
    x64) cpu=amd64; triplet=x86_64-linux-gnu; digest=a496a960472ce474a59590b8987d3a1135d3cbef1991f3b1abe8cacfea8bf85a ;;
    arm64) cpu=arm64; triplet=aarch64-linux-gnu; digest=5a1906794ced63a71a8119c3f211ef5f0bbe0a243001b4bbd41fdf80c5b219fd ;;
  esac
  local glibc="$root/ubuntu-glibc-$ubuntu_base" loader="$root/ubuntu-glibc-$ubuntu_base/ld-linux-$architecture.so"
  if [[ ! -x "$loader" ]]; then
    download "https://cdimage.ubuntu.com/ubuntu-base/releases/26.04/release/ubuntu-base-$ubuntu_base-base-$cpu.tar.gz" "$stage/ubuntu-base.tar.gz" "$digest"
    tar -xzf "$stage/ubuntu-base.tar.gz" -C "$stage" "usr/lib/$triplet"
    mkdir "$stage/glibc"
    local libraries="$stage/usr/lib/$triplet"
    cp -L -- "$libraries"/ld-linux-*.so.* "$stage/glibc/ld-linux-$architecture.so"
    cp -L -- "$libraries"/{libanl.so.1,libc.so.6,libdl.so.2,libgcc_s.so.1,libm.so.6,libpthread.so.0,libresolv.so.2,librt.so.1,libstdc++.so.6,libutil.so.1} "$stage/glibc/"
    mv -T -- "$stage/glibc" "$glibc"
  fi
  (
    cd "$stage"
    apk --no-cache fetch patchelf >/dev/null
    apk verify "patchelf-$patchelf_version.apk" >/dev/null
    tar -xzf "patchelf-$patchelf_version.apk" usr/bin/patchelf
  )
  "$stage/usr/bin/patchelf" --set-interpreter "$loader" --force-rpath \
    --set-rpath "\$ORIGIN/lib:$glibc" "$stage/$archive/t3"
}

install_runtime() (
  [[ ! -x "$t3" ]] || return 0
  local architecture digest archive stage
  case "$(uname -m)" in
    x86_64) architecture=x64; digest=9bea9d36a217299a0af880e8c347b536ed6a9a2f5bf328a695d174d63628c5e8 ;;
    aarch64) architecture=arm64; digest=5ffbd224f53d0f827279825347a7ebf5a7ac98ad5c1347d47409f30aa2a1e425 ;;
    *) fail 'unsupported T3 Linux architecture' ;;
  esac
  archive="t3-$version-linux-$architecture"
  stage="$(mktemp -d "$root/.install.XXXXXX")"
  trap 'rm -rf -- "$stage"' EXIT
  download "https://github.com/pingdotgg/t3code/releases/download/v$version/$archive.tar.gz" "$stage/t3.tar.gz" "$digest"
  tar -xzf "$stage/t3.tar.gz" -C "$stage"
  if [[ -f /etc/alpine-release ]]; then prepare_alpine_runtime "$stage" "$archive" "$architecture"; fi
  [[ "$("$stage/$archive/t3" --version)" = "t3 v$version" ]] || fail "T3 $version cannot run on this workspace image"
  mv -T -- "$stage/$archive" "$runtime"
)

case "$operation" in
  status) read_registration; status; exit ;;
  start|stop|pair) ;;
  *) fail 'usage: dim-t3-server start|stop|status|pair' ;;
esac
mkdir -p -- "$root"
exec {lock_fd}>"$root/control.lock"
flock -x "$lock_fd"
read_registration

case "$operation" in
  start)
    if ! running; then
      if curl --noproxy '*' -s --max-time 2 -o /dev/null "http://127.0.0.1:$port/"; then
        fail "port $port already has a listener"
      fi
      install_runtime
      [[ "$PWD" = /workspace || "$PWD" = /workspace/* ]] || cd /workspace
      if [[ "$registered" = false ]]; then
        dim-workspace service register --name "$name" -- bash "$helper" __serve >/dev/null
      fi
      dim-workspace service resume "$name" {lock_fd}>&-
      read_registration
      deadline=$((SECONDS + 25))
      until running; do
        (( SECONDS < deadline )) || fail "service did not become ready; inspect ~/.local/state/dim/services/$name.log"
        sleep .2
      done
    fi
    status ;;
  stop)
    if [[ "$registered" = true ]]; then dim-workspace service remove "$name"; fi
    read_registration
    status ;;
  pair)
    running || fail 'start the managed T3 service before pairing'
    "$t3" auth pairing create --base-dir "$base" --ttl 1m --label 'DIM Web' --json \
      | jq -ec '{credential: .credential}' ;;
esac
