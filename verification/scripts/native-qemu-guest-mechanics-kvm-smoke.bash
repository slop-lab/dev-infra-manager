#!/usr/bin/env bash
set -Eeuo pipefail

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
for command in docker sha256sum timeout; do
  command -v "$command" >/dev/null || { printf '%s is required\n' "$command" >&2; exit 2; }
done
[[ "$(uname -m)" == x86_64 ]] || { printf 'native QEMU KVM guest mechanics require x86-64\n' >&2; exit 2; }
docker info >/dev/null 2>&1 || { printf 'a reachable Docker daemon is required\n' >&2; exit 2; }
[[ -c /dev/kvm && -r /dev/kvm && -w /dev/kvm ]] || {
  printf 'native QEMU KVM guest mechanics require an accessible character /dev/kvm\n' >&2
  exit 2
}

work_dir="$(mktemp -d /tmp/dim-native-qemu-kvm.XXXXXX)"
suffix="$(basename "$work_dir" | tr '[:upper:]' '[:lower:]')"
resource_prefix="dim-native-qemu-kvm-$suffix"
runner_image="$resource_prefix-runner:verification"
job_image="$resource_prefix-job:verification"
guest_root_volume="$resource_prefix-guest-root"
job_volume="$resource_prefix-job-input"
workspace_volume="$resource_prefix-workspace"
qemu_container="$resource_prefix-qemu"
resource_label="dim.verification.native-qemu-kvm=$suffix"
evidence_parent="${DIM_NATIVE_QEMU_KVM_EVIDENCE_ROOT:-$root_dir/.local/verification}"
evidence_dir="$evidence_parent/native-qemu-guest-mechanics-kvm-$suffix"
job_container=""
runner_image_id=""
job_image_id=""
qemu_exit_code=""
cleanup_complete=0
created_volumes=()
umask 077
mkdir -p "$evidence_dir/workspace"

remove_owned_container() {
  local reference="$1" allow_absent="$2" metadata id label actual_name
  local -a fields=()
  if ! metadata="$(docker container inspect "$reference" --format \
      '{{.Id}}{{println}}{{index .Config.Labels "dim.verification.native-qemu-kvm"}}{{println}}{{.Name}}' \
      2>/dev/null)"; then
    [[ "$allow_absent" -eq 1 ]]
    return
  fi
  mapfile -t fields <<<"$metadata"
  [[ "${#fields[@]}" -eq 3 ]] || return 1
  id="${fields[0]}"; label="${fields[1]}"; actual_name="${fields[2]}"
  [[ "$id" =~ ^[0-9a-f]{64}$ && "$label" == "$suffix" ]] || return 1
  if [[ "$reference" != "$id" && "$actual_name" != "/$reference" ]]; then return 1; fi
  docker container rm --force "$id" >/dev/null
}

remove_owned_volume() {
  local volume="$1" label
  label="$(docker volume inspect "$volume" \
    --format '{{index .Labels "dim.verification.native-qemu-kvm"}}' 2>/dev/null)" || return 1
  [[ "$label" == "$suffix" ]] || return 1
  docker volume rm --force "$volume" >/dev/null
}

remove_owned_image() {
  local reference="$1" expected_id="$2" metadata id label
  local -a fields=()
  if ! metadata="$(docker image inspect "$reference" --format \
      '{{.Id}}{{println}}{{index .Config.Labels "dim.verification.native-qemu-kvm"}}' 2>/dev/null)"; then
    [[ -z "$expected_id" ]]
    return
  fi
  mapfile -t fields <<<"$metadata"
  [[ "${#fields[@]}" -eq 2 ]] || return 1
  id="${fields[0]}"; label="${fields[1]}"
  [[ "$id" =~ ^sha256:[0-9a-f]{64}$ && "$id" == "$expected_id" && "$label" == "$suffix" ]] || return 1
  docker image rm --force "$reference" >/dev/null
}

cleanup_resources() {
  local failed=0 volume
  [[ -z "$job_container" ]] || remove_owned_container "$job_container" 0 || failed=1
  remove_owned_container "$qemu_container" 1 || failed=1
  for volume in "${created_volumes[@]}"; do remove_owned_volume "$volume" || failed=1; done
  remove_owned_image "$runner_image" "$runner_image_id" || failed=1
  remove_owned_image "$job_image" "$job_image_id" || failed=1
  rm -rf -- "$work_dir" || failed=1
  [[ "$failed" -eq 0 ]]
}

cleanup_on_exit() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$cleanup_complete" -eq 0 ]]; then
    cleanup_resources || status=125
    printf 'native-qemu-guest-mechanics-kvm evidence: %s\n' "$evidence_dir"
  fi
  exit "$status"
}
trap cleanup_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for image in "$runner_image" "$job_image"; do
  if docker image inspect "$image" >/dev/null 2>&1; then
    printf 'refusing to replace pre-existing image %s\n' "$image" >&2
    exit 125
  fi
done
for volume in "$guest_root_volume" "$job_volume" "$workspace_volume"; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    printf 'refusing to use pre-existing volume %s\n' "$volume" >&2
    exit 125
  fi
