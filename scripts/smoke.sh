#!/usr/bin/env bash
set -euo pipefail

verbose=false
for arg in "$@"; do
  case "$arg" in
    --) ;;
    -v|--verbose) verbose=true ;;
    *) echo "usage: $0 [-v|--verbose]" >&2; exit 2 ;;
  esac
done

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

tmpdir="$(mktemp -d /tmp/dim-smoke-XXXXXX)"
probe_suffix="$$-$(date +%s)"
host_probe_image="dim-host-only-probe:${probe_suffix}"
inner_probe_image="dim-inner-only-probe:${probe_suffix}"
nested_smoke_container="dim-nested-smoke-${probe_suffix}"
step_log="$tmpdir/step.log"
current_step="startup"
exec 3>&1 4>&2
step() {
  current_step="$1"
  echo "[smoke] $current_step" >&3
  if [[ "$verbose" == false ]]; then
    exec >"$step_log" 2>&1
  fi
}
show_failure() {
  local status=$?
  trap - ERR
  echo "[smoke] failed: $current_step" >&4
  if [[ "$verbose" == false && -s "$step_log" ]]; then
    cat "$step_log" >&4
  fi
  exit "$status"
}
trap show_failure ERR
cleanup() {
  set +e
  docker rm -f "$nested_smoke_container" >/dev/null 2>&1
  docker rm -f dim-smoke-secret >/dev/null 2>&1
  docker image rm -f "$host_probe_image" >/dev/null 2>&1
  docker image rm -f dim-smoke-secret:latest >/dev/null 2>&1
  rm -rf "$tmpdir"
}
trap cleanup EXIT

step "build workspace"
pnpm run workspace:build
dim_bin="$repo_root/packages/dim-cli/dist/cli.js"

step "build container images"
just build-agent-image
just build-secret-example

step "verify agent image"
docker run --rm \
  -e DEV_INFRA_START_DOCKERD=0 \
  dev-infra-agent-workspace:latest \
  bash -lc 'test "$(whoami)" = agent && test "$HOME" = /home/agent && git --version >/dev/null && docker --version >/dev/null'

# Use unique tags so the isolation assertions never depend on which images the
# host or inner daemon happened to cache before this smoke run.
step "verify nested Docker isolation and resource limits"
docker tag dev-infra-agent-workspace:latest "$host_probe_image"
docker run --rm \
  --name "$nested_smoke_container" \
  --runtime sysbox-runc \
  --cpus 1 \
  --memory 256m \
  --pids-limit 128 \
  --env HOST_PROBE_IMAGE="$host_probe_image" \
  --env INNER_PROBE_IMAGE="$inner_probe_image" \
  dev-infra-agent-workspace:latest \
  bash -lc '
    ! docker image inspect "$HOST_PROBE_IMAGE" >/dev/null 2>&1
    read -r cpu_quota cpu_period < /sys/fs/cgroup/cpu.max
    test "$cpu_quota" != max
    test "$cpu_quota" -eq "$cpu_period"
    test "$(cat /sys/fs/cgroup/memory.max)" -eq 268435456
    test "$(cat /sys/fs/cgroup/pids.max)" -eq 128
    docker run --rm hello-world | grep -q "Hello from Docker"
    docker tag hello-world:latest "$INNER_PROBE_IMAGE"
  '

if docker image inspect "$inner_probe_image" >/dev/null 2>&1; then
  echo "inner Docker image leaked into the host image store: $inner_probe_image" >&2
  exit 1
fi

step "exercise managed Git pull request flow"
cat > "$tmpdir/config.json" <<EOF
{
  "stateRoot": "$tmpdir/state",
  "jobMountRoot": "$tmpdir/mounts",
  "storageBackend": { "kind": "directory" },
  "managedGitHost": {
    "kind": "bare-git-pr",
    "remote": "file://$tmpdir/state/git-host",
    "protectedRefs": ["refs/heads/main"]
  },
  "resourceProfiles": {
    "tiny": {
      "cpuCount": 1,
      "memoryBytes": "256MiB",
      "pidsLimit": 128,
      "diskBytes": "64MiB",
      "timeoutSeconds": 60
    }
  },
  "agent": {
    "image": "dev-infra-agent-workspace:latest",
    "runtime": "sysbox-runc",
    "runtimeBackend": { "kind": "sysbox", "dockerRuntime": "sysbox-runc" },
    "workspacePath": "/workspace",
    "runtimeDataPath": "/var/lib/docker",
    "env": {},
    "gitEnv": {}
  },
  "secretRuntime": {
    "endpoint": "http://127.0.0.1:18090",
    "repo": "trusted-runtime",
    "approvedRef": "refs/heads/main",
    "image": "dim-smoke-secret:latest",
    "containerName": "dim-smoke-secret",
    "contextPath": ".",
    "dockerfile": "Dockerfile",
    "publish": ["127.0.0.1:18090:7090"]
  }
}
EOF

node "$dim_bin" config validate --config "$tmpdir/config.json" >/dev/null
node "$dim_bin" git-host init --config "$tmpdir/config.json" >/dev/null
repo_path="$(node "$dim_bin" git-host create-repo --config "$tmpdir/config.json" --repo trusted-runtime)"

git clone "$repo_path" "$tmpdir/worktree" >/dev/null 2>&1
git -C "$tmpdir/worktree" config user.email test@example.invalid
git -C "$tmpdir/worktree" config user.name "Test User"
cp images/secret-runtime-example/Dockerfile images/secret-runtime-example/server.mjs "$tmpdir/worktree/"
git -C "$tmpdir/worktree" add Dockerfile server.mjs
git -C "$tmpdir/worktree" commit -m trusted-runtime >/dev/null
git -C "$tmpdir/worktree" push origin HEAD:refs/heads/bootstrap >/dev/null
initial_sha="$(git -C "$tmpdir/worktree" rev-parse HEAD)"
git --git-dir "$repo_path" update-ref refs/heads/main "$initial_sha"

git -C "$tmpdir/worktree" checkout -b docs-change >/dev/null 2>&1
printf 'reviewed change\n' > "$tmpdir/worktree/REVIEWED.txt"
git -C "$tmpdir/worktree" add REVIEWED.txt
git -C "$tmpdir/worktree" commit -m reviewed-change >/dev/null
git -C "$tmpdir/worktree" push origin HEAD:refs/heads/reviewed-change >/dev/null
node "$dim_bin" pr create \
  --config "$tmpdir/config.json" \
  --repo trusted-runtime \
  --source refs/heads/reviewed-change \
  --target refs/heads/main \
  --title "Reviewed change" >/dev/null
node "$dim_bin" pr approve --config "$tmpdir/config.json" --repo trusted-runtime --id 1 --reviewer smoke >/dev/null
node "$dim_bin" pr merge --config "$tmpdir/config.json" --repo trusted-runtime --id 1 >/dev/null

step "deploy secret runtime"
node "$dim_bin" secret deploy --config "$tmpdir/config.json" --sudo=false >/dev/null

step "wait for secret runtime health"
for _ in $(seq 1 30); do
  if curl -fs http://127.0.0.1:18090/healthz >/dev/null; then
    echo "[smoke] ok" >&3
    exit 0
  fi
  sleep 1
done

echo "secret runtime health check failed" >&2
exit 1
