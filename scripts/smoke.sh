#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

tmpdir="$(mktemp -d /tmp/dim-smoke-XXXXXX)"
cleanup() {
  set +e
  sudo docker rm -f dim-smoke-secret >/dev/null 2>&1
  sudo docker image rm -f dim-smoke-secret:latest >/dev/null 2>&1
  rm -rf "$tmpdir"
}
trap cleanup EXIT

just build-agent-image
just build-secret-example

sudo docker run --rm \
  -e DEV_INFRA_START_DOCKERD=0 \
  dev-infra-agent-workspace:latest \
  bash -lc 'test "$(whoami)" = agent && test "$HOME" = /home/agent && git --version >/dev/null && docker --version >/dev/null'

cat > "$tmpdir/config.json" <<EOF
{
  "stateRoot": "$tmpdir/state",
  "jobMountRoot": "$tmpdir/mounts",
  "managedGitHost": { "kind": "bare-git-pr", "remote": "file://$tmpdir/state/git-host" },
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

pnpm exec tsx src/cli.ts config validate --config "$tmpdir/config.json" >/dev/null
pnpm exec tsx src/cli.ts git-host init --config "$tmpdir/config.json" >/dev/null
repo_path="$(pnpm exec tsx src/cli.ts git-host create-repo --config "$tmpdir/config.json" --repo trusted-runtime)"

git clone "$repo_path" "$tmpdir/worktree" >/dev/null 2>&1
git -C "$tmpdir/worktree" config user.email test@example.invalid
git -C "$tmpdir/worktree" config user.name "Test User"
cp images/secret-runtime-example/Dockerfile images/secret-runtime-example/server.mjs "$tmpdir/worktree/"
git -C "$tmpdir/worktree" add Dockerfile server.mjs
git -C "$tmpdir/worktree" commit -m trusted-runtime >/dev/null
git -C "$tmpdir/worktree" push origin HEAD:refs/heads/main >/dev/null

git -C "$tmpdir/worktree" checkout -b docs-change >/dev/null 2>&1
printf 'reviewed change\n' > "$tmpdir/worktree/REVIEWED.txt"
git -C "$tmpdir/worktree" add REVIEWED.txt
git -C "$tmpdir/worktree" commit -m reviewed-change >/dev/null
git -C "$tmpdir/worktree" push origin HEAD:refs/heads/reviewed-change >/dev/null
pnpm exec tsx src/cli.ts pr create \
  --config "$tmpdir/config.json" \
  --repo trusted-runtime \
  --source refs/heads/reviewed-change \
  --target refs/heads/main \
  --title "Reviewed change" >/dev/null
pnpm exec tsx src/cli.ts pr approve --config "$tmpdir/config.json" --repo trusted-runtime --id 1 --reviewer smoke >/dev/null
pnpm exec tsx src/cli.ts pr merge --config "$tmpdir/config.json" --repo trusted-runtime --id 1 >/dev/null

pnpm exec tsx src/cli.ts secret deploy --config "$tmpdir/config.json" >/dev/null

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:18090/healthz >/dev/null; then
    echo "smoke-ok"
    exit 0
  fi
  sleep 1
done

echo "secret runtime health check failed" >&2
exit 1
