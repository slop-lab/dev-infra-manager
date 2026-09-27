#!/usr/bin/env bash
set -Eeuo pipefail

trap 'printf "gitea-repository-policy: failed at %s:%s\n" "${BASH_SOURCE[0]}" "$LINENO" >&2' ERR

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
gitea_image="gitea/gitea@sha256:7dff60d7ea6df9d0bdf78971cdb1350e9b7df3fda5f115c77afe12122887bd64"
work_dir="$(mktemp -d /tmp/dim-gitea-repository-policy.XXXXXX)"
suffix="$(basename "$work_dir" | tr '[:upper:]' '[:lower:]')"
network="dim-gitea-policy-$suffix"
gitea_container="dim-gitea-policy-$suffix"
organization="dim-policy"
repository="root"
admin_username="dim-policy-admin"
maintainer_username="dim-policy-maintainer"
owner_username="dim-policy-owner"
writer_username="dim-policy-writer"
existing_dim_gitea="$(docker container inspect dim-gitea --format '{{.Id}}|{{.State.Running}}|{{.State.StartedAt}}|{{.RestartCount}}' 2>/dev/null || true)"
credential_helper='!f() { echo username=$DIM_GIT_USERNAME; echo password=$DIM_GIT_TOKEN; }; f'
umask 077

# shellcheck source=lib/gitea-repository-policy-helpers.bash
source "$root_dir/verification/scripts/lib/gitea-repository-policy-helpers.bash"

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for command in curl docker git grep jq node openssl perl; do
  command -v "$command" >/dev/null || { printf '%s is required\n' "$command" >&2; exit 2; }
done
docker info >/dev/null 2>&1 || { printf 'a reachable Docker daemon is required\n' >&2; exit 2; }

admin_password="$(openssl rand -hex 24)"
maintainer_password="$(openssl rand -hex 24)"
owner_password="$(openssl rand -hex 24)"
writer_password="$(openssl rand -hex 24)"

docker network create --label dim.verification=gitea-repository-policy "$network" >/dev/null
docker run --detach --name "$gitea_container" \
  --label dim.verification=gitea-repository-policy \
  --publish 127.0.0.1::3000 \
  --env GITEA__database__DB_TYPE=sqlite3 \
  --env GITEA__database__PATH=/data/gitea/gitea.db \
  --env GITEA__security__INSTALL_LOCK=true \
  --env GITEA__server__DISABLE_SSH=true \
  --env GITEA__service__DISABLE_REGISTRATION=true \
  "$gitea_image" >/dev/null
docker network connect --alias gitea-policy "$network" "$gitea_container"

gitea_port="$(docker port "$gitea_container" 3000/tcp \
  | jq -Rrs 'split("\n") | map(select(length > 0)) | last | split(":") | last')"
[[ "$gitea_port" =~ ^[0-9]+$ ]] || fail 'Docker did not allocate a local Gitea port'
gitea_address="$(docker container inspect "$gitea_container" \
  --format '{{with index .NetworkSettings.Networks "bridge"}}{{.IPAddress}}{{end}}')"
[[ -n "$gitea_address" ]] || fail 'disposable Gitea has no bridge address'
gitea_url="http://$gitea_address:3000"
gitea_api_url="$gitea_url/api/v1"
repository_url="$gitea_url/$organization/$repository.git"

for attempt in $(seq 1 90); do
  if curl --fail --silent "$gitea_url/api/healthz" >/dev/null 2>&1; then
    break
  fi
  [[ "$attempt" -lt 90 ]] || { docker logs "$gitea_container" >&2; exit 1; }
  sleep 1
done
version="$(curl --fail --silent --show-error "$gitea_api_url/version" | jq -er .version)"
[[ "$version" == 1.27.0 ]] || fail "unexpected Gitea version $version"
image_id="$(docker container inspect "$gitea_container" --format '{{.Image}}')"
printf 'gitea-repository-policy: image=%s image-id=%s local-port=%s\n' "$gitea_image" "$image_id" "$gitea_port"

