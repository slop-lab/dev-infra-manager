#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
run_id="$(printf '%s' "$$-$(date +%s%N)" | sha256sum | cut -c1-12)"
deployment_id="live-$run_id"
work_dir="$(mktemp -d /tmp/dim-control-plane-live.XXXXXX)"
registry_name="dim-cp-registry-$run_id"
harness_name="dim-cp-harness-$run_id"
isolated_installer_name="dim-cp-isolated-installer-$run_id"
no_compose_name="dim-cp-no-compose-$run_id"
blocker_name="dim-cp-port-blocker-$run_id"
copy_name="dim-cp-copy-$run_id"
volume_probe_name="dim-cp-volume-proof-$run_id"
harness_volume="dim-cp-harness-data-$run_id"
harness_image="dim-control-plane-live-harness:$run_id"
no_compose_image="dim-control-plane-live-no-compose:$run_id"
registry_image="registry@sha256:1be55279f18a2fe1a74edf2664cac61c1bea305b7b4642dab412e7affdcb3e33"
node_image="node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df"
docker_image="docker:29.1.3-dind@sha256:173f284a4299164772a90f52b373e73e087583c0963f1334c9995f190ef6f3f5"
native_tags=()
ordinary_tags=()
variant_tags=()
digest_refs=()
cleanup_failed=0

resource_exists() {
  docker "$1" inspect "$2" >/dev/null 2>&1
}

assert_fixed_absent() {
  local found=0
  for pair in \
    "network dim-control-plane" \
    "volume dim-control-plane-native-git-data" \
    "volume dim-control-plane-ordinary-ci-data" \
    "container dim-control-plane-native-git-1" \
    "container dim-control-plane-ordinary-ci-1"; do
    read -r kind name <<<"$pair"
    if resource_exists "$kind" "$name"; then
      printf 'refusing to mutate pre-existing Docker %s %s\n' "$kind" "$name" >&2
      found=1
    fi
  done
  if [[ -n "$(docker container ls --all --filter label=com.docker.compose.project=dim-control-plane --quiet)" ]]; then
    printf 'refusing to mutate pre-existing dim-control-plane Compose containers\n' >&2
    found=1
  fi
  [[ "$found" -eq 0 ]]
}

owned_bundle_identity() {
  local kind="$1" name="$2" service="${3:-}" labels identity detail
  case "$kind" in
    container)
      labels="$(docker container inspect "$name" --format '{{json .Config.Labels}}' 2>/dev/null)" || return 1
      identity="$(docker container inspect "$name" --format '{{.Id}}' 2>/dev/null)" || return 1
      detail="$(docker container inspect "$name" --format '{{.Name}}' 2>/dev/null)" || return 1
      [[ "$detail" == "/$name" && "$identity" =~ ^[0-9a-f]{64}$ ]] || return 1
      ;;
    network)
      labels="$(docker network inspect "$name" --format '{{json .Labels}}' 2>/dev/null)" || return 1
      identity="$(docker network inspect "$name" --format '{{.Id}}' 2>/dev/null)" || return 1
      detail="$(docker network inspect "$name" --format '{{.Driver}}' 2>/dev/null)" || return 1
      [[ "$detail" == bridge && "$identity" =~ ^[0-9a-f]{64}$ ]] || return 1
      ;;
    volume)
      labels="$(docker volume inspect "$name" --format '{{json .Labels}}' 2>/dev/null)" || return 1
      identity="$(docker volume inspect "$name" --format '{{.Name}}' 2>/dev/null)" || return 1
      detail="$(docker volume inspect "$name" --format '{{.Driver}}' 2>/dev/null)" || return 1
      [[ "$identity" == "$name" && "$detail" == local ]] || return 1
      ;;
  esac
  LABELS="$labels" DEPLOYMENT_ID="$deployment_id" RESOURCE_KIND="$kind" SERVICE_NAME="$service" node --input-type=module -e '
    const labels = JSON.parse(process.env.LABELS);
    const kind = process.env.RESOURCE_KIND;
    const service = process.env.SERVICE_NAME;
    const resource = kind === "container" ? "service" : kind;
    const expected = {
      "org.dim.managed": "true", "org.dim.bundle": "control-plane",
      "org.dim.deployment": process.env.DEPLOYMENT_ID, "org.dim.resource": resource,
      ...(service === "" ? {} : { "org.dim.service": service })
    };
    const keys = Object.keys(labels).filter((key) => key.startsWith("org.dim.")).sort();
    if (keys.join("\0") !== Object.keys(expected).sort().join("\0")) process.exit(1);
    for (const [key, value] of Object.entries(expected)) if (labels[key] !== value) process.exit(1);
    if (labels["com.docker.compose.project"] !== "dim-control-plane") process.exit(1);
    if (kind === "network" && labels["com.docker.compose.network"] !== "dim-control-plane") process.exit(1);
    if (kind === "volume" && labels["com.docker.compose.volume"] !== process.argv[1]) process.exit(1);
    if (kind === "container" && (labels["com.docker.compose.service"] !== service
      || labels["com.docker.compose.container-number"] !== "1" || labels["com.docker.compose.oneoff"] !== "False")) process.exit(1);
  ' "$name" || return 1
  printf '%s\n' "$identity"
}

