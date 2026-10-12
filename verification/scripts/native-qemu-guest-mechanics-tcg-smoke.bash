#!/usr/bin/env bash
set -Eeuo pipefail

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
for command in docker sha256sum; do
  command -v "$command" >/dev/null || { printf '%s is required\n' "$command" >&2; exit 2; }
done
[[ "$(uname -m)" == x86_64 ]] || { printf 'native QEMU TCG guest mechanics require x86-64\n' >&2; exit 2; }
docker info >/dev/null 2>&1 || { printf 'a reachable Docker daemon is required\n' >&2; exit 2; }

work_dir="$(mktemp -d /tmp/dim-native-qemu-tcg.XXXXXX)"
suffix="$(basename "$work_dir" | tr '[:upper:]' '[:lower:]')"
resource_prefix="dim-native-qemu-tcg-$suffix"
runner_image="$resource_prefix-runner:verification"
job_image="$resource_prefix-job:verification"
guest_root_volume="$resource_prefix-guest-root"
job_volume="$resource_prefix-job-input"
workspace_volume="$resource_prefix-workspace"
evidence_parent="${DIM_NATIVE_QEMU_TCG_EVIDENCE_ROOT:-$root_dir/.local/verification}"
evidence_dir="$evidence_parent/native-qemu-guest-mechanics-tcg-$suffix"
job_container=""
qemu_exit_code=""
umask 077
mkdir -p "$evidence_dir/workspace"

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  [[ -z "$job_container" ]] || docker container rm --force "$job_container" >/dev/null 2>&1
  docker volume rm --force "$guest_root_volume" "$job_volume" "$workspace_volume" >/dev/null 2>&1
  docker image rm --force "$runner_image" "$job_image" >/dev/null 2>&1
  rm -rf -- "$work_dir"
  printf 'native-qemu-guest-mechanics-tcg evidence: %s\n' "$evidence_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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

DOCKER_BUILDKIT=0 docker build --tag "$runner_image" \
  "$root_dir/core/packages/core/src/native-qemu-runner-assets" >"$evidence_dir/runner-build.log" 2>&1
DOCKER_BUILDKIT=0 docker build --tag "$job_image" "$work_dir" >"$evidence_dir/job-build.log" 2>&1
runner_image_id="$(docker image inspect "$runner_image" --format '{{.Id}}')"
job_image_id="$(docker image inspect "$job_image" --format '{{.Id}}')"
initramfs_sha256="$(docker run --rm "$runner_image" sha256sum /opt/dim/initramfs.gz | cut -d' ' -f1)"
kernel_sha256="$(docker run --rm "$runner_image" sha256sum /opt/dim/vmlinuz | cut -d' ' -f1)"
docker version --format 'client={{.Client.Version}} server={{.Server.Version}}' >"$evidence_dir/docker-version.txt"
docker info --format 'driver={{.Driver}} driverStatus={{json .DriverStatus}} defaultRuntime={{.DefaultRuntime}}' \
  >"$evidence_dir/docker-info.txt"

for volume in "$guest_root_volume" "$job_volume" "$workspace_volume"; do
  docker volume create --label dim.verification=native-qemu-guest-mechanics-tcg "$volume" >/dev/null
done
job_container="$(docker create "$job_image")"
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
  sh -c 'chmod 0755 /target && cat > /target/candidate-marker && chmod 0644 /target/candidate-marker'

set +e
docker run --rm --read-only --network none --pids-limit 128 \
  --mount "type=volume,source=$guest_root_volume,target=/run/dim/guest-root,readonly" \
  --mount "type=volume,source=$job_volume,target=/run/dim/job,readonly" \
  --mount "type=volume,source=$workspace_volume,target=/run/dim/workspace" \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m "$runner_image" \
  qemu-system-x86_64 -machine q35,accel=tcg -cpu max -smp 1 -m 512M \
  -nodefaults -no-reboot -display none -serial stdio \
  -kernel /opt/dim/vmlinuz -initrd /opt/dim/initramfs.gz \
  -append 'console=ttyS0 panic=-1 dim.pids=8' \
  -device virtio-rng-pci -device isa-debug-exit,iobase=0xf4,iosize=0x04 \
  -fsdev local,id=jobroot,path=/run/dim/guest-root,security_model=none,readonly=on \
  -device virtio-9p-pci,fsdev=jobroot,mount_tag=jobroot \
  -fsdev local,id=job,path=/run/dim/job,security_model=none,readonly=on \
  -device virtio-9p-pci,fsdev=job,mount_tag=job \
  -fsdev local,id=workspace,path=/run/dim/workspace,security_model=none \
  -device virtio-9p-pci,fsdev=workspace,mount_tag=workspace \
  >"$evidence_dir/guest-console.log" 2>&1
qemu_exit_code=$?
set -e
[[ "$qemu_exit_code" -eq 85 ]]

job_container="$(docker create --mount "type=volume,source=$workspace_volume,target=/source,readonly" \
  "$runner_image" true)"
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
printf '{"schemaVersion":1,"classification":"guest-mechanics-not-KVM-acceptance","acceleration":"tcg","qemuExitCode":%s,"pidsLimit":8,"runnerImageId":"%s","jobImageId":"%s","initramfsSha256":"%s","kernelSha256":"%s","jobRootStaging":"docker-export-private-volume"}\n' \
  "$qemu_exit_code" "$runner_image_id" "$job_image_id" "$initramfs_sha256" "$kernel_sha256" \
  >"$evidence_dir/summary.json"
printf '%s\n' native-qemu-guest-mechanics-tcg-smoke-ok