docker exec --user git "$gitea_container" gitea admin user create \
  --username "$admin_username" --password "$admin_password" --email admin@policy.invalid \
  --admin --must-change-password=false >/dev/null
docker exec --user git "$gitea_container" gitea admin user create \
  --username "$maintainer_username" --password "$maintainer_password" --email maintainer@policy.invalid \
  --must-change-password=false >/dev/null
docker exec --user git "$gitea_container" gitea admin user create \
  --username "$owner_username" --password "$owner_password" --email owner@policy.invalid \
  --must-change-password=false >/dev/null
docker exec --user git "$gitea_container" gitea admin user create \
  --username "$writer_username" --password "$writer_password" --email writer@policy.invalid \
  --must-change-password=false >/dev/null

expect_api_status 201 create-organization "$admin_username" "$admin_password" POST /orgs \
  "$(jq -cn --arg username "$organization" '{username:$username,full_name:$username,visibility:"private"}')" >/dev/null
expect_api_status 201 create-repository "$admin_username" "$admin_password" POST "/orgs/$organization/repos" \
  "$(jq -cn --arg name "$repository" '{name:$name,private:true,default_branch:"main",auto_init:false}')" >/dev/null
teams_output="$(expect_api_status 200 list-teams "$admin_username" "$admin_password" GET "/orgs/$organization/teams")"
owners_team_id="$(jq -er '.[] | select(.name == "Owners") | .id' "$teams_output")"
expect_api_status 204 add-owner "$admin_username" "$admin_password" PUT "/teams/$owners_team_id/members/$owner_username" >/dev/null
for membership in "$maintainer_username" "$writer_username"; do
  expect_api_status 204 "add-$membership" "$admin_username" "$admin_password" PUT \
    "/repos/$organization/$repository/collaborators/$membership" '{"permission":"write"}' >/dev/null
done

seed="$work_dir/seed"
GIT_MASTER=1 git init --quiet --initial-branch=main "$seed"
GIT_MASTER=1 git -C "$seed" config user.name 'DIM policy verification'
GIT_MASTER=1 git -C "$seed" config user.email policy@dim.invalid
mkdir -p "$seed/.dim" "$seed/.gitea" "$seed/sensitive" "$seed/src"
printf '%s\n' seed >"$seed/README.md"
printf '%s\n' rename-source >"$seed/.dim/rename-me.txt"
printf '%s\n' delete-source >"$seed/.dim/delete-me.txt"
printf '%s\n' owned-v1 >"$seed/sensitive/owned.txt"
printf '%s\n' ordinary-v1 >"$seed/src/ordinary-a.txt"
printf '^sensitive/owned[.]txt$ @%s\n' "$owner_username" >"$seed/.gitea/CODEOWNERS"
GIT_MASTER=1 git -C "$seed" add README.md .dim .gitea sensitive src
GIT_MASTER=1 git -C "$seed" commit --quiet -m 'seed repository policy fixture'
git_as "$maintainer_username" "$maintainer_password" -C "$seed" push --quiet "$repository_url" main

policy_json="$(
  cd "$root_dir"
  env ADMIN_USERNAME="$admin_username" MAINTAINER_USERNAME="$maintainer_username" node \
    --import "$root_dir/core-development/node_modules/tsx/dist/loader.mjs" --input-type=module -e '
      import { branchProtectionOptions } from "./core/packages/core/src/project-registry/repositoryProtection.ts";
      process.stdout.write(JSON.stringify(branchProtectionOptions({
        adminUsername: process.env.ADMIN_USERNAME,
        maintainerUsername: process.env.MAINTAINER_USERNAME
      })));
    '
)"
jq -e '.unprotected_file_patterns == "" and .protected_file_patterns == ""' <<<"$policy_json" >/dev/null
expect_api_status 404 missing-protection "$admin_username" "$admin_password" PATCH \
  "/repos/$organization/$repository/branch_protections/main" "$policy_json" >/dev/null
