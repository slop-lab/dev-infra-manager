import { DOCKER_HUB_DIRECT_HOSTNAMES } from "./registryCache.js";
import {
  QEMU_CI_APT_SOURCES,
  QEMU_CI_APT_TLS_CA_CERTIFICATE,
  QEMU_CI_GITEA_RUNNER_ARCHIVE_CHECKSUM,
  QEMU_CI_GITEA_RUNNER_URL,
  QEMU_CI_PACKER_ARCHIVE_CHECKSUM,
  QEMU_CI_PACKER_URL,
  QEMU_CI_QEMU_PLUGIN_ARCHIVE_CHECKSUM,
  QEMU_CI_QEMU_PLUGIN_SOURCE,
  QEMU_CI_QEMU_PLUGIN_URL,
  QEMU_CI_QEMU_PLUGIN_VERSION,
  QEMU_CI_SUPERVISOR_APT_PACKAGE_SPECIFICATIONS
} from "./qemuCiRunnerImageAssets.js";

export const QEMU_CI_SUPERVISOR_IMAGE = "dim-qemu-ci-supervisor:0.9";
export const QEMU_CI_SUPERVISOR_BASE_IMAGE = "ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517";

const dockerHubHostsPattern = DOCKER_HUB_DIRECT_HOSTNAMES.map((hostname) => hostname.replaceAll(".", "[.]"))
  .join("|");
const dockerHubHostsEntries = DOCKER_HUB_DIRECT_HOSTNAMES.map((hostname) => `'127.0.0.1 ${hostname}'`)
  .join(" ");

export const QEMU_CI_SUPERVISOR_DOCKERFILE = `FROM ${QEMU_CI_SUPERVISOR_BASE_IMAGE}
COPY ubuntu.sources /usr/local/share/dim-qemu-ci/ubuntu.sources
COPY snapshot-ca.pem /usr/local/share/dim-qemu-ci/snapshot-ca.pem
RUN install -m 0644 /usr/local/share/dim-qemu-ci/ubuntu.sources /etc/apt/sources.list.d/ubuntu.sources \\
 && rm -f /etc/apt/sources.list \\
 && apt-get -o Acquire::https::CaInfo=/usr/local/share/dim-qemu-ci/snapshot-ca.pem update \\
 && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::https::CaInfo=/usr/local/share/dim-qemu-ci/snapshot-ca.pem install -y --no-install-recommends \\
       ${QEMU_CI_SUPERVISOR_APT_PACKAGE_SPECIFICATIONS.join(` ${String.fromCharCode(92)}\n       `)} \\
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSLo /tmp/packer.zip ${QEMU_CI_PACKER_URL} \\
 && echo "${QEMU_CI_PACKER_ARCHIVE_CHECKSUM}  /tmp/packer.zip" | sha256sum --check \\
 && unzip /tmp/packer.zip -d /usr/local/bin packer \\
 && rm /tmp/packer.zip
RUN curl -fsSLo /tmp/packer-plugin-qemu.zip ${QEMU_CI_QEMU_PLUGIN_URL} \\
 && echo "${QEMU_CI_QEMU_PLUGIN_ARCHIVE_CHECKSUM}  /tmp/packer-plugin-qemu.zip" | sha256sum --check \\
 && install -d /usr/local/lib/packer/plugins/${QEMU_CI_QEMU_PLUGIN_SOURCE} \\
 && unzip /tmp/packer-plugin-qemu.zip -d /usr/local/lib/packer/plugins/${QEMU_CI_QEMU_PLUGIN_SOURCE} \\
 && plugin=/usr/local/lib/packer/plugins/${QEMU_CI_QEMU_PLUGIN_SOURCE}/packer-plugin-qemu_v${QEMU_CI_QEMU_PLUGIN_VERSION}_x5.0_linux_amd64 \\
 && sha256sum "$plugin" | cut -d ' ' -f 1 >"$plugin"_SHA256SUM \\
 && rm /tmp/packer-plugin-qemu.zip
RUN curl -fsSLo /tmp/gitea-runner.xz ${QEMU_CI_GITEA_RUNNER_URL} \\
 && echo "${QEMU_CI_GITEA_RUNNER_ARCHIVE_CHECKSUM}  /tmp/gitea-runner.xz" | sha256sum --check \\
 && xz -d /tmp/gitea-runner.xz \\
 && install -m 0755 /tmp/gitea-runner /usr/local/bin/gitea-runner \\
 && rm /tmp/gitea-runner
COPY supervise.bash /usr/local/bin/dim-qemu-ci-supervise
COPY prepare-image.bash /usr/local/bin/dim-qemu-ci-prepare-image
COPY verify-ubuntu-image.bash /usr/local/bin/dim-qemu-ci-verify-ubuntu-image
COPY webhook.py /usr/local/bin/dim-qemu-ci-webhook
COPY common.pkr.hcl /usr/local/share/dim-qemu-ci/common.pkr.hcl
COPY project.pkr.hcl /usr/local/share/dim-qemu-ci/project.pkr.hcl
COPY provision-common.bash /usr/local/share/dim-qemu-ci/provision-common.bash
RUN chmod 0755 /usr/local/bin/dim-qemu-ci-prepare-image /usr/local/bin/dim-qemu-ci-verify-ubuntu-image
ENTRYPOINT ["python3", "/usr/local/bin/dim-qemu-ci-webhook"]
`;

