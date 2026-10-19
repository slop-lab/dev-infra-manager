#!/usr/bin/env bash
set -euo pipefail

workbench_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$workbench_root/.agents/skills/pull-request/scripts/detect-forge.bash"
work_dir="$(mktemp -d /tmp/dim-pull-request-skill.XXXXXX)"
cleanup() { find "$work_dir" -depth -delete 2>/dev/null || true; }
trap cleanup EXIT

mkdir -p "$work_dir/bin" "$work_dir/repository"
cat >"$work_dir/bin/curl" <<'EOF'
#!/usr/bin/env bash
printf called >"$DIM_PR_SKILL_NETWORK_TOUCH"
exit 70
EOF
chmod +x "$work_dir/bin/curl"
cp "$work_dir/bin/curl" "$work_dir/bin/gh"

detect() {
  (cd "$work_dir/repository" && PATH="$work_dir/bin:$PATH" \
    DIM_PR_SKILL_NETWORK_TOUCH="$work_dir/network-called" bash "$helper" 2>&1)
}

git -C "$work_dir/repository" init --quiet
git -C "$work_dir/repository" remote add origin git@github.com:example/project.git
github="$(detect)"
jq -e '.provider == "github" and .repository == "example/project" and .remoteUrl == "https://github.com/example/project.git"' <<<"$github" >/dev/null

git -C "$work_dir/repository" remote set-url origin http://127.0.0.1:19419/v1/projects/project/repositories/root.git
if native="$(detect)"; then echo 'native Git was mistaken for a PR forge' >&2; exit 1; else test "$?" -eq 3; fi
jq -e '.provider == "unknown" and (.reason | type == "string")' <<<"$native" >/dev/null

git -C "$work_dir/repository" remote set-url origin https://operator:credential-must-not-leak@github.com/example/project.git
if redacted="$(detect)"; then echo 'credential-bearing remote was accepted' >&2; exit 1; else test "$?" -eq 3; fi
jq -e '.provider == "unknown"' <<<"$redacted" >/dev/null
[[ "$redacted" != *operator* && "$redacted" != *credential-must-not-leak* ]]
test ! -e "$work_dir/network-called"

echo pull-request-skill-smoke-ok