create_policy="$(jq -c '. + {branch_name:"main"}' <<<"$policy_json")"
expect_api_status 201 create-protection "$admin_username" "$admin_password" POST \
  "/repos/$organization/$repository/branch_protections" "$create_policy" >/dev/null
expect_api_status 200 update-protection "$admin_username" "$admin_password" PATCH \
  "/repos/$organization/$repository/branch_protections/main" "$policy_json" >/dev/null
protection_output="$(expect_api_status 200 get-protection "$admin_username" "$admin_password" GET \
  "/repos/$organization/$repository/branch_protections/main")"
jq -e --argjson expected "$policy_json" '
  . as $actual
  | $expected == (reduce ($expected | keys[]) as $key ({}; .[$key] = $actual[$key]))
  and $actual.rule_name == "main"
' "$protection_output" >/dev/null
printf '%s\n' 'gitea-repository-policy: exact production policy persisted'

writer_direct="$work_dir/writer-direct"
git_as "$writer_username" "$writer_password" clone --quiet "$repository_url" "$writer_direct"
GIT_MASTER=1 git -C "$writer_direct" config user.name 'DIM policy writer'
GIT_MASTER=1 git -C "$writer_direct" config user.email writer@policy.invalid
GIT_MASTER=1 git -C "$writer_direct" mv .dim/rename-me.txt sensitive-renamed.txt
GIT_MASTER=1 git -C "$writer_direct" rm --quiet .dim/delete-me.txt
printf '%s\n' writer-direct >>"$writer_direct/README.md"
GIT_MASTER=1 git -C "$writer_direct" add README.md sensitive-renamed.txt
GIT_MASTER=1 git -C "$writer_direct" commit --quiet -m 'attempt mixed sensitive direct update'
assert_rejected_push writer-sensitive-rename-delete-nondim "$writer_username" "$writer_password" \
  "$writer_direct" 'Not allowed to push to protected branch main'

owner_direct="$work_dir/owner-direct"
git_as "$owner_username" "$owner_password" clone --quiet "$repository_url" "$owner_direct"
GIT_MASTER=1 git -C "$owner_direct" config user.name 'DIM policy owner'
GIT_MASTER=1 git -C "$owner_direct" config user.email owner@policy.invalid
printf '%s\n' owner-direct >>"$owner_direct/README.md"
GIT_MASTER=1 git -C "$owner_direct" add README.md
GIT_MASTER=1 git -C "$owner_direct" commit --quiet -m 'attempt owner direct update outside dim'
assert_rejected_push owner-nondim "$owner_username" "$owner_password" "$owner_direct" \
  'Not allowed to push to protected branch main'

maintainer="$work_dir/maintainer"
git_as "$maintainer_username" "$maintainer_password" clone --quiet "$repository_url" "$maintainer"
GIT_MASTER=1 git -C "$maintainer" config user.name 'DIM policy maintainer'
GIT_MASTER=1 git -C "$maintainer" config user.email maintainer@policy.invalid
printf '%s\n' maintainer-accepted >"$maintainer/maintainer.txt"
GIT_MASTER=1 git -C "$maintainer" add maintainer.txt
GIT_MASTER=1 git -C "$maintainer" commit --quiet -m 'publish trusted maintainer update'
git_as "$maintainer_username" "$maintainer_password" -C "$maintainer" push --quiet origin main
maintainer_published_sha="$(remote_main_sha)"
[[ "$maintainer_published_sha" == "$(GIT_MASTER=1 git -C "$maintainer" rev-parse HEAD)" ]] || \
  fail 'maintainer push was not visible through Gitea'