remove_owned_container() {
  local name="$1" service="$2" identity
  resource_exists container "$name" || return 0
  if ! identity="$(owned_bundle_identity container "$name" "$service")"; then
    printf 'cleanup refused foreign container %s\n' "$name" >&2
    cleanup_failed=1
    return
  fi
  docker container rm --force "$identity" >/dev/null || cleanup_failed=1
}

remove_owned_network() {
  local identity
  resource_exists network dim-control-plane || return 0
  if ! identity="$(owned_bundle_identity network dim-control-plane)"; then
    printf 'cleanup refused foreign network dim-control-plane\n' >&2
    cleanup_failed=1
    return
  fi
  docker network rm "$identity" >/dev/null || cleanup_failed=1
}

remove_owned_volume() {
  local name="$1" service="$2"
  resource_exists volume "$name" || return 0
  if ! owned_bundle_identity volume "$name" "$service" >/dev/null; then
    printf 'cleanup refused foreign volume %s\n' "$name" >&2
    cleanup_failed=1
    return
  fi
  if [[ -n "$(docker container ls --all --filter "volume=$name" --quiet)" ]]; then
    printf 'cleanup refused in-use volume %s\n' "$name" >&2
    cleanup_failed=1
    return
  fi
  docker volume rm "$name" >/dev/null || cleanup_failed=1
}

remove_test_container() {
  local name="$1" identity label
  resource_exists container "$name" || return 0
  label="$(docker container inspect "$name" --format '{{index .Config.Labels "org.dim.verification"}}' 2>/dev/null)" || return
  if [[ "$label" != "$run_id" ]]; then
    printf 'cleanup refused foreign test container %s\n' "$name" >&2
    cleanup_failed=1
    return
  fi
  identity="$(docker container inspect "$name" --format '{{.Id}}')"
  docker container rm --force "$identity" >/dev/null || cleanup_failed=1
}

remove_test_volume() {
  resource_exists volume "$harness_volume" || return 0
  if [[ "$(docker volume inspect "$harness_volume" --format '{{index .Labels "org.dim.verification"}}')" != "$run_id" ]]; then
    printf 'cleanup refused foreign harness volume %s\n' "$harness_volume" >&2
    cleanup_failed=1
    return
  fi
  docker volume rm "$harness_volume" >/dev/null || cleanup_failed=1
}

remove_test_fixed_network() {
  local identity label
  resource_exists network dim-control-plane || return 0
  label="$(docker network inspect dim-control-plane --format '{{index .Labels "dev.dim.verification"}}' 2>/dev/null)" || return
  [[ "$label" == "$run_id" ]] || return 0
  identity="$(docker network inspect dim-control-plane --format '{{.Id}}')"
  docker network rm "$identity" >/dev/null || cleanup_failed=1
}

remove_test_image_ref() {
  local reference="$1" label
  docker image inspect "$reference" >/dev/null 2>&1 || return 0
  label="$(docker image inspect "$reference" --format '{{index .Config.Labels "dev.dim.verification"}}' 2>/dev/null)" || return
  if [[ "$label" != "$run_id" ]]; then
    printf 'cleanup refused foreign image reference %s\n' "$reference" >&2
    cleanup_failed=1
    return
  fi
  docker image rm "$reference" >/dev/null 2>&1 || cleanup_failed=1
}