done
if docker container inspect "$qemu_container" >/dev/null 2>&1; then
  printf 'refusing to use pre-existing container %s\n' "$qemu_container" >&2
  exit 125
fi

cat >"$work_dir/Dockerfile" <<'EOF'
FROM alpine:3.22.2@sha256:4b7ce07002c69e8f3d704a9c5d6fd3053be500b7f1c69fc0d80990c2ad8dd412
COPY native-qemu-fork-pressure.c /build/native-qemu-fork-pressure.c
RUN apk add --no-cache bash build-base && \
    cc -Os -s -o /usr/local/bin/fork-pressure /build/native-qemu-fork-pressure.c && \
    apk del build-base && \
    addgroup -g 1000 dim && adduser -D -u 1000 -G dim dim && \
    mkdir -p /dev /proc /sys /run/dim/job /workspace /tmp
EOF
cp "$root_dir/verification/assets/native-qemu-fork-pressure.c" "$work_dir/native-qemu-fork-pressure.c"

DOCKER_BUILDKIT=0 docker build --label "$resource_label" --tag "$runner_image" \
  "$root_dir/core/packages/core/src/native-qemu-runner-assets" >"$evidence_dir/runner-build.log" 2>&1
DOCKER_BUILDKIT=0 docker build --label "$resource_label" --tag "$job_image" \
  "$work_dir" >"$evidence_dir/job-build.log" 2>&1
runner_image_id="$(docker image inspect "$runner_image" --format '{{.Id}}')"
job_image_id="$(docker image inspect "$job_image" --format '{{.Id}}')"
initramfs_sha256="$(docker run --rm "$runner_image" sha256sum /opt/dim/initramfs.gz | cut -d' ' -f1)"
kernel_sha256="$(docker run --rm "$runner_image" sha256sum /opt/dim/vmlinuz | cut -d' ' -f1)"
docker version --format 'client={{.Client.Version}} server={{.Server.Version}}' >"$evidence_dir/docker-version.txt"
docker info --format 'driver={{.Driver}} driverStatus={{json .DriverStatus}} defaultRuntime={{.DefaultRuntime}}' \
  >"$evidence_dir/docker-info.txt"

for volume in "$guest_root_volume" "$job_volume" "$workspace_volume"; do
  docker volume create --label "$resource_label" "$volume" >/dev/null
  created_volumes+=("$volume")
done
job_container="$(docker create --label "$resource_label" "$job_image")"
docker export "$job_container" | docker run --rm --interactive \
  --mount "type=volume,source=$guest_root_volume,target=/target" \
  "$runner_image" tar -x -C /target
docker container rm "$job_container" >/dev/null
job_container=""

cat >"$work_dir/job-script" <<'EOF'
set -euo pipefail
values=(candidate executed)
printf '%s:%s\n' "${values[0]}" "${values[1]}" > /workspace/bash-only-marker
printf '%s\n' "$BASH_VERSION" > /workspace/bash-version
tr '\0' '\n' < "/proc/$$/cmdline" > /workspace/argv
cat /proc/cmdline > /workspace/guest-cmdline
cat /proc/self/cgroup > /workspace/cgroup
cat /sys/fs/cgroup/dim-job/pids.max > /workspace/pids.max
while IFS= read -r line; do
  case "$line" in Uid:*|Gid:*|CapEff:*|NoNewPrivs:*) printf '%s\n' "$line" ;; esac
done < /proc/self/status > /workspace/candidate-status
if { printf 'max\n' > /sys/fs/cgroup/dim-job/pids.max; } 2>/workspace/pids-max-write.stderr; then exit 81; fi
printf 'rejected\n' > /workspace/pids-max-write
if { printf '+pids\n' > /sys/fs/cgroup/cgroup.subtree_control; } 2>/workspace/subtree-write.stderr; then exit 82; fi
printf 'rejected\n' > /workspace/subtree-write
printf 'workspace-writable\n' > /workspace/workspace-write
printf 'scratch-writable\n' > /tmp/scratch-write
cat /tmp/scratch-write > /workspace/scratch-write
/usr/local/bin/fork-pressure > /workspace/fork-pressure
cat /workspace/candidate-marker > /workspace/captured-marker
printf 'candidate-updated\n' >> /workspace/candidate-marker
EOF
printf '{"schemaVersion":1}\n' | docker run --rm --interactive \
  --mount "type=volume,source=$job_volume,target=/target" "$runner_image" \
  sh -c 'cat > /target/descriptor.json && chmod 0444 /target/descriptor.json'
docker run --rm --interactive --mount "type=volume,source=$job_volume,target=/target" "$runner_image" \
  sh -c 'cat > /target/script && chmod 0444 /target/script' <"$work_dir/job-script"
printf 'dim-qemu-candidate-marker\n' | docker run --rm --interactive \
  --mount "type=volume,source=$workspace_volume,target=/target" "$runner_image" \
  sh -c 'chmod 0700 /target && cat > /target/candidate-marker && chmod 0644 /target/candidate-marker && chown -R 65534:65534 /target'