GIT_MASTER=1 git -C "$maintainer" switch --quiet --create divergent HEAD^
printf '%s\n' force-rewrite >"$maintainer/divergent.txt"
GIT_MASTER=1 git -C "$maintainer" add divergent.txt
GIT_MASTER=1 git -C "$maintainer" commit --quiet -m 'attempt force rewrite'
force_log="$work_dir/maintainer-force-push.log"
if git_as "$maintainer_username" "$maintainer_password" -C "$maintainer" push --force origin HEAD:refs/heads/main >"$force_log" 2>&1; then
  fail 'maintainer force push unexpectedly succeeded'
fi
grep -Fq -- 'branch main is protected from force push' "$force_log" || fail 'maintainer force push failed for the wrong reason'
[[ "$(remote_main_sha)" == "$maintainer_published_sha" ]] || fail 'rejected force push changed main'
printf '%s\n' 'gitea-repository-policy: maintainer push accepted and force push denied'

proposal="$work_dir/proposal"
git_as "$writer_username" "$writer_password" clone --quiet "$repository_url" "$proposal"
GIT_MASTER=1 git -C "$proposal" config user.name 'DIM policy writer'
GIT_MASTER=1 git -C "$proposal" config user.email writer@policy.invalid
GIT_MASTER=1 git -C "$proposal" switch --quiet --create proposal-reviewed
printf '%s\n' owned-v2 >"$proposal/sensitive/owned.txt"
GIT_MASTER=1 git -C "$proposal" mv src/ordinary-a.txt src/ordinary-b.txt
printf '%s\n' new-sensitive >"$proposal/.dim/new-sensitive.txt"
GIT_MASTER=1 git -C "$proposal" add sensitive/owned.txt src .dim/new-sensitive.txt
GIT_MASTER=1 git -C "$proposal" commit --quiet -m 'propose reviewed policy changes'
git_as "$writer_username" "$writer_password" -C "$proposal" push --quiet --set-upstream origin proposal-reviewed
wait_for_branch proposal-reviewed

pr_body="$(jq -cn '{head:"proposal-reviewed",base:"main",title:"Reviewed policy proposal",body:"Disposable policy verification"}')"
pr_output="$(expect_api_status 201 create-reviewed-pr "$writer_username" "$writer_password" POST \
  "/repos/$organization/$repository/pulls" "$pr_body")"
pr_number="$(jq -er '.number | select(type == "number" and . > 0)' "$pr_output")"
pr_detail="$(expect_api_status 200 inspect-reviewed-pr "$admin_username" "$admin_password" GET \
  "/repos/$organization/$repository/pulls/$pr_number")"
jq -e --arg owner "$owner_username" \
  '([.requested_reviewers[].login] == [$owner]) and (.requested_reviewers_teams | length == 0)' \
  "$pr_detail" >/dev/null
printf 'gitea-repository-policy: CODEOWNERS routed review to %s\n' "$owner_username"

merge_path="/repos/$organization/$repository/pulls/$pr_number/merge"
wait_for_pull_mergeable "$pr_number"
merge_unapproved="$(expect_api_status 405 merge-unapproved "$admin_username" "$admin_password" POST \
  "$merge_path" '{"do":"merge"}')"
jq -e '.message == "Does not have enough approvals"' "$merge_unapproved" >/dev/null
force_merge_unapproved="$(expect_api_status 405 force-merge-unapproved "$admin_username" "$admin_password" POST \
  "$merge_path" '{"do":"merge","force_merge":true}')"
jq -e '.message == "Does not have enough approvals"' "$force_merge_unapproved" >/dev/null
non_owner_review="$(expect_api_status 200 non-owner-review "$maintainer_username" "$maintainer_password" POST \
  "/repos/$organization/$repository/pulls/$pr_number/reviews" '{"event":"APPROVED","body":"non-owner approval"}')"
jq -e '.state == "APPROVED" and .official == false and .stale == false and .dismissed == false' \
  "$non_owner_review" >/dev/null
