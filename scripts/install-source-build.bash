#!/usr/bin/env bash
set -euo pipefail

with_managed=0
check_only=0
if [[ "$#" -eq 1 && "$1" == --check ]]; then
  check_only=1
elif [[ "$#" -eq 1 && "$1" == --with-managed ]]; then
  with_managed=1
elif [[ "$#" -ne 0 ]]; then
  echo "Usage: bash scripts/install-source-build.bash [--with-managed | --check]" >&2
  exit 2
fi

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
core_options=(--local-packages "$package_root" --no-local-bin)
if [[ "$with_managed" -eq 1 ]]; then
  core_options+=(--with-managed)
fi
"${dim_command[@]}" installer install core "${core_options[@]}"
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
echo "[host] install Web UI package bundle"
node "$repo_root/scripts/install-local-web.ts" "$package_root"
node "$repo_root/scripts/install-local-llm-operator.ts" "$package_root"
node "$repo_root/scripts/install-local-llm-gateway.ts" "$package_root"
node "$repo_root/scripts/install-local-shared-ingress.ts" "$package_root"
node "$repo_root/scripts/configure-local-web.ts"
echo "[host] local package bundle and matching installer installed"
"${dim_command[@]}" --version