cleanup() {
  local status="$?" labeled_images
  set +e
  remove_test_container "$harness_name"
  remove_test_container "$isolated_installer_name"
  remove_test_container "$no_compose_name"
  remove_test_container "$blocker_name"
  remove_test_container "$copy_name"
  remove_test_container "$volume_probe_name"
  remove_test_fixed_network
  remove_owned_container dim-control-plane-native-git-1 native-git
  remove_owned_container dim-control-plane-ordinary-ci-1 ordinary-ci
  remove_owned_network
  remove_owned_volume dim-control-plane-native-git-data native-git
  remove_owned_volume dim-control-plane-ordinary-ci-data ordinary-ci
  remove_test_container "$registry_name"
  remove_test_volume
  for reference in "${digest_refs[@]}" "${variant_tags[@]}" "${native_tags[@]}" "${ordinary_tags[@]}" "$harness_image" "$no_compose_image"; do
    [[ -n "$reference" ]] && remove_test_image_ref "$reference"
  done
  labeled_images="$(docker image ls --filter "label=dev.dim.verification=$run_id" --quiet)"
  if [[ -n "$labeled_images" ]]; then
    printf 'cleanup found retained test-labeled images: %s\n' "$labeled_images" >&2
    cleanup_failed=1
  fi
  rm -rf -- "$work_dir"
  if ! assert_fixed_absent; then cleanup_failed=1; fi
  printf 'cleanup fixed-resources=%s registry=%s harness=%s no-compose=%s volume=%s images=%s status=%s\n' \
    "$(resource_exists network dim-control-plane && printf present || printf absent)" \
    "$(resource_exists container "$registry_name" && printf present || printf absent)" \
    "$(resource_exists container "$harness_name" && printf present || printf absent)" \
    "$(resource_exists container "$no_compose_name" && printf present || printf absent)" \
    "$(resource_exists volume "$harness_volume" && printf present || printf absent)" \
    "$(if [[ -n "$labeled_images" ]]; then printf present; else printf absent; fi)" \
    "$cleanup_failed"
  if [[ "$status" -ne 0 || "$cleanup_failed" -ne 0 ]]; then exit 1; fi
}
trap cleanup EXIT

assert_fixed_absent
[[ "$(docker version --format '{{.Server.Version}}')" == 29.1.3 ]]
[[ "$(docker compose version --short)" == 5.0.0 ]]
daemon_socket_source="$(node -e 'const fs=require("node:fs");const line=fs.readFileSync("/proc/self/mountinfo","utf8").split("\n").find((entry)=>entry.split(" ")[4]==="/run/docker.sock");if(line)process.stdout.write(line.split(" ")[3])')"
[[ "$daemon_socket_source" =~ ^/run/user/[0-9]+/docker\.sock$ ]]

pnpm --dir "$repo_root/core/packages/core" run build >/dev/null
pnpm --dir "$repo_root/core/packages/native-git" run build >/dev/null
pnpm --dir "$repo_root/core/packages/installer" run build >/dev/null

docker container run --detach --name "$registry_name" \
  --label "org.dim.verification=$run_id" --publish 127.0.0.1::5000 "$registry_image" >/dev/null
registry_port="$(docker container port "$registry_name" 5000/tcp | cut -d: -f2)"
registry="127.0.0.1:$registry_port/dim-live-$run_id"

for generation in g1 g2; do
  native_tag="$registry/native-git:$generation"
  ordinary_tag="$registry/ordinary-ci:$generation"
  native_tags+=("$native_tag")
  ordinary_tags+=("$ordinary_tag")
  DOCKER_BUILDKIT=0 docker build --tag "$native_tag" \
    --label "dev.dim.verification=$run_id" --label "dev.dim.generation=$generation" \
    --file "$repo_root/core/images/native-git/Dockerfile" "$repo_root" >/dev/null
  DOCKER_BUILDKIT=0 docker build --tag "$ordinary_tag" \
    --label "dev.dim.verification=$run_id" --label "dev.dim.generation=$generation" \
    --file "$repo_root/core/images/ordinary-ci/Dockerfile" "$repo_root" >/dev/null
  docker push "$native_tag"
  docker push "$ordinary_tag"
done

repo_digest() {
  local tag="$1" repository reference
  repository="${tag%:*}"
  while IFS= read -r reference; do
    if [[ "$reference" == "$repository"@sha256:* && "${reference#*@sha256:}" =~ ^[0-9a-f]{64}$ ]]; then
      printf '%s\n' "$reference"
      return 0
    fi
  done < <(docker image inspect "$tag" --format '{{range .RepoDigests}}{{println .}}{{end}}')
  printf 'missing immutable RepoDigest for %s\n' "$tag" >&2
  return 1
}

