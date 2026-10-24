#!/usr/bin/env bash
set -euo pipefail

check_only=0
connections=""
control_plane_ssh=""
while (($#)); do
  case "$1" in
    --check) check_only=1; shift ;;
    --with-managed) shift ;; # The complete development profile is already the default.
    --connections) [[ $# -ge 2 && -n "$2" && -z "$connections" ]] || { echo "--connections requires one absolute directory" >&2; exit 2; }; connections="$2"; shift 2 ;;
    --control-plane-ssh) [[ $# -ge 2 && -n "$2" && -z "$control_plane_ssh" ]] || { echo "--control-plane-ssh requires one SSH target" >&2; exit 2; }; control_plane_ssh="$2"; shift 2 ;;
    --help|-h) echo "Usage: just install-local [--check] [--connections ABSOLUTE_DIRECTORY [--control-plane-ssh SSH_TARGET]]"; exit 0 ;;
    *) echo "Unknown install-local argument: $1" >&2; exit 2 ;;
  esac
done
[[ -z "$connections" || "$connections" == /* ]] || { echo "--connections must be absolute" >&2; exit 2; }
[[ -z "$control_plane_ssh" || -n "$connections" ]] || { echo "--control-plane-ssh requires --connections" >&2; exit 2; }

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
local_root="$repo_root/.local"
package_root="$repo_root/.local/dim-packages"
readiness_file="$repo_root/.local/prepared-local.state"
lock_file="$local_root/prepare-install.lock"

command -v flock >/dev/null 2>&1 || {
  echo "install-local requires flock" >&2
  exit 1
}

mkdir -p "$local_root"
for path in "$local_root" "$package_root" "$readiness_file" "$lock_file"; do
  if [[ -L "$path" ]]; then
    echo "refusing symlinked local installation path: $path" >&2
    exit 1
  fi
done
exec 9>"$lock_file"
flock --exclusive 9
test -r "$readiness_file" || {
  echo "local source build is not prepared; run just prepare-local" >&2
  exit 1
}
package_version="$(bash "$repo_root/scripts/local-package-version.bash" "$package_root")"
image_ref="dev-infra-project-workspace:$package_version"

validate_preparation() {
  test -r "$readiness_file" || {
    echo "local source build is not prepared; run just prepare-local" >&2
    exit 1
  }
  current_state="$(
    DIM_LOCAL_PACKAGE_ROOT="$package_root" \
    DIM_LOCAL_IMAGE_INSPECT_REF="$image_ref" \
    DIM_LOCAL_IMAGE_RECORD_REF="$image_ref" \
      bash "$repo_root/scripts/local-preparation-state.bash"
  )"
  test "$(<"$readiness_file")" = "$current_state" || {
    echo "local source build provenance is stale or mismatched; run just prepare-local" >&2
    exit 1
  }
}

validate_preparation
connection_args=()
saved_connection="${XDG_CONFIG_HOME:-$HOME/.config}/dim/existing-control-plane/selection.json"
if [[ -n "$connections" ]]; then
  connection_args=(--connections "$connections")
  [[ -z "$control_plane_ssh" ]] || connection_args+=(--control-plane-ssh "$control_plane_ssh")
elif [[ -e "$saved_connection" || -L "$saved_connection" ]]; then
  connection_args=(--saved)
fi
if ((${#connection_args[@]})); then
  # Attest the supplied private roles before changing the facade or installed runtimes.
  node --import "$repo_root/tests/node_modules/tsx/dist/loader.mjs" --conditions=dim-source --conditions=source \
    "$repo_root/scripts/install-local-existing-control-plane.ts" --check "${connection_args[@]}"
fi
if [[ "$check_only" -eq 1 ]]; then
  exit 0
fi

installer_tarballs=("$package_root"/slop-lab-dim-installer-*.tgz)
test "${#installer_tarballs[@]}" -eq 1 && test -f "${installer_tarballs[0]}" && test ! -L "${installer_tarballs[0]}"
installer_sha256="$(sha256sum "${installer_tarballs[0]}" | cut -d ' ' -f 1)"
facade_parent="${DIM_DATA_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/dim}/installers"
facade_parent="$(realpath -m -s -- "$facade_parent")"
facade_root="$facade_parent/$installer_sha256"
if [[ -e "$facade_parent" || -L "$facade_parent" ]]; then
  [[ ! -L "$facade_parent" && -d "$facade_parent" && "$(stat -c %u "$facade_parent")" == "$(id -u)" ]] || {
    echo "source installer directory must be owned and must not be a symlink: $facade_parent" >&2; exit 1;
  }
fi
validate_facade() {
[[ ! -L "$facade_root" && -d "$facade_root" &&
  "$(stat -c %u "$facade_root")" == "$(id -u)" &&
  -f "$facade_root/.dim-source-installer" && ! -L "$facade_root/.dim-source-installer" &&
  "$(<"$facade_root/.dim-source-installer")" == "$installer_sha256" ]] || {
  echo "refusing an unsafe or foreign source installer: $facade_root" >&2; exit 1;
}
facade="$facade_root/node_modules/.bin/dim"
resolved_facade="$(readlink -f -- "$facade")"
[[ -x "$resolved_facade" && "$resolved_facade" == "$facade_root/"* ]] || {
  echo "source installer has no owned executable facade: $facade_root" >&2; exit 1;
}
}
if [[ -e "$facade_root" || -L "$facade_root" ]]; then
  validate_facade
fi
coordinate="npm:@slop-lab/dim-installer@${package_version}-installer-${installer_sha256:0:16}"
if command -v mise >/dev/null 2>&1; then
  existing_mise_path="$(mise where "$coordinate" 2>/dev/null || true)"
  if [[ -n "$existing_mise_path" && ( -e "$existing_mise_path" || -L "$existing_mise_path" ) ]]; then
    [[ "$(readlink -f -- "$existing_mise_path")" == "$(realpath -m -- "$facade_root")" ]] || {
      echo "mise source version already belongs to another installation: $coordinate" >&2; exit 1;
    }
  fi
fi
facade_stage=""
staged_installer="$(mktemp -d "${TMPDIR:-/tmp}/dim-target-installer.XXXXXX")"
cleanup() {
  find "$staged_installer" -depth -delete 2>/dev/null || true
  [[ -z "$facade_stage" ]] || rm -rf -- "$facade_stage"
}
trap cleanup EXIT

if command -v mise >/dev/null 2>&1; then
  npm_command=(mise exec -- npm)
  dim_command=(mise exec -- "$staged_installer/node_modules/.bin/dim")
else
  npm_command=(npm)
  dim_command=("$staged_installer/node_modules/.bin/dim")
fi
"${npm_command[@]}" install --prefix "$staged_installer" --no-save --no-fund --no-audit "${installer_tarballs[0]}"

echo "[host] install package bundle"
core_options=(--local-packages "$package_root" --no-local-bin --with-managed)
"${dim_command[@]}" installer install core "${core_options[@]}"
echo "[cli] install presentation package bundle"
"${dim_command[@]}" installer install cli --local-packages "$package_root" --no-local-bin
validate_preparation

# Keep the matching installer after this transaction. An older mise facade can
# launch the new CLI, but cannot interpret its new private service configuration.
mkdir -p -m 0700 -- "$facade_parent"
[[ ! -L "$facade_parent" && -d "$facade_parent" && "$(stat -c %u "$facade_parent")" == "$(id -u)" ]] || {
  echo "source installer directory must be owned and must not be a symlink: $facade_parent" >&2; exit 1;
}
if [[ ! -e "$facade_root" && ! -L "$facade_root" ]]; then
  facade_stage="$(mktemp -d "$facade_parent/.install.XXXXXX")"
  cp -a -- "$staged_installer/." "$facade_stage/"
  printf '%s\n' "$installer_sha256" >"$facade_stage/.dim-source-installer"
  mv -T --no-clobber -- "$facade_stage" "$facade_root"
  [[ ! -e "$facade_stage" ]] || { echo "source installer target appeared during installation; preserved: $facade_root" >&2; exit 1; }
  facade_stage=""
fi
validate_facade
if command -v mise >/dev/null 2>&1; then
  coordinate="npm:@slop-lab/dim-installer@${package_version}-installer-${installer_sha256:0:16}"
  existing_mise_path="$(mise where "$coordinate" 2>/dev/null || true)"
  if [[ -n "$existing_mise_path" && ( -e "$existing_mise_path" || -L "$existing_mise_path" ) ]]; then
    [[ "$(readlink -f -- "$existing_mise_path")" == "$facade_root" ]] || {
      echo "mise source version already belongs to another installation: $coordinate" >&2; exit 1;
    }
  else
    mise link "$coordinate" "$facade_root"
  fi
  mise use --raw --global "$coordinate"
  dim_command=(mise exec -- "$facade")
  echo "[host] selected matching source installer with mise"
else
  dim_command=("$facade")
  echo "[host] source installer: $facade"
  echo "Add $facade_root/node_modules/.bin to PATH to use this matching facade."
fi
validate_preparation
# Explicit installation selection takes precedence over connections inherited
# from an older operator shell, including during workspace broker reconnection.
unset DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE DIM_NATIVE_GIT_SYNC_CONNECTION_FILE
if ((${#connection_args[@]})); then
  node "$repo_root/scripts/install-local-profile.ts" "$package_root" "$facade" host
  node --import "$repo_root/tests/node_modules/tsx/dist/loader.mjs" --conditions=dim-source --conditions=source \
    "$repo_root/scripts/install-local-existing-control-plane.ts" "${connection_args[@]}"
else
  node "$repo_root/scripts/install-local-profile.ts" "$package_root" "$facade"
  DIM_LOCAL_INSTALLER="$facade" node "$repo_root/scripts/install-local-control-plane.ts" "$package_root"
fi
echo "[host] install Web UI package bundle"
node "$repo_root/scripts/install-local-web.ts" "$package_root"
if ((${#connection_args[@]} == 0)); then
  node "$repo_root/scripts/install-local-llm-operator.ts" "$package_root"
fi
node "$repo_root/scripts/install-local-llm-gateway.ts" "$package_root"
if ((${#connection_args[@]} == 0)); then
  node "$repo_root/scripts/install-local-shared-ingress.ts" "$package_root"
fi
"${dim_command[@]}" controller restart
node "$repo_root/scripts/configure-local-web.ts"
echo "[host] local package bundle and matching installer installed"
"${dim_command[@]}" --version
