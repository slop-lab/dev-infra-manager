export const QEMU_CI_SUPERVISOR_IMAGE = "dim-qemu-ci-supervisor:0.5";

export const QEMU_CI_SUPERVISOR_DOCKERFILE = `FROM ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517
RUN apt-get update \\
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
      ca-certificates cloud-image-utils curl openssh-client python3 qemu-system-x86 qemu-utils socat unzip util-linux xz-utils \\
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSLo /tmp/packer.zip https://releases.hashicorp.com/packer/1.16.0/packer_1.16.0_linux_amd64.zip \\
 && echo "5edcd14ab59b535040c512dbecd6ec9ef976a000b073c19d93e4c431c948581e  /tmp/packer.zip" | sha256sum --check \\
 && unzip /tmp/packer.zip -d /usr/local/bin packer \\
 && rm /tmp/packer.zip
COPY supervise.bash /usr/local/bin/dim-qemu-ci-supervise
COPY webhook.py /usr/local/bin/dim-qemu-ci-webhook
COPY runner-base.pkr.hcl /usr/local/share/dim-qemu-ci/runner-base.pkr.hcl
COPY provision-runner-base.bash /usr/local/share/dim-qemu-ci/provision-runner-base.bash
ENTRYPOINT ["python3", "/usr/local/bin/dim-qemu-ci-webhook"]
`;

export const QEMU_CI_PACKER_TEMPLATE = `packer {
  required_plugins {
    qemu = {
      version = "= 1.1.6"
      source  = "github.com/hashicorp/qemu"
    }
  }
}

variable "output_directory" { type = string }
variable "ssh_private_key_file" { type = string }
variable "ssh_public_key_file" { type = string }

source "qemu" "runner_base" {
  accelerator          = "kvm"
  cd_label             = "cidata"
  cd_content = {
    "meta-data" = "instance-id: dim-qemu-ci-packer\\nlocal-hostname: dim-qemu-ci-packer\\n"
    "user-data" = <<-EOF
      #cloud-config
      users:
        - name: dim
          uid: 1001
          sudo: ALL=(ALL) NOPASSWD:ALL
          shell: /bin/bash
          ssh_authorized_keys:
            - \${trimspace(file(var.ssh_public_key_file))}
      EOF
  }
  disk_compression     = true
  disk_image           = true
  disk_interface       = "virtio"
  disk_size            = "64G"
  format               = "qcow2"
  headless             = true
  iso_checksum         = "sha256:6e40c07ae715f744f84af0bec76415cc1987dd115b4b8de437818561f01a3733"
  iso_url              = "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img"
  net_device           = "virtio-net"
  output_directory     = var.output_directory
  qemuargs             = [["-cpu", "host"]]
  shutdown_command     = "sudo shutdown -P now"
  ssh_private_key_file = var.ssh_private_key_file
  ssh_clear_authorized_keys = true
  ssh_timeout          = "10m"
  ssh_username         = "dim"
  vm_name              = "runner-base.qcow2"
}

build {
  sources = ["source.qemu.runner_base"]
  provisioner "shell" {
    execute_command = "chmod +x {{ .Path }}; sudo {{ .Vars }} {{ .Path }}"
    script          = "/usr/local/share/dim-qemu-ci/provision-runner-base.bash"
  }
}
`;

export const QEMU_CI_PACKER_PROVISION_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

runner_version=3.2.0
runner_checksum=335d0f12e4fdf2cdc2310e9ce8ad33303d0f6889fe2efa2e1999d2f5614d440f
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
  cloud-image-utils curl git jq just openssh-client qemu-system-x86 qemu-utils xz-utils
