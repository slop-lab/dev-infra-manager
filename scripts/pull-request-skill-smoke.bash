#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
helper="$repo_root/.agents/skills/pull-request/scripts/detect-forge.bash"
work_dir="$(mktemp -d /tmp/dim-pull-request-skill.XXXXXX)"
cleanup() { find "$work_dir" -depth -delete 2>/dev/null || true; }
trap cleanup EXIT

mkdir -p "$work_dir/bin" "$work_dir/github" "$work_dir/gitea"
cat >"$work_dir/bin/curl" <<'EOF'
#!/usr/bin/env bash
case "${*: -1}" in
  https://code.example.test/api/v1/version)
    printf '%s\n' '{"version":"1.27.0"}'
    ;;
  *)
    echo "unexpected curl request: ${*: -1}" >&2
    exit 22
    ;;
esac
EOF
chmod +x "$work_dir/bin/curl"

git -C "$work_dir/github" init --quiet
git -C "$work_dir/github" remote add origin git@github.com:example/project.git
github="$(cd "$work_dir/github" && PATH="$work_dir/bin:$PATH" bash "$helper")"
test "$(jq -r .provider <<<"$github")" = github
test "$(jq -r .repository <<<"$github")" = example/project

git -C "$work_dir/gitea" init --quiet
git -C "$work_dir/gitea" remote add origin https://code.example.test/team/project.git
gitea="$(cd "$work_dir/gitea" && PATH="$work_dir/bin:$PATH" bash "$helper")"
test "$(jq -r .provider <<<"$gitea")" = gitea
test "$(jq -r .repository <<<"$gitea")" = team/project

echo pull-request-skill-smoke-ok