g1_native="$(repo_digest "${native_tags[0]}")"
g1_ordinary="$(repo_digest "${ordinary_tags[0]}")"
g2_native="$(repo_digest "${native_tags[1]}")"
g2_ordinary="$(repo_digest "${ordinary_tags[1]}")"
digest_refs+=("$g1_native" "$g1_ordinary" "$g2_native" "$g2_ordinary")
[[ "$g1_native" != "$g2_native" && "$g1_ordinary" != "$g2_ordinary" ]]
printf 'registry-digests g1-native=%s g1-ordinary=%s g2-native=%s g2-ordinary=%s\n' \
  "$g1_native" "$g1_ordinary" "$g2_native" "$g2_ordinary"

variant_profiles=(
  compatibility-missing-field compatibility-malformed-json
  candidate-write-unreadable-by-prior non-overlapping-formats
  candidate-state-format-mismatch prior-write-unreadable-by-candidate
  prior-state-format-mismatch
)
: >"$work_dir/compatibility-variants.tsv"
for service in nativeGit ordinaryCi; do
  if [[ "$service" == nativeGit ]]; then
    base_image="$g2_native"
    image_repository="$registry/native-git-compatibility"
    service_user="10001:10001"
    format_version=7
    incompatible_format=8
  else
    base_image="$g2_ordinary"
    image_repository="$registry/ordinary-ci-compatibility"
    service_user="10002:10002"
    format_version=3
    incompatible_format=4
  fi
  for profile in "${variant_profiles[@]}"; do
    context="$work_dir/variant-$service-$profile"
    mkdir "$context"
    cat >"$context/dim-service" <<'EOF'
#!/bin/sh
set -eu
if [ "$#" -eq 2 ] && [ "$1" = compatibility ] && [ "$2" = --json ]; then
  cat /usr/local/share/dim-verification/compatibility.json
  exit 0
fi
if [ "$#" -eq 4 ] && [ "$1" = check-state ] && [ "$2" = --read-only ] && [ "$4" = --json ]; then
  cat /usr/local/share/dim-verification/state.json
  exit 0
fi
exec /usr/local/bin/dim-service-original "$@"
EOF
    compatibility="{\"schemaVersion\":1,\"writeFormat\":$format_version,\"readableFormats\":[$format_version]}"
    state="{\"schemaVersion\":1,\"stateFormat\":$format_version}"
    case "$profile" in
      compatibility-missing-field) compatibility="{\"schemaVersion\":1,\"readableFormats\":[$format_version]}" ;;
      compatibility-malformed-json) compatibility='{"schemaVersion":1,"writeFormat":' ;;
      candidate-write-unreadable-by-prior) compatibility="{\"schemaVersion\":1,\"writeFormat\":$incompatible_format,\"readableFormats\":[$format_version,$incompatible_format]}" ;;
      non-overlapping-formats)
        compatibility="{\"schemaVersion\":1,\"writeFormat\":$incompatible_format,\"readableFormats\":[$incompatible_format]}"
        state="{\"schemaVersion\":1,\"stateFormat\":$incompatible_format}"
        ;;
      candidate-state-format-mismatch) state="{\"schemaVersion\":1,\"stateFormat\":$incompatible_format}" ;;
      prior-write-unreadable-by-candidate) compatibility="{\"schemaVersion\":1,\"writeFormat\":$incompatible_format,\"readableFormats\":[$format_version,$incompatible_format]}" ;;
      prior-state-format-mismatch)
        compatibility="{\"schemaVersion\":1,\"writeFormat\":$format_version,\"readableFormats\":[$format_version,$incompatible_format]}"
        state="{\"schemaVersion\":1,\"stateFormat\":$incompatible_format}"
        ;;
    esac
    printf '%s\n' "$compatibility" >"$context/compatibility.json"
    printf '%s\n' "$state" >"$context/state.json"
    cat >"$context/Dockerfile" <<EOF
ARG BASE_IMAGE
FROM \${BASE_IMAGE}
USER 0
RUN mv /usr/local/bin/dim-service /usr/local/bin/dim-service-original \
  && mkdir -p /usr/local/share/dim-verification