wait_for_pull_mergeable "$pr_number"
merge_non_owner="$(expect_api_status 405 merge-non-owner-approved "$admin_username" "$admin_password" POST \
  "$merge_path" '{"do":"merge"}')"
jq -e '.message == "Does not have enough approvals"' "$merge_non_owner" >/dev/null
owner_review="$(expect_api_status 200 owner-review "$owner_username" "$owner_password" POST \
  "/repos/$organization/$repository/pulls/$pr_number/reviews" '{"event":"APPROVED","body":"owner approval"}')"
jq -e '.state == "APPROVED" and .official == true and .stale == false and .dismissed == false' \
  "$owner_review" >/dev/null
wait_for_pull_mergeable "$pr_number"
expect_api_status 200 merge-owner-approved "$admin_username" "$admin_password" POST "$merge_path" '{"do":"merge"}' >/dev/null
merged_pr="$(expect_api_status 200 inspect-merged-pr "$admin_username" "$admin_password" GET \
  "/repos/$organization/$repository/pulls/$pr_number")"
jq -e '.merged == true' "$merged_pr" >/dev/null
[[ "$(remote_main_sha)" != "$maintainer_published_sha" ]] || fail 'approved pull request did not update main'
printf '%s\n' 'gitea-repository-policy: approval and admin-override boundaries verified'

unowned="$work_dir/unowned"
git_as "$writer_username" "$writer_password" clone --quiet "$repository_url" "$unowned"
[[ "$(<"$unowned/sensitive/owned.txt")" == owned-v2 ]] || fail 'merged main did not contain the reviewed owned-file change'
[[ -f "$unowned/src/ordinary-b.txt" && ! -e "$unowned/src/ordinary-a.txt" ]] || fail 'merged main did not contain the reviewed rename'
[[ "$(<"$unowned/.dim/new-sensitive.txt")" == new-sensitive ]] || fail 'merged main did not contain the reviewed sensitive addition'
GIT_MASTER=1 git -C "$unowned" config user.name 'DIM policy writer'
GIT_MASTER=1 git -C "$unowned" config user.email writer@policy.invalid
GIT_MASTER=1 git -C "$unowned" switch --quiet --create proposal-unowned
printf '%s\n' unowned-proposal >>"$unowned/README.md"
GIT_MASTER=1 git -C "$unowned" add README.md
GIT_MASTER=1 git -C "$unowned" commit --quiet -m 'propose unowned file change'
git_as "$writer_username" "$writer_password" -C "$unowned" push --quiet --set-upstream origin proposal-unowned
wait_for_branch proposal-unowned
unowned_body="$(jq -cn '{head:"proposal-unowned",base:"main",title:"Unowned proposal",body:"CODEOWNERS negative control"}')"
unowned_pr="$(expect_api_status 201 create-unowned-pr "$writer_username" "$writer_password" POST \
  "/repos/$organization/$repository/pulls" "$unowned_body")"
jq -e '(.requested_reviewers | length == 0) and (.requested_reviewers_teams | length == 0)' "$unowned_pr" >/dev/null
printf '%s\n' 'gitea-repository-policy: unmatched path requested no CODEOWNERS reviewer'

current_dim_gitea="$(docker container inspect dim-gitea --format '{{.Id}}|{{.State.Running}}|{{.State.StartedAt}}|{{.RestartCount}}' 2>/dev/null || true)"
[[ "$current_dim_gitea" == "$existing_dim_gitea" ]] || fail 'pre-existing dim-gitea changed during disposable verification'

cleanup
if docker container inspect "$gitea_container" >/dev/null 2>&1; then
  fail 'disposable Gitea container remained after cleanup'
fi
if docker network inspect "$network" >/dev/null 2>&1; then
  fail 'disposable Gitea network remained after cleanup'
fi
trap - EXIT
printf '%s\n' 'gitea-repository-policy: cleanup confirmed'
printf '%s\n' gitea-repository-policy-smoke-ok
