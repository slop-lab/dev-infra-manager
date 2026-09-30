#!/usr/bin/env bash
set -euo pipefail

[[ "$#" == 1 ]] || {
  echo "usage: adapt-verification-layout.bash CANDIDATE_ROOT" >&2
  exit 2
}

candidate_root=$1
verification_root="$candidate_root/verification"
[[ -d "$verification_root/test" && -d "$verification_root/scripts" ]] || {
  echo "candidate verification tree is incomplete: $verification_root" >&2
  exit 2
}

replace_all() {
  local old=$1
  local new=$2
  local path content replaced
  shift 2
  for path in "$@"; do
    content=$(<"$path")
    replaced=${content//"$old"/"$new"}
    if [[ "$replaced" != "$content" ]]; then
      printf '%s' "$replaced" >"$path"
    fi
  done
}

shopt -s globstar nullglob
verification_sources=(
  "$verification_root/verify.just"
  "$verification_root"/test/**/*.ts
  "$verification_root"/scripts/**/*.bash
)

replace_all '../../project/.dim/' '../../.dim/' "${verification_sources[@]}"
replace_all 'resolve(workspaceRoot, "project/.dim")' 'resolve(workspaceRoot, ".dim")' "${verification_sources[@]}"
replace_all 'project/.dim/' '.dim/' "${verification_sources[@]}"
replace_all 'project/scripts' 'scripts' "${verification_sources[@]}"
replace_all 'project/README.md' 'README.md' "${verification_sources[@]}"
replace_all 'project/.gitea/' '.gitea/' "${verification_sources[@]}"
replace_all 'resolve(workspaceRoot, "project")' 'workspaceRoot' "${verification_sources[@]}"
replace_all 'resolve(import.meta.dirname, "../../project")' 'resolve(import.meta.dirname, "../..")' "${verification_sources[@]}"
replace_all 'root_repository="${DIM_ROOT_REPOSITORY:-$workspace_root/project}"' \
  'root_repository="${DIM_ROOT_REPOSITORY:-$workspace_root}"' \
  "$verification_root/scripts/repository-materialization-smoke.bash"

replace_all '$repo_root/project}"' '$repo_root}"' "$verification_root/scripts/local-build-version.bash"
replace_all 'mkdir(serviceDirectory)' 'mkdir(serviceDirectory, { mode: 0o755 })' \
  "$verification_root/test/qemuSetupOwnership.test.ts"
replace_all \
  'mkdir(resolve(root, "workspace")), writeFile(cliLog, "")]);' \
  'mkdir(resolve(root, "workspace")), writeFile(cliLog, "")]); await chmod(serviceDirectory, 0o755);' \
  "$verification_root/test/qemuSetupOwnership.test.ts"
replace_all 'test -d "$destination/.git" && return' 'test -d "$destination/.git" && exit 0' \
  "$verification_root/test/repositoryRefJourneyPolicy.test.ts"
replace_all \
  '{ root: workspaceRoot, installCommand: "scripts/install-source-build.bash" }' \
  '{ root: workspaceRoot, installCommand: "verification/scripts/install-dim-local.bash" }' \
  "$verification_root/test/localControlPlaneInstall.test.ts"
replace_all \
  'expect(recipes).toContain("prepare-local:\n    bash scripts/prepare-source-build.bash");' \
  'expect(recipes).toContain(`build-local-workspace-image:\n    image_version="$(bash verification/scripts/local-build-version.bash)"`);' \
  "$verification_root/test/localSourceBuildPolicy.test.ts"
replace_all \
  'expect(recipes).toContain("install-local:\n    bash scripts/install-source-build.bash");' \
  'expect(recipes).toContain("install-local:\n    bash verification/scripts/install-dim-local.bash");' \
  "$verification_root/test/localSourceBuildPolicy.test.ts"
replace_all \
  'const bashEnvironment = resolve(fixtureRoot, "bash-environment");' \
  'const tools = resolve(fixtureRoot, "tools"); await mkdir(tools);' \
  "$verification_root/test/localSourceBuildPolicy.test.ts"
replace_all 'bashEnvironment,' 'resolve(tools, "just"),' \
  "$verification_root/test/localSourceBuildPolicy.test.ts"
replace_all '"just() {\n' '"#!/usr/bin/env bash\n' \
  "$verification_root/test/localSourceBuildPolicy.test.ts"
replace_all '\n}\n"' '\n"' "$verification_root/test/localSourceBuildPolicy.test.ts"
replace_all \
  '  printf '\''\\n'\'' >>\"$DIM_INVOCATIONS\"\n"' \
  '  printf '\''\\n'\'' >>\"$DIM_INVOCATIONS\"\n", { mode: 0o755 }' \
  "$verification_root/test/localSourceBuildPolicy.test.ts"
replace_all 'const result = spawnSync("just", ["build-local-workspace-image"]' \
  'const result = spawnSync("/usr/local/bin/just", ["build-local-workspace-image"]' \
  "$verification_root/test/localSourceBuildPolicy.test.ts"
replace_all 'BASH_ENV: bashEnvironment,' 'PATH: `${tools}:${process.env.PATH ?? "/usr/bin:/bin"}`,' \
  "$verification_root/test/localSourceBuildPolicy.test.ts"
replace_all 'BASH_ENV: resolve(tools, "just"),' 'PATH: `${tools}:${process.env.PATH ?? "/usr/bin:/bin"}`,' \
  "$verification_root/test/localSourceBuildPolicy.test.ts"

if grep -R -n -E '(^|["/(])project/\.dim|project/scripts|resolve\(workspaceRoot, "project"\)|\.\./\.\./project/\.dim' \
  "$verification_root/test" "$verification_root/scripts" "$verification_root/verify.just"; then
  echo "candidate verification still contains split-checkout source paths" >&2
  exit 1
fi