COPY dim-service /usr/local/bin/dim-service
COPY compatibility.json state.json /usr/local/share/dim-verification/
RUN chmod 0555 /usr/local/bin/dim-service /usr/local/bin/dim-service-original \
  && chmod 0444 /usr/local/share/dim-verification/*.json
LABEL dev.dim.verification="$run_id" dev.dim.compatibility-profile="$profile"
USER $service_user
EOF
    tag="$image_repository:$profile"
    variant_tags+=("$tag")
    DOCKER_BUILDKIT=0 docker build --build-arg "BASE_IMAGE=$base_image" --tag "$tag" "$context" >/dev/null
    docker push "$tag" >/dev/null
    digest="$(repo_digest "$tag")"
    digest_refs+=("$digest")
    printf '%s\t%s\t%s\n' "$service" "$profile" "$digest" >>"$work_dir/compatibility-variants.tsv"
    printf 'compatibility-variant service=%s profile=%s base=%s digest=%s user=%s compatibility=%s state=%s\n' \
      "$service" "$profile" "$base_image" "$digest" "$service_user" "$compatibility" "$state"
  done
done

cat >"$work_dir/Dockerfile" <<EOF
FROM $docker_image AS docker-cli
FROM $node_image AS no-compose
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
LABEL dev.dim.verification="$run_id"
FROM no-compose AS compose
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
LABEL dev.dim.verification="$run_id"
EOF
DOCKER_BUILDKIT=0 docker build --target no-compose --tag "$no_compose_image" "$work_dir" >/dev/null
DOCKER_BUILDKIT=0 docker build --target compose --tag "$harness_image" "$work_dir" >/dev/null
docker volume create --label "org.dim.verification=$run_id" "$harness_volume" >/dev/null
harness_mount="$(docker volume inspect "$harness_volume" --format '{{.Mountpoint}}')"

tar -C "$repo_root/core/packages/installer/dist" -cf - . | docker container run --rm --interactive \
  --name "$copy_name" --label "org.dim.verification=$run_id" \
  --mount "type=volume,src=$harness_volume,dst=/payload" --entrypoint sh "$harness_image" \
  -ec 'mkdir -p /payload/installer && tar -C /payload/installer -xf -'
tar -C "$repo_root/verification/scripts" -cf - \
  control-plane-install-live-harness.mjs control-plane-install-live-support.mjs \
  control-plane-install-live-isolated.mjs \
  control-plane-install-live-fixture.mjs control-plane-install-live-runtime.mjs \
  control-plane-install-live-predecessor.mjs \
  control-plane-install-live-mutation.mjs \
  control-plane-install-live-compatibility.mjs \
  control-plane-install-live-readiness.mjs \
  control-plane-install-live-integrity.mjs \
  control-plane-install-live-denials.mjs control-plane-install-live-evidence.mjs \
  control-plane-install-live-rollback.mjs control-plane-install-live-roles.mjs \
  control-plane-install-live-prepublication.mjs control-plane-install-live-recovery.mjs \
  control-plane-install-live-missing-volume.mjs | docker container run --rm --interactive \
  --name "$copy_name" --label "org.dim.verification=$run_id" \
  --mount "type=volume,src=$harness_volume,dst=/payload" --entrypoint sh "$harness_image" \
  -ec 'tar -C /payload -xf -'
tar -C "$work_dir" -cf - compatibility-variants.tsv | docker container run --rm --interactive \
  --name "$copy_name" --label "org.dim.verification=$run_id" \
  --mount "type=volume,src=$harness_volume,dst=/payload" --entrypoint sh "$harness_image" \
  -ec 'tar -C /payload -xf -'

docker container run --name "$harness_name" --network host \
  --label "org.dim.verification=$run_id" \
  --mount "type=bind,src=$daemon_socket_source,dst=/run/docker.sock" \
  --mount "type=volume,src=$harness_volume,dst=$harness_mount" \
  --env "HARNESS_ROOT=$harness_mount" --env "DEPLOYMENT_ID=$deployment_id" \
  --env "HARNESS_VOLUME=$harness_volume" --env "DAEMON_SOCKET_SOURCE=$daemon_socket_source" \
  --env "HARNESS_IMAGE=$harness_image" --env "ISOLATED_INSTALLER_NAME=$isolated_installer_name" \
  --env "NO_COMPOSE_NAME=$no_compose_name" --env "NO_COMPOSE_IMAGE=$no_compose_image" \
  --env "BLOCKER_NAME=$blocker_name" --env "VERIFICATION_ID=$run_id" \
  --env "VOLUME_PROBE_NAME=$volume_probe_name" \
  --env "G1_NATIVE=$g1_native" --env "G1_ORDINARY=$g1_ordinary" \
  --env "G2_NATIVE=$g2_native" --env "G2_ORDINARY=$g2_ordinary" \
  "$harness_image" node "$harness_mount/control-plane-install-live-harness.mjs"

printf 'control-plane-install-live-smoke-ok deployment=%s\n' "$deployment_id"