set +e
timeout --signal=TERM --kill-after=15s 180s docker run --rm --name "$qemu_container" \
  --label "$resource_label" --read-only --network none --pids-limit 128 --device /dev/kvm \
  --user 65534:65534 --group-add "$(stat -Lc '%g' /dev/kvm)" \
  --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=volume,source=$guest_root_volume,target=/run/dim/guest-root,readonly" \
  --mount "type=volume,source=$job_volume,target=/run/dim/job,readonly" \
  --mount "type=volume,source=$workspace_volume,target=/run/dim/workspace" \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m "$runner_image" \
  qemu-system-x86_64 -machine q35,accel=kvm -cpu host -smp 1 -m 512M \
  -nodefaults -no-reboot -display none -serial stdio \
  -kernel /opt/dim/vmlinuz -initrd /opt/dim/initramfs.gz \
  -append 'console=ttyS0 panic=-1 dim.pids=8' \
  -device virtio-rng-pci -device isa-debug-exit,iobase=0xf4,iosize=0x04 \
  -fsdev local,id=jobroot,path=/run/dim/guest-root,security_model=none,readonly=on \
  -device virtio-9p-pci,fsdev=jobroot,mount_tag=jobroot \
  -fsdev local,id=job,path=/run/dim/job,security_model=none,readonly=on \
  -device virtio-9p-pci,fsdev=job,mount_tag=job \
  -fsdev local,id=workspace,path=/run/dim/workspace,security_model=mapped-xattr \
  -device virtio-9p-pci,fsdev=workspace,mount_tag=workspace \
  >"$evidence_dir/guest-console.log" 2>&1
qemu_exit_code=$?
set -e
[[ "$qemu_exit_code" -eq 85 ]]

# Guest chown/chmod and newly-created output must not change host ownership.
docker run --rm --mount "type=volume,source=$workspace_volume,target=/source,readonly" "$runner_image" \
  sh -ec 'test "$(stat -c %u:%g /source)" = 65534:65534; test "$(stat -c %u:%g /source/workspace-write)" = 65534:65534' \
  >"$evidence_dir/host-workspace-ownership.log" 2>&1

job_container="$(docker create --label "$resource_label" \
  --mount "type=volume,source=$workspace_volume,target=/source,readonly" "$runner_image" true)"
docker cp "$job_container:/source/." "$evidence_dir/workspace"
docker container rm "$job_container" >/dev/null
job_container=""
printf '/bin/bash\n--noprofile\n--norc\n/run/dim/job/script\n' >"$work_dir/expected-argv"
cmp "$work_dir/expected-argv" "$evidence_dir/workspace/argv"
grep -Fx 'candidate:executed' "$evidence_dir/workspace/bash-only-marker" >/dev/null
grep -Fx 'dim-qemu-candidate-marker' "$evidence_dir/workspace/captured-marker" >/dev/null
grep -Fx 'candidate-updated' "$evidence_dir/workspace/candidate-marker" >/dev/null
grep -Fx 'console=ttyS0 panic=-1 dim.pids=8' "$evidence_dir/workspace/guest-cmdline" >/dev/null
grep -Fx '0::/dim-job' "$evidence_dir/workspace/cgroup" >/dev/null
grep -Fx '8' "$evidence_dir/workspace/pids.max" >/dev/null
grep -Eq '^Uid:[[:space:]]+1000[[:space:]]+1000[[:space:]]+1000[[:space:]]+1000$' "$evidence_dir/workspace/candidate-status"
grep -Eq '^CapEff:[[:space:]]+0+$' "$evidence_dir/workspace/candidate-status"
grep -Eq '^NoNewPrivs:[[:space:]]+1$' "$evidence_dir/workspace/candidate-status"
grep -Fx 'rejected' "$evidence_dir/workspace/pids-max-write" >/dev/null
grep -Fx 'rejected' "$evidence_dir/workspace/subtree-write" >/dev/null
grep -Fx 'workspace-writable' "$evidence_dir/workspace/workspace-write" >/dev/null
grep -Fx 'scratch-writable' "$evidence_dir/workspace/scratch-write" >/dev/null
grep -Eq '^forked=[1-7] rejection=EAGAIN$' "$evidence_dir/workspace/fork-pressure"
printf '{"schemaVersion":1,"classification":"same-host-native-mechanics-not-independent-acceptance","acceleration":"kvm","qemuExitCode":%s,"pidsLimit":8,"runnerImageId":"%s","jobImageId":"%s","initramfsSha256":"%s","kernelSha256":"%s","jobRootStaging":"docker-export-private-volume"}\n' \
  "$qemu_exit_code" "$runner_image_id" "$job_image_id" "$initramfs_sha256" "$kernel_sha256" \
  >"$evidence_dir/summary.json"
cleanup_resources || exit 125
cleanup_complete=1
printf 'native-qemu-guest-mechanics-kvm evidence: %s\n' "$evidence_dir"
printf '%s\n' native-qemu-guest-mechanics-kvm-smoke-ok