rm -rf /var/lib/apt/lists/*
curl -fsSLo /usr/local/bin/gitea-runner.xz \\
  "https://gitea.com/gitea/runner/releases/download/v$runner_version/gitea-runner-$runner_version-linux-amd64.xz"
echo "$runner_checksum  /usr/local/bin/gitea-runner.xz" | sha256sum --check
xz -d /usr/local/bin/gitea-runner.xz
chmod 0755 /usr/local/bin/gitea-runner
install -d -o dim -g dim /var/lib/gitea-runner
cloud-init clean --logs --seed
`;

export const QEMU_CI_WEBHOOK_SCRIPT = `#!/usr/bin/env python3
import hmac
import fcntl
import json
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

authorization = os.environ["DIM_QEMU_WEBHOOK_AUTHORIZATION"]
capacity = os.environ["DIM_QEMU_CI_CAPACITY"]
state_path = os.environ.get(
    "DIM_QEMU_SCHEDULER_STATE",
    "/var/lib/dim-qemu-ci-dispatch/demand.json",
)
lock_path = state_path + ".lock"
lease_seconds = 30
heartbeat_seconds = float(os.environ.get("DIM_QEMU_SCHEDULER_HEARTBEAT_SECONDS", "5"))

def load_state_unlocked():
    try:
        with open(state_path, encoding="utf-8") as source:
            value = json.load(source)
        return {
            "queued": set(map(int, value.get("queued", []))),
            "running": set(map(int, value.get("running", []))),
            "claims": {int(key): claim for key, claim in value.get("claims", {}).items()},
        }
    except FileNotFoundError:
        return {"queued": set(), "running": set(), "claims": {}}
    except (OSError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(f"qemu-ci-scheduler: ignoring invalid state: {error}", flush=True)
        return {"queued": set(), "running": set(), "claims": {}}

def save_state_unlocked(state):
    directory = os.path.dirname(state_path)
    os.makedirs(directory, exist_ok=True)
    temporary = f"{state_path}.{capacity}.{os.getpid()}.tmp"
    with open(temporary, "w", encoding="utf-8") as output:
        json.dump({
            "queued": sorted(state["queued"]),
            "running": sorted(state["running"]),
            "claims": {str(key): value for key, value in state["claims"].items()},
        }, output)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, state_path)

def locked_update(update):
    os.makedirs(os.path.dirname(state_path), exist_ok=True)
    with open(lock_path, "a+", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = load_state_unlocked()
        result = update(state)
        save_state_unlocked(state)
        return result

def worker():
    failures = 0
    while True:
        now = time.time()
        def claim_one(state):
            for job_id, claim in list(state["claims"].items()):
                if job_id not in state["queued"] or now - float(claim.get("updated", 0)) > lease_seconds:
                    del state["claims"][job_id]
            available = sorted(state["queued"] - state["claims"].keys())
            if not available:
                return None
            job_id = available[0]
            state["claims"][job_id] = {"owner": capacity, "updated": now}
            return job_id
        job_id = locked_update(claim_one)
        if job_id is None:
            time.sleep(1)
            continue
        print(f"qemu-ci-scheduler: capacity {capacity} claimed queued job {job_id}", flush=True)
        try:
            process = subprocess.Popen(["bash", "/usr/local/bin/dim-qemu-ci-supervise"])
            while process.poll() is None:
                time.sleep(heartbeat_seconds)
                def renew(state):
                    claim = state["claims"].get(job_id)
                    if claim and claim.get("owner") == capacity:
                        claim["updated"] = time.time()
                locked_update(renew)
            if process.returncode != 0:
                raise subprocess.CalledProcessError(process.returncode, process.args)
            failures = 0
        except subprocess.CalledProcessError as error:
            print(
                f"qemu-ci-scheduler: supervisor failed: exit {error.returncode}",
                flush=True,
            )
            failures += 1
        except Exception as error:
            print(
                f"qemu-ci-scheduler: supervisor failed: {error}",
                flush=True,
            )
            failures += 1
        def release_claim(state):
            claim = state["claims"].get(job_id)
            if claim and claim.get("owner") == capacity:
                del state["claims"][job_id]
            return job_id in state["queued"]
        retry = locked_update(release_claim)
        if retry:
            delay = min(2 ** max(failures, 1), 30)
            print(
                f"qemu-ci-scheduler: queued demand remains; retrying in {delay}s",
                flush=True,
            )
            time.sleep(delay)

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/workflow-job" or not hmac.compare_digest(
            self.headers.get("Authorization", ""), authorization
        ):
            self.send_error(404)
            return
        if self.headers.get("X-Gitea-Event") != "workflow_job":
            self.send_error(400)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > 1048576:
                raise ValueError("invalid payload size")
            payload = json.loads(self.rfile.read(length))
            workflow_job = payload["workflow_job"]
            job_id = int(workflow_job["id"])
            action = payload.get("action")
            selected = "dim-qemu" in workflow_job.get("labels", [])
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            self.send_error(400)
            return
        if selected and action in ("queued", "in_progress", "completed"):
            def record_event(state):
                if action == "queued":
                    state["queued"].add(job_id)
                    state["running"].discard(job_id)
                elif action == "in_progress":
                    state["queued"].discard(job_id)
                    state["running"].add(job_id)
                else:
                    state["queued"].discard(job_id)
                    state["running"].discard(job_id)
                    state["claims"].pop(job_id, None)
            locked_update(record_event)
            print(f"qemu-ci-scheduler: {action} job {job_id}", flush=True)
        self.send_response(202)
        self.end_headers()

    def log_message(self, format, *args):
        print("qemu-ci-webhook:", format % args, flush=True)

threading.Thread(target=worker, daemon=True).start()
ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
`;

export const QEMU_CI_SUPERVISOR_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

: "\${GITEA_INSTANCE_URL:?GITEA_INSTANCE_URL is required}"
: "\${GITEA_RUNNER_REGISTRATION_TOKEN:?GITEA_RUNNER_REGISTRATION_TOKEN is required}"
: "\${GITEA_RUNNER_NAME:?GITEA_RUNNER_NAME is required}"

data_root=/var/lib/dim-qemu-ci
cache_root=/var/lib/dim-qemu-ci-cache
run_root="$data_root/runs"
cache_key=ubuntu-noble-6e40c07a-amd64-packer-1.16.0-qemu-1.1.6-gitea-runner-3.2.0-v1
runner_image="$cache_root/images/$cache_key/runner-base.qcow2"
mkdir -p "$cache_root" "$run_root"

exec 9>"$cache_root/build.lock"
flock 9
if [[ ! -f "$runner_image" ]]; then
  echo "qemu-ci: build shared Packer runner image key=$cache_key"
  (
    build_dir="$cache_root/build-$cache_key-$$"
    trap 'rm -rf -- "$build_dir"' EXIT
    rm -rf -- "$build_dir"
    mkdir -p "$build_dir/output" "$cache_root/plugins" "$(dirname "$runner_image")"
    ssh-keygen -q -t ed25519 -N '' -f "$build_dir/id"
    export PACKER_PLUGIN_PATH="$cache_root/plugins"
    packer init /usr/local/share/dim-qemu-ci/runner-base.pkr.hcl
    packer build -color=false -force \
      -var "output_directory=$build_dir/output" \
      -var "ssh_private_key_file=$build_dir/id" \
      -var "ssh_public_key_file=$build_dir/id.pub" \
      /usr/local/share/dim-qemu-ci/runner-base.pkr.hcl
    test -s "$build_dir/output/runner-base.qcow2"
    mv "$build_dir/output/runner-base.qcow2" "$runner_image"
  )
fi
flock -u 9
exec 9>&-

cleanup_dir=""
qemu_pid=""
registry_relay_pid=""
cleanup() {
  if [[ -n "$qemu_pid" ]]; then
    kill "$qemu_pid" >/dev/null 2>&1 || true
    wait "$qemu_pid" >/dev/null 2>&1 || true
  fi
  if [[ -n "$registry_relay_pid" ]]; then
    kill "$registry_relay_pid" >/dev/null 2>&1 || true
    wait "$registry_relay_pid" >/dev/null 2>&1 || true
  fi
  [[ -z "$cleanup_dir" ]] || rm -rf -- "$cleanup_dir"
}
trap cleanup EXIT INT TERM

cleanup_dir="$(mktemp -d "$run_root/job-XXXXXX")"
ssh-keygen -q -t ed25519 -N '' -f "$cleanup_dir/id"
public_key="$(cat "$cleanup_dir/id.pub")"
socat TCP-LISTEN:5000,fork,reuseaddr TCP:dim-registry-cache:5000 &
registry_relay_pid=$!
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
        "registry-mirrors": ["http://10.0.2.2:5000"],
        "insecure-registries": ["10.0.2.2:5000"]
      }
runcmd:
  - [systemctl, restart, docker]
  - [bash, -lc, "modprobe kvm && { grep -qw vmx /proc/cpuinfo && modprobe kvm_intel || modprobe kvm_amd; } && usermod -aG kvm dim"]
  - [bash, -lc, "touch /run/dim-qemu-ci-ready"]
EOF
  cloud-localds "$cleanup_dir/seed.img" "$cleanup_dir/user-data" "$cleanup_dir/meta-data"
  qemu-img create -q -f qcow2 -F qcow2 -b "$runner_image" "$cleanup_dir/root.qcow2" "\${DIM_QEMU_CI_DISK_SIZE:-64G}"
  echo "qemu-ci: start disposable runner VM name=$GITEA_RUNNER_NAME"
  qemu-system-x86_64 -enable-kvm -cpu host -m "\${DIM_QEMU_CI_MEMORY_MB:-12288}" -smp "\${DIM_QEMU_CI_CPUS:-6}" \\
    -nographic -no-reboot \\
    -drive "file=$cleanup_dir/root.qcow2,if=virtio" \\
    -drive "file=$cleanup_dir/seed.img,format=raw,if=virtio" \\
    -netdev user,id=n,hostfwd=tcp:127.0.0.1:2222-:22 -device virtio-net-pci,netdev=n &
  qemu_pid=$!
  ssh_args=(-i "$cleanup_dir/id" -p 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=2)
  ready=false
  for _ in $(seq 1 180); do
    if ssh "\${ssh_args[@]}" dim@127.0.0.1 test -f /run/dim-qemu-ci-ready >/dev/null 2>&1; then
      ready=true
      break
    fi
    kill -0 "$qemu_pid" >/dev/null 2>&1 || break
    sleep 2
  done
  if [[ "$ready" != true ]]; then
    echo "qemu-ci: disposable runner VM did not become ready" >&2
    kill "$qemu_pid" >/dev/null 2>&1 || true
    wait "$qemu_pid" || true
    exit 1
  fi
  echo "qemu-ci: register one-job ephemeral runner"
  printf '%s\\n' "$GITEA_RUNNER_REGISTRATION_TOKEN" | ssh "\${ssh_args[@]}" dim@127.0.0.1 \\
    "read -r token; cd /var/lib/gitea-runner; sudo /usr/local/bin/gitea-runner register --no-interactive --ephemeral --instance '$GITEA_INSTANCE_URL' --token \"\\$token\" --name '$GITEA_RUNNER_NAME' --labels dim-qemu:host; unset token; sudo /usr/local/bin/gitea-runner daemon; sudo poweroff"
  wait "$qemu_pid" || true
  qemu_pid=""
  echo "qemu-ci: disposable runner VM exited"
  rm -rf -- "$cleanup_dir"
cleanup_dir=""
`;
