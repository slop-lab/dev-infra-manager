export const QEMU_CI_IMAGE_PREPARE_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

common_root="\${DIM_QEMU_CI_COMMON_ROOT:-/var/lib/dim-qemu-ci-common}"
project_root="\${DIM_QEMU_CI_PROJECT_CACHE_ROOT:-/var/lib/dim-qemu-ci-project-cache}"
common_key="\${DIM_QEMU_CI_COMMON_IMAGE_KEY:?DIM_QEMU_CI_COMMON_IMAGE_KEY is required}"
project_key="\${DIM_QEMU_CI_PROJECT_IMAGE_KEY:?DIM_QEMU_CI_PROJECT_IMAGE_KEY is required}"
hook_kind="\${DIM_QEMU_CI_PROJECT_HOOK_KIND:?DIM_QEMU_CI_PROJECT_HOOK_KIND is required}"
hook_digest="\${DIM_QEMU_CI_PROJECT_HOOK_DIGEST:?DIM_QEMU_CI_PROJECT_HOOK_DIGEST is required}"
hook_source_ref="\${DIM_QEMU_CI_PROJECT_HOOK_SOURCE_REF:?DIM_QEMU_CI_PROJECT_HOOK_SOURCE_REF is required}"
hook_source_commit="\${DIM_QEMU_CI_PROJECT_HOOK_SOURCE_COMMIT:?DIM_QEMU_CI_PROJECT_HOOK_SOURCE_COMMIT is required}"
no_hook_digest=7824a5223feb3e6c4b5156d66f529b9b0bafe2a8e0ac528c4ae9005b76c80a43
common_stage=""
project_stage=""

fail() {
  printf 'qemu-ci image preparation: %s\n' "$1" >&2
  exit 1
}

valid_digest() {
  [[ "$1" =~ ^[0-9a-f]{64}$ ]]
}