export const QEMU_CI_SUPERVISOR_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
umask 077

: "\${GITEA_INSTANCE_URL:?GITEA_INSTANCE_URL is required}"
: "\${GITEA_RUNNER_REGISTRATION_TOKEN:?GITEA_RUNNER_REGISTRATION_TOKEN is required}"
: "\${GITEA_RUNNER_NAME:?GITEA_RUNNER_NAME is required}"
: "\${DIM_QEMU_CI_JOB_IMAGE:?DIM_QEMU_CI_JOB_IMAGE is required}"
: "\${DIM_QEMU_CI_LABELS:?DIM_QEMU_CI_LABELS is required}"

data_root=/var/lib/dim-qemu-ci
run_root="$data_root/runs"
mkdir -p "$run_root"
runner_image="$(/usr/local/bin/dim-qemu-ci-prepare-image)"
runner_labels=""
IFS=',' read -r -a admitted_labels <<<"$DIM_QEMU_CI_LABELS"
for label in "\${admitted_labels[@]}"; do
  [[ -z "$runner_labels" ]] || runner_labels+=","
  runner_labels+="$label:docker://$DIM_QEMU_CI_JOB_IMAGE"
done

cleanup_dir=""
qemu_pid=""
registry_relay_pid=""
port_lock_fd=""
terminate_child() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  kill "$pid" >/dev/null 2>&1 || true
  sleep 0.2
  kill -KILL "$pid" >/dev/null 2>&1 || true
  wait "$pid" >/dev/null 2>&1 || true
}
cleanup() {
  terminate_child "$qemu_pid"
  terminate_child "$registry_relay_pid"
  [[ -z "$cleanup_dir" ]] || rm -rf -- "$cleanup_dir"
  [[ -z "$port_lock_fd" ]] || { flock -u "$port_lock_fd"; exec {port_lock_fd}>&-; }
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cleanup_dir="$(mktemp -d "$run_root/job-XXXXXX")"
chmod 0700 "$cleanup_dir"
port_locks="$data_root/port-locks"
mkdir -p "$port_locks"
port_slot=""
for candidate_slot in $(seq 0 255); do
  exec {candidate_fd}>"$port_locks/$candidate_slot.lock"
  if flock -n "$candidate_fd"; then
    port_lock_fd="$candidate_fd"
    port_slot="$candidate_slot"
    break
  fi
  exec {candidate_fd}>&-
done
if [[ -z "$port_slot" ]]; then
  echo "qemu-ci: no worker port slot is available" >&2
  exit 1
fi
registry_relay_port=$((15000 + port_slot))
ssh_port=$((25000 + port_slot))
ssh-keygen -q -t ed25519 -N '' -f "$cleanup_dir/id"
public_key="$(cat "$cleanup_dir/id.pub")"
registry_cache_upstream="\${DIM_CI_REGISTRY_CACHE_UPSTREAM:?DIM_CI_REGISTRY_CACHE_UPSTREAM is required}"
env -u GITEA_RUNNER_REGISTRATION_TOKEN socat "TCP-LISTEN:$registry_relay_port,fork,reuseaddr" "TCP:$registry_cache_upstream" &
registry_relay_pid=$!
registry_cache_ready=false
for _ in $(seq 1 20); do
  if curl --fail --silent --show-error "http://127.0.0.1:$registry_relay_port/v2/" >/dev/null; then
    registry_cache_ready=true
    break
  fi
  sleep 0.25
done
if [[ "$registry_cache_ready" != true ]]; then
  echo "qemu-ci: registry cache relay is unavailable: $registry_cache_upstream" >&2
  exit 1
fi
cat >"$cleanup_dir/meta-data" <<EOF
instance-id: dim-qemu-ci-$(date +%s%N)
local-hostname: dim-qemu-ci
EOF
  cat >"$cleanup_dir/user-data" <<EOF
#cloud-config
users:
  - name: dim
    uid: 1001
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - $public_key
write_files:
  - path: /etc/docker/daemon.json
    permissions: '0644'
    content: |
      {
        "registry-mirrors": ["http://10.0.2.2:$registry_relay_port"],
        "insecure-registries": ["10.0.2.2:$registry_relay_port"]
      }
  - path: /etc/dim-act-runner.yml
    permissions: '0644'
    content: |
      runner:
        capacity: 1
      container:
        privileged: false
        options: --device /dev/kvm
        valid_volumes: []
        docker_host: unix:///var/run/docker.sock
        force_pull: true
        require_docker: true
        bind_workdir: true
runcmd:
  - |
      sed -i -E '/[[:space:]](${dockerHubHostsPattern})([[:space:]]|$)/d' /etc/hosts
      printf '%s\\n' ${dockerHubHostsEntries} >> /etc/hosts
  - [systemctl, restart, docker]
  - [bash, -lc, "modprobe kvm && { grep -qw vmx /proc/cpuinfo && modprobe kvm_intel || modprobe kvm_amd; } && usermod -aG kvm dim"]
  - [bash, -lc, "touch /run/dim-qemu-ci-ready"]
EOF
  cloud-localds "$cleanup_dir/seed.img" "$cleanup_dir/user-data" "$cleanup_dir/meta-data"
  qemu-img create -q -f qcow2 -F qcow2 -b "$runner_image" "$cleanup_dir/root.qcow2" "\${DIM_QEMU_CI_DISK_SIZE:-64G}"
  echo "qemu-ci: start disposable runner VM name=$GITEA_RUNNER_NAME"
  env -u GITEA_RUNNER_REGISTRATION_TOKEN qemu-system-x86_64 -enable-kvm -cpu host -m "\${DIM_QEMU_CI_MEMORY_MB:-12288}" -smp "\${DIM_QEMU_CI_CPUS:-6}" \\
    -nographic -no-reboot \\
    -drive "file=$cleanup_dir/root.qcow2,if=virtio" \\
    -drive "file=$cleanup_dir/seed.img,format=raw,if=virtio" \\
    -netdev "user,id=n,hostfwd=tcp:127.0.0.1:$ssh_port-:22" -device virtio-net-pci,netdev=n &
  qemu_pid=$!
  known_hosts_ready=false
  for _ in $(seq 1 180); do
    if ssh-keyscan -T 2 -p "$ssh_port" 127.0.0.1 >"$cleanup_dir/known_hosts.next" 2>/dev/null && [[ -s "$cleanup_dir/known_hosts.next" ]]; then
      mv "$cleanup_dir/known_hosts.next" "$cleanup_dir/known_hosts"
      known_hosts_ready=true
      break
    fi
    kill -0 "$qemu_pid" >/dev/null 2>&1 || break
    sleep 2
  done
  if [[ "$known_hosts_ready" != true ]]; then
    echo "qemu-ci: disposable runner VM did not publish an SSH host key" >&2
    exit 1
  fi
  ssh_args=(-i "$cleanup_dir/id" -p "$ssh_port" -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$cleanup_dir/known_hosts" -o LogLevel=ERROR -o ConnectTimeout=2)
  scp_args=(-i "$cleanup_dir/id" -P "$ssh_port" -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$cleanup_dir/known_hosts" -o LogLevel=ERROR -o ConnectTimeout=2)
  ready=false
  for _ in $(seq 1 180); do
    if env -u GITEA_RUNNER_REGISTRATION_TOKEN ssh "\${ssh_args[@]}" dim@127.0.0.1 test -f /run/dim-qemu-ci-ready >/dev/null 2>&1; then
      ready=true
      break
    fi
    kill -0 "$qemu_pid" >/dev/null 2>&1 || break
    sleep 2
  done
  if [[ "$ready" != true ]]; then
    echo "qemu-ci: disposable runner VM did not become ready" >&2
    exit 1
  fi
  echo "qemu-ci: register one-job ephemeral runner"
  credential_dir="$(mktemp -d "$cleanup_dir/credential-XXXXXX")"
  chmod 0700 "$credential_dir"
  cat >"$credential_dir/register.yml" <<EOF
runner:
  file: .runner
EOF
  (
    cd "$credential_dir"
    /usr/local/bin/gitea-runner register --config "$credential_dir/register.yml" --no-interactive --ephemeral \
      --instance "$GITEA_INSTANCE_URL" --name "$GITEA_RUNNER_NAME" --labels "$runner_labels"
  )
  unset GITEA_RUNNER_REGISTRATION_TOKEN
  runner_file="$credential_dir/.runner"
  [[ -f "$runner_file" && ! -L "$runner_file" && "$(stat -c %a "$runner_file")" == 600 ]]
  python3 -c 'import json,sys; runner=json.load(open(sys.argv[1], encoding="utf-8")); valid=isinstance(runner,dict) and type(runner.get("id")) is int and runner["id"]>0 and all(isinstance(runner.get(field),str) and runner[field] for field in ("uuid","name","token","address")) and isinstance(runner.get("labels"),list) and all(isinstance(label,str) and label for label in runner["labels"]) and runner.get("ephemeral") is True; sys.exit(0 if valid else "invalid ephemeral runner file")' "$runner_file"
  scp "\${scp_args[@]}" "$runner_file" dim@127.0.0.1:/tmp/.runner
  rm -f -- "$runner_file"
  rm -rf -- "$credential_dir"
  timeout_seconds="\${DIM_QEMU_CI_JOB_TIMEOUT_SECONDS:-7200}"
  [[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]]
  set +e
  timeout --foreground --signal=TERM --kill-after=1s "\${timeout_seconds}s" \
    ssh "\${ssh_args[@]}" dim@127.0.0.1 \
      "sudo install -o dim -g dim -m 0600 /tmp/.runner /var/lib/gitea-runner/.runner && rm -f /tmp/.runner && cd /var/lib/gitea-runner && sudo env DIM_CI_REGISTRY_CACHE_UPSTREAM=10.0.2.2:$registry_relay_port DIM_KVM_IMAGE_CACHE=/var/lib/dim-kvm-cache /usr/local/bin/gitea-runner daemon --config /etc/dim-act-runner.yml --once"
  daemon_status=$?
  set -e
  terminate_child "$qemu_pid"
  qemu_pid=""
  if [[ "$daemon_status" -ne 0 ]]; then
    echo "qemu-ci: one-job runner exited with status $daemon_status" >&2
    exit "$daemon_status"
  fi
  echo "qemu-ci: disposable runner VM exited"
  rm -rf -- "$cleanup_dir"
cleanup_dir=""
`;
