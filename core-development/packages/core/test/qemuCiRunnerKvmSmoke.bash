#!/usr/bin/env bash
set -euo pipefail

namespace="${1:?unique namespace is required}"
image="${2:?production supervisor image is required}"
common_key="${3:?common key is required}"
alpha_key="${4:?alpha Project key is required}"
alpha_hook="${5:?alpha hook is required}"
beta_key="${6:?beta Project key is required}"
beta_hook="${7:?beta hook is required}"
common_volume="$namespace-common"
alpha_volume="$namespace-alpha"
beta_volume="$namespace-beta"
reuse_volume="$namespace-reuse"
volumes=("$common_volume" "$alpha_volume" "$beta_volume" "$reuse_volume")

cleanup() {
  mapfile -t containers < <(docker container ls --all --quiet --filter "label=dim.qemu-kvm-smoke=$namespace")
  [[ "${#containers[@]}" -eq 0 ]] || docker rm --force "${containers[@]}" >/dev/null 2>&1 || true
  docker volume rm --force "${volumes[@]}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

container_name() {
  REPLY="$namespace-$RANDOM-$RANDOM"
}

docker volume create "$common_volume" >/dev/null
docker volume create "$alpha_volume" >/dev/null
docker volume create "$beta_volume" >/dev/null
docker volume create "$reuse_volume" >/dev/null

prepare_project() {
  local project_volume="$1" project_key="$2" hook="$3"
  container_name
  docker run --rm --name "$REPLY" --label "dim.qemu-kvm-smoke=$namespace" --device /dev/kvm \
    --mount "type=volume,source=$common_volume,target=/var/lib/dim-qemu-ci-common" \
    --mount "type=volume,source=$project_volume,target=/var/lib/dim-qemu-ci-project-cache" \
    --mount "type=bind,source=$hook,target=/var/lib/dim-qemu-ci-project/cache.bash,readonly" \
    --env "DIM_QEMU_CI_COMMON_IMAGE_KEY=$common_key" \
    --env "DIM_QEMU_CI_PROJECT_IMAGE_KEY=$project_key" \
    --env DIM_QEMU_CI_PROJECT_HOOK_KIND=present \
    --env "DIM_QEMU_CI_PROJECT_HOOK_DIGEST=$(sha256sum "$hook" | cut -d ' ' -f 1)" \
    --env DIM_QEMU_CI_PROJECT_HOOK_SOURCE_REF=refs/heads/main \
    --env "DIM_QEMU_CI_PROJECT_HOOK_SOURCE_COMMIT=$project_key" \
    --env GITEA_INSTANCE_URL=layer-secret.invalid \
    --env GITEA_RUNNER_REGISTRATION_TOKEN=layer-secret-token \
    --env GITEA_RUNNER_NAME=layer-secret-runner \
    --env DIM_QEMU_JOB_DATA=layer-secret-job \
    --entrypoint /usr/local/bin/dim-qemu-ci-prepare-image "$image" >/dev/null
}

in_layers() {
  local project_volume="$1"
  shift
  container_name
  docker run --rm --name "$REPLY" --label "dim.qemu-kvm-smoke=$namespace" \
    --mount "type=volume,source=$common_volume,target=/var/lib/dim-qemu-ci-common,readonly" \
    --mount "type=volume,source=$project_volume,target=/var/lib/dim-qemu-ci-project-cache,readonly" \
    --entrypoint bash "$image" -ceu "$*"
}

prepare_project "$alpha_volume" "$alpha_key" "$alpha_hook"
prepare_project "$beta_volume" "$beta_key" "$beta_hook"
common_image="/var/lib/dim-qemu-ci-common/images/$common_key/runner-common.qcow2"
alpha_image="/var/lib/dim-qemu-ci-project-cache/images/$alpha_key/runner-project.qcow2"
beta_image="/var/lib/dim-qemu-ci-project-cache/images/$beta_key/runner-project.qcow2"

inspect_chain() {
  local project_volume="$1" project_image="$2"
  in_layers "$project_volume" "python3 - '$common_image' '$project_image' \"\$(qemu-img info --backing-chain --output=json '$project_image')\" <<'PY'
import json
import sys
common, project, payload = sys.argv[1:]
chain = json.loads(payload)
assert len(chain) == 2
assert chain[0][\"filename\"] == project and chain[0][\"format\"] == \"qcow2\"
assert chain[1][\"filename\"] == common and chain[1][\"format\"] == \"qcow2\"
assert chain[0].get(\"full-backing-filename\", chain[0].get(\"backing-filename\")) == common
assert \"backing-filename\" not in chain[1] and \"full-backing-filename\" not in chain[1]
PY"
}

container_name
docker run --rm --name "$REPLY" --label "dim.qemu-kvm-smoke=$namespace" --mount "type=volume,source=$common_volume,target=/common,readonly" \
  --entrypoint bash "$image" -ceu 'payload="$(qemu-img info --backing-chain --output=json "$1")"; python3 - "$1" "$payload" <<'"'"'PY'"'"'
import json
import sys
image, payload = sys.argv[1:]
chain = json.loads(payload)
assert len(chain) == 1 and chain[0]["filename"] == image and chain[0]["format"] == "qcow2"
assert "backing-filename" not in chain[0] and "full-backing-filename" not in chain[0]
PY' -- "/common/images/$common_key/runner-common.qcow2"
inspect_chain "$alpha_volume" "$alpha_image"
inspect_chain "$beta_volume" "$beta_image"

common_before="$(in_layers "$alpha_volume" "sha256sum '$common_image' | cut -d ' ' -f 1")"
alpha_before="$(in_layers "$alpha_volume" "sha256sum '$alpha_image' | cut -d ' ' -f 1")"
beta_before="$(in_layers "$beta_volume" "sha256sum '$beta_image' | cut -d ' ' -f 1")"

boot_guest() {
  local project_volume="$1" base_image="$2" guest_command="$3"
  container_name
  docker run --rm --name "$REPLY" --label "dim.qemu-kvm-smoke=$namespace" --device /dev/kvm \
    --mount "type=volume,source=$common_volume,target=/var/lib/dim-qemu-ci-common,readonly" \
    --mount "type=volume,source=$project_volume,target=/var/lib/dim-qemu-ci-project-cache,readonly" \
    --env "SMOKE_GUEST_COMMAND=$guest_command" --entrypoint bash "$image" -ceu '
work="$(mktemp -d)"
pid=""
finish() { [[ -z "$pid" ]] || { kill "$pid" >/dev/null 2>&1 || true; wait "$pid" >/dev/null 2>&1 || true; }; rm -rf "$work"; }
trap finish EXIT INT TERM
ssh-keygen -q -t ed25519 -N "" -f "$work/id"
key="$(cat "$work/id.pub")"
printf "instance-id: dim-kvm-smoke-%s\nlocal-hostname: dim-kvm-smoke\n" "$RANDOM" >"$work/meta-data"
printf "#cloud-config\nusers:\n  - name: dim\n    uid: 1001\n    sudo: ALL=(ALL) NOPASSWD:ALL\n    shell: /bin/bash\n    ssh_authorized_keys:\n      - %s\nruncmd:\n  - [bash, -lc, \"touch /run/dim-smoke-ready\"]\n" "$key" >"$work/user-data"
cloud-localds "$work/seed.img" "$work/user-data" "$work/meta-data"
qemu-img create -q -f qcow2 -F qcow2 -b "$1" "$work/job.qcow2" 64G
qemu-img check "$work/job.qcow2" >/dev/null
chain="$(qemu-img info --backing-chain --output=json "$work/job.qcow2")"
python3 - "$work/job.qcow2" "$1" "$chain" <<'PY'
import json
import sys
job, base, payload = sys.argv[1:]
chain = json.loads(payload)
assert len(chain) >= 2
assert chain[0]["filename"] == job and chain[0]["format"] == "qcow2"
assert chain[1]["filename"] == base and chain[1]["format"] == "qcow2"
assert chain[0].get("full-backing-filename", chain[0].get("backing-filename")) == base
PY
qemu-system-x86_64 -enable-kvm -cpu host -m 3072 -smp 2 -nographic -no-reboot \
  -drive "file=$work/job.qcow2,if=virtio" -drive "file=$work/seed.img,format=raw,if=virtio" \
  -netdev user,id=n,hostfwd=tcp:127.0.0.1:2222-:22 -device virtio-net-pci,netdev=n >"$work/qemu.log" 2>&1 &
pid=$!
ssh_args=(-i "$work/id" -p 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=2)
ready=false
for _ in $(seq 1 180); do
  if ssh "${ssh_args[@]}" dim@127.0.0.1 test -f /run/dim-smoke-ready >/dev/null 2>&1; then ready=true; break; fi
  kill -0 "$pid" >/dev/null 2>&1 || break
  sleep 2
done
[[ "$ready" == true ]] || { tail -n 80 "$work/qemu.log" >&2; exit 1; }
installed_key="$(ssh "${ssh_args[@]}" dim@127.0.0.1 sudo cat /home/dim/.ssh/authorized_keys)"
[[ "$installed_key" == "$key" ]]
ssh "${ssh_args[@]}" dim@127.0.0.1 "$SMOKE_GUEST_COMMAND"
ssh "${ssh_args[@]}" dim@127.0.0.1 sudo poweroff >/dev/null 2>&1 || true
wait "$pid" || true
pid=""
' -- "$base_image"
}

no_secrets='! sudo grep -R -F -e layer-secret.invalid -e layer-secret-token -e layer-secret-runner -e layer-secret-job /etc /home /var/lib 2>/dev/null'
boot_guest "$alpha_volume" "$common_image" "test ! -e /var/lib/dim-kvm-cache/project-alpha; test ! -e /var/lib/dim-kvm-cache/project-beta; $no_secrets"
boot_guest "$alpha_volume" "$alpha_image" "test \"\$(sudo cat /var/lib/dim-kvm-cache/project-alpha)\" = 'uid=0
arg=/var/lib/dim-kvm-cache
project=project-alpha'; test ! -e /var/lib/dim-kvm-cache/project-beta; $no_secrets"
boot_guest "$beta_volume" "$beta_image" "test \"\$(sudo cat /var/lib/dim-kvm-cache/project-beta)\" = 'uid=0
arg=/var/lib/dim-kvm-cache
project=project-beta'; test ! -e /var/lib/dim-kvm-cache/project-alpha; $no_secrets"
boot_guest "$alpha_volume" "$alpha_image" "sudo touch /var/lib/dim-kvm-cache/first-job-only"
boot_guest "$alpha_volume" "$alpha_image" "test ! -e /var/lib/dim-kvm-cache/first-job-only"

test "$(in_layers "$alpha_volume" "sha256sum '$common_image' | cut -d ' ' -f 1")" = "$common_before"
test "$(in_layers "$alpha_volume" "sha256sum '$alpha_image' | cut -d ' ' -f 1")" = "$alpha_before"
test "$(in_layers "$beta_volume" "sha256sum '$beta_image' | cut -d ' ' -f 1")" = "$beta_before"

docker volume rm "$alpha_volume" "$beta_volume" >/dev/null
volumes=("$common_volume" "$reuse_volume")
prepare_project "$reuse_volume" "$alpha_key" "$alpha_hook"
test "$(in_layers "$reuse_volume" "sha256sum '$common_image' | cut -d ' ' -f 1")" = "$common_before"
inspect_chain "$reuse_volume" "$alpha_image"
printf 'qemu-ci-image-layers-kvm-ok\n'