cleanup() {
  [[ -z "$common_stage" ]] || rm -rf -- "$common_stage"
  [[ -z "$project_stage" ]] || rm -rf -- "$project_stage"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

valid_digest "$common_key" || fail "common image key must be a complete lowercase SHA-256 digest"
valid_digest "$project_key" || fail "Project image key must be a complete lowercase SHA-256 digest"
valid_digest "$hook_digest" || fail "Project hook digest must be a complete lowercase SHA-256 digest"
[[ "$hook_source_ref" =~ ^refs/heads/[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || fail "Project hook source ref must be a concrete branch"
[[ "$hook_source_commit" =~ ^[0-9a-f]{40,64}$ ]] || fail "Project hook source commit must be complete lowercase Git object ID"
hook_file=/var/lib/dim-qemu-ci-project/cache.bash
[[ -r "$hook_file" ]] || fail "Project hook artifact is not readable"
[[ "$(sha256sum "$hook_file" | cut -d ' ' -f 1)" == "$hook_digest" ]] || fail "Project hook artifact digest does not match"
case "$hook_kind" in
  absent)
    [[ "$hook_digest" == "$no_hook_digest" ]] || fail "absent Project hook must use the no-hook digest"
    ;;
  present)
    ;;
  *) fail "Project hook kind must be absent or present" ;;
esac

mkdir -p "$common_root/images" "$common_root/locks" "$common_root/staging"
mkdir -p "$project_root/images" "$project_root/locks" "$project_root/staging"
common_directory="$common_root/images/$common_key"
common_image="$common_directory/runner-common.qcow2"
project_directory="$project_root/images/$project_key"
project_image="$project_directory/runner-project.qcow2"

artifact_digest() {
  sha256sum "$1" | cut -d ' ' -f 1
}

check_common_chain() {
  local image="$1"
  local information
  qemu-img check "$image" >&2
  information="$(qemu-img info --backing-chain --output=json "$image")"
  python3 - "$image" "$information" <<'PY'
import json
import sys
image, payload = sys.argv[1:]
chain = json.loads(payload)
valid = (isinstance(chain, list) and len(chain) == 1 and
         chain[0].get("filename") == image and chain[0].get("format") == "qcow2" and
         "backing-filename" not in chain[0] and "full-backing-filename" not in chain[0])
if not valid:
    raise SystemExit("common image must be exactly one standalone qcow2")
PY
}

project_backing() {
  local image="$1"
  local information
  qemu-img check "$image" >&2
  information="$(qemu-img info --backing-chain --output=json "$image")"
  python3 - "$image" "$information" <<'PY'
import json
import sys
image, payload = sys.argv[1:]
chain = json.loads(payload)
valid = (isinstance(chain, list) and len(chain) == 2 and
         chain[0].get("filename") == image and chain[0].get("format") == "qcow2" and
         chain[1].get("format") == "qcow2" and
         "backing-filename" not in chain[1] and "full-backing-filename" not in chain[1])
if not valid:
    raise SystemExit("Project image must be exactly a qcow2 child and common qcow2")
backing = chain[0].get("full-backing-filename", chain[0].get("backing-filename"))
if not isinstance(backing, str) or chain[1].get("filename") != backing:
    raise SystemExit("Project backing chain is inconsistent")
print(backing)
PY
}

check_manifest() {
  local manifest="$1"
  local schema="$2"
  local key="$3"
  local image="$4"
  local common="\${5:-}"
  local kind="\${6:-}"
  local hook="\${7:-}"
  local source_ref="\${8:-}"
  local source_commit="\${9:-}"
  local digest
  [[ -f "$manifest" && -s "$image" ]] || fail "immutable image destination is incomplete"
  digest="$(artifact_digest "$image")"
  python3 - "$manifest" "$schema" "$key" "$digest" "$common" "$kind" "$hook" "$source_ref" "$source_commit" <<'PY'
import json
import sys
manifest, schema, key, digest, common, kind, hook, source_ref, source_commit = sys.argv[1:]
with open(manifest, encoding="utf-8") as stream:
    actual = json.load(stream)
expected = {"schema": schema, "key": key, "artifactSha256": digest}
if common:
    expected["commonKey"] = common
if kind:
    expected["hookKind"] = kind
    expected["hookDigest"] = hook
    expected["hookSourceRef"] = source_ref
    expected["hookSourceCommit"] = source_commit
if actual != expected:
    raise SystemExit("immutable image manifest does not match its destination")
PY
}

write_manifest() {
  local manifest="$1"
  local schema="$2"
  local key="$3"
  local digest="$4"
  local common="\${5:-}"
  local kind="\${6:-}"
  local hook="\${7:-}"
  local source_ref="\${8:-}"
  local source_commit="\${9:-}"
  python3 - "$manifest" "$schema" "$key" "$digest" "$common" "$kind" "$hook" "$source_ref" "$source_commit" <<'PY'
import json
import sys
manifest, schema, key, digest, common, kind, hook, source_ref, source_commit = sys.argv[1:]
value = {"schema": schema, "key": key, "artifactSha256": digest}
if common:
    value["commonKey"] = common
if kind:
    value["hookKind"] = kind
    value["hookDigest"] = hook
    value["hookSourceRef"] = source_ref
    value["hookSourceCommit"] = source_commit
with open(manifest, "x", encoding="utf-8") as stream:
    json.dump(value, stream, sort_keys=True, separators=(",", ":"))
    stream.write("\\n")
PY
}

publish() {
  python3 - "$1" "$2" <<'PY'
import os
import sys
os.rename(sys.argv[1], sys.argv[2])
PY
}

exec 9>"$common_root/locks/$common_key.lock"
flock 9
if [[ -e "$common_directory" ]]; then
  check_manifest "$common_directory/manifest.json" qemu-ci-common-image-v2 "$common_key" "$common_image"
  check_common_chain "$common_image"
else
  common_stage="$(mktemp -d "$common_root/staging/$common_key.XXXXXX")"
  mkdir "$common_stage/output" "$common_stage/build"
  /usr/local/bin/dim-qemu-ci-verify-ubuntu-image "$common_stage/build"
  ssh-keygen -q -t ed25519 -N '' -f "$common_stage/build/id"
  env -i PATH="$PATH" HOME="$common_stage/build" PACKER_PLUGIN_PATH=/usr/local/lib/packer/plugins \
    packer build -color=false \
      -var "output_directory=$common_stage/output" \
      -var "ssh_private_key_file=$common_stage/build/id" \
      -var "ssh_public_key_file=$common_stage/build/id.pub" \
      /usr/local/share/dim-qemu-ci/common.pkr.hcl >&2
  [[ -s "$common_stage/output/runner-common.qcow2" ]] || fail "common Packer output is missing"
  mv "$common_stage/output/runner-common.qcow2" "$common_stage/runner-common.qcow2"
  rm -rf "$common_stage/output" "$common_stage/build"
  check_common_chain "$common_stage/runner-common.qcow2"
  write_manifest "$common_stage/manifest.json" qemu-ci-common-image-v2 "$common_key" "$(artifact_digest "$common_stage/runner-common.qcow2")"
  publish "$common_stage" "$common_directory"
  common_stage=""
fi
flock -u 9
exec 9>&-

common_checksum="$(artifact_digest "$common_image")"
exec 8>"$project_root/locks/$project_key.lock"
flock 8
if [[ -e "$project_directory" ]]; then
  check_manifest "$project_directory/manifest.json" qemu-ci-project-image-v2 "$project_key" "$project_image" "$common_key" "$hook_kind" "$hook_digest" "$hook_source_ref" "$hook_source_commit"
  [[ "$(project_backing "$project_image")" == "$common_image" ]] || fail "published Project image has the wrong common backing"
else
  project_stage="$(mktemp -d "$project_root/staging/$project_key.XXXXXX")"
  mkdir "$project_stage/output" "$project_stage/build"
  ssh-keygen -q -t ed25519 -N '' -f "$project_stage/build/id"
  env -i PATH="$PATH" HOME="$project_stage/build" PACKER_PLUGIN_PATH=/usr/local/lib/packer/plugins \
    packer build -color=false \
      -var "common_image=$common_image" \
      -var "common_image_checksum=$common_checksum" \
      -var "hook_script_file=$hook_file" \
      -var "output_directory=$project_stage/output" \
      -var "ssh_private_key_file=$project_stage/build/id" \
      -var "ssh_public_key_file=$project_stage/build/id.pub" \
      /usr/local/share/dim-qemu-ci/project.pkr.hcl >&2
  [[ -s "$project_stage/output/runner-project.qcow2" ]] || fail "Project Packer output is missing"
  mv "$project_stage/output/runner-project.qcow2" "$project_stage/runner-project.qcow2"
  [[ ! -f "$project_stage/output/runner-project.qcow2.backing" ]] || mv "$project_stage/output/runner-project.qcow2.backing" "$project_stage/runner-project.qcow2.backing"
  rm -rf "$project_stage/output" "$project_stage/build"
  backing="$(project_backing "$project_stage/runner-project.qcow2")"
  if [[ "$backing" != "$common_image" ]]; then
    qemu-img rebase -u -F qcow2 -b "$common_image" "$project_stage/runner-project.qcow2" >&2
  fi
  [[ "$(project_backing "$project_stage/runner-project.qcow2")" == "$common_image" ]] || fail "Project image has the wrong common backing"
  write_manifest "$project_stage/manifest.json" qemu-ci-project-image-v2 "$project_key" "$(artifact_digest "$project_stage/runner-project.qcow2")" "$common_key" "$hook_kind" "$hook_digest" "$hook_source_ref" "$hook_source_commit"
  publish "$project_stage" "$project_directory"
  project_stage=""
fi
flock -u 8
exec 8>&-
printf '%s\n' "$project_image"
`;
