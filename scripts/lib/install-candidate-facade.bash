#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
facade_format_helper="$script_dir/candidate-facade-format.bash"
source "$facade_format_helper"

if [[ "$#" -ne 3 ]]; then
  echo "usage: install-candidate-facade.bash PACKAGE_ROOT VERSION SOURCE_SHA" >&2
  exit 2
fi
package_root="$1"
version="$2"
source_sha="$3"
[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "candidate facade requires an exact source SHA" >&2; exit 2; }
[[ "$version" =~ ^0\.[0-9]+\.[0-9]+-local-[0-9a-f]{64}$ ]] || { echo "candidate facade requires an exact local bundle version" >&2; exit 2; }
[[ ! -L "$package_root" && -d "$package_root" ]] || { echo "unsafe candidate package root" >&2; exit 1; }
local_root="$(dirname -- "$package_root")"
repo_root="$(dirname -- "$local_root")"
readiness_file="$local_root/prepared-local.state"
lock_file="$local_root/prepare-install.lock"
[[ "$package_root" == "$repo_root/.local/dim-packages" ]] || { echo "candidate package root is not the repository prepared bundle" >&2; exit 1; }
command -v flock >/dev/null 2>&1 || { echo "candidate facade installation requires flock" >&2; exit 1; }
[[ ! -L "$lock_file" && ! -L "$readiness_file" && -f "$readiness_file" ]] || { echo "unsafe or missing prepared state" >&2; exit 1; }
exec 9>"$lock_file"
flock --exclusive 9

validate_preparation() {
  local current_state source_root
  [[ "$(bash "$repo_root/scripts/local-package-version.bash" "$package_root")" == "$version" ]] || return 1
  current_state="$(DIM_LOCAL_PACKAGE_ROOT="$package_root" DIM_LOCAL_IMAGE_INSPECT_REF="dev-infra-project-workspace:$version" \
    DIM_LOCAL_IMAGE_RECORD_REF="dev-infra-project-workspace:$version" bash "$repo_root/scripts/local-preparation-state.bash")" || return 1
  [[ "$(<"$readiness_file")" == "$current_state" ]] || return 1
  source_root="$(awk -F= '$1=="root" {print $2}' "$package_root/.dim-source-state")"
  [[ "$source_root" == "$source_sha" ]]
}

validate_preparation || { echo "prepared bundle identity is stale or mismatched" >&2; exit 1; }
installer_file="$($dim_pinned_node - "$package_root/packages.json" "$version" <<'NODE'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const matches = manifest.packages?.filter((entry) => entry.name === "@slop-lab/dim-installer") ?? [];
if (manifest.schemaVersion !== 1 || matches.length !== 1 || matches[0].version !== process.argv[3]
  || typeof matches[0].file !== "string" || !/^slop-lab-dim-installer-[A-Za-z0-9_.-]+\.tgz$/.test(matches[0].file)) process.exit(1);
process.stdout.write(matches[0].file);
NODE
)" || { echo "prepared manifest does not bind one exact installer package" >&2; exit 1; }
installer_tarball="$package_root/$installer_file"
[[ -f "$installer_tarball" && ! -L "$installer_tarball" ]] || { echo "prepared installer tarball is missing or unsafe" >&2; exit 1; }
installer_sha256="$(sha256sum "$installer_tarball" | cut -d ' ' -f 1)"
readiness_sha256="$(sha256sum "$readiness_file" | cut -d ' ' -f 1)"
candidate_identity="version=$version
source-sha=$source_sha
installer-sha256=$installer_sha256
readiness-sha256=$readiness_sha256"

candidate_root="$HOME/.local/lib/dim-candidates/${version}-${source_sha}"
facade="$HOME/.local/bin/dim"
expected_facade="$(dim_candidate_facade_content "$candidate_root")"
if [[ -e "$facade" || -L "$facade" ]]; then
  [[ ! -L "$facade" && -f "$facade" && "$(<"$facade")" == "$expected_facade" ]] || {
    echo "refusing to replace existing or foreign DIM facade: $facade" >&2
    exit 1
  }
fi

if [[ -e "$candidate_root" || -L "$candidate_root" ]]; then
  resolved_dim="$(readlink -f -- "$candidate_root/node_modules/.bin/dim" 2>/dev/null || true)"
  [[ ! -L "$candidate_root" && -f "$resolved_dim" && -x "$resolved_dim" && "$resolved_dim" == "$candidate_root/"* ]] || {
    echo "refusing unsafe or foreign candidate target: $candidate_root" >&2
    exit 1
  }
  [[ -f "$candidate_root/.dim-bootstrap-candidate" && ! -L "$candidate_root/.dim-bootstrap-candidate" &&
    "$(<"$candidate_root/.dim-bootstrap-candidate")" == "$candidate_identity" ]] || {
    echo "refusing candidate target with mismatched provenance: $candidate_root" >&2
    exit 1
  }
else
  candidate_parent="$(dirname -- "$candidate_root")"
  mkdir -p -- "$candidate_parent"
  [[ ! -L "$candidate_parent" && -d "$candidate_parent" ]] || { echo "unsafe candidate parent" >&2; exit 1; }
  stage="$(mktemp -d "$candidate_parent/.install.XXXXXX")"
  trap 'rm -rf -- "$stage"' EXIT
  npm install --prefix "$stage" --no-save --no-fund --no-audit "$installer_tarball"
  resolved_dim="$(readlink -f -- "$stage/node_modules/.bin/dim" 2>/dev/null || true)"
  [[ -f "$resolved_dim" && -x "$resolved_dim" && "$resolved_dim" == "$stage/"* ]] || {
    echo "prepared installer did not provide a regular executable facade" >&2
    exit 1
  }
  expected_version_output="DIM CLI $version (via DIM installer $version)"
  [[ "$("$stage/node_modules/.bin/dim" --version)" == "$expected_version_output" ]] || {
    echo "staged installer and installed CLI do not match bundle $version" >&2
    exit 1
  }
  validate_preparation || { echo "prepared bundle changed while staging candidate facade" >&2; exit 1; }
  printf '%s\n' "$candidate_identity" >"$stage/.dim-bootstrap-candidate"
  mv -T --no-clobber "$stage" "$candidate_root"
  [[ ! -e "$stage" ]] || { echo "candidate target appeared during installation and was preserved" >&2; exit 1; }
fi
[[ "$("$candidate_root/node_modules/.bin/dim" --version)" == "DIM CLI $version (via DIM installer $version)" ]] || {
  echo "candidate runtime does not match bundle $version" >&2
  exit 1
}

mkdir -p -- "$(dirname -- "$facade")"
if [[ ! -e "$facade" && ! -L "$facade" ]]; then
  facade_stage="$(mktemp "$(dirname -- "$facade")/.dim.XXXXXX")"
  printf '%s\n' "$expected_facade" >"$facade_stage"
  chmod 0755 "$facade_stage"
  mv -T --no-clobber "$facade_stage" "$facade"
  [[ ! -e "$facade_stage" ]] || { echo "DIM facade appeared during installation and was preserved" >&2; exit 1; }
fi
validate_preparation || { echo "prepared bundle changed before facade publication completed" >&2; exit 1; }
printf 'Installed candidate facade: %s\n' "$facade"
