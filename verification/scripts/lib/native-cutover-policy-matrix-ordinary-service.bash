#!/usr/bin/env bash
set -euo pipefail

die() {
  printf 'native-cutover-policy-matrix ordinary service: %s\n' "$1" >&2
  exit 2
}

[[ "$#" -ge 3 ]] || die "usage: ACTION CONTAINER INSTALL_CONFIG [EXPECTED_ID EXPECTED_STATE_SHA256]"
action="$1"
container="$2"
install_config="$3"
[[ "$install_config" = /* && -f "$install_config" && ! -L "$install_config" ]] || die "install config is unsafe"

inspect_service() {
  local target="$1" raw id name image_id image_ref command generation labels running deployment expected_image
  deployment="$(jq -er '.deploymentId' "$install_config")"
  expected_image="$(jq -er '.ordinaryCi.image' "$install_config")"
  raw="$(docker container inspect "$target" --format '{{.Id}}\n{{.Name}}\n{{.Image}}\n{{.Config.Image}}\n{{json .Config.Cmd}}\n{{json .Config.Labels}}\n{{.State.Running}}')" ||
    die "owned ordinary service container is unavailable"
  mapfile -t fields <<<"$raw"
  [[ "${#fields[@]}" -eq 7 ]] || die "ordinary service inspection is malformed"
  id="${fields[0]}"; name="${fields[1]}"; image_id="${fields[2]}"; image_ref="${fields[3]}"
  command="${fields[4]}"; labels="${fields[5]}"; running="${fields[6]}"
  [[ "$id" =~ ^[0-9a-f]{64}$ && "$name" == "/$container" && "$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
     "$image_ref" == "$expected_image" && ( "$running" == true || "$running" == false ) ]] ||
    die "ordinary service immutable identity differs from installed state"
  generation="$(jq -er 'if length == 3 and .[0] == "serve" and .[1] == "/run/secrets/service.json" and
    (.[2] | test("^[0-9a-f]{64}$")) then .[2] else error("invalid command") end' <<<"$command")" ||
    die "ordinary service command differs from installed state"
  jq -e --arg deployment "$deployment" '
    ([keys[] | select(startswith("org.dim."))] | sort) ==
      ["org.dim.bundle","org.dim.deployment","org.dim.managed","org.dim.resource","org.dim.service"] and
    .["org.dim.managed"] == "true" and .["org.dim.bundle"] == "control-plane" and
    .["org.dim.deployment"] == $deployment and .["org.dim.resource"] == "service" and
    .["org.dim.service"] == "ordinary-ci" and .["com.docker.compose.project"] == "dim-control-plane" and
    .["com.docker.compose.service"] == "ordinary-ci" and
    .["com.docker.compose.container-number"] == "1" and .["com.docker.compose.oneoff"] == "False"
  ' <<<"$labels" >/dev/null || die "ordinary service ownership labels differ from installed state"
  jq -cn --arg containerId "$id" --arg name "$name" --arg imageId "$image_id" \
    --arg imageRef "$image_ref" --arg generationId "$generation" --argjson labels "$labels" --argjson running "$running" \
    '{containerId:$containerId,name:$name,imageId:$imageId,imageRef:$imageRef,generationId:$generationId,
      labels:$labels,running:$running}'
}

state_sha256() {
  local id="$1" digest
  digest="$(docker container exec --user 10002:10002 "$id" node --input-type=module -e '
    import { createHash } from "node:crypto";
    import { readFileSync } from "node:fs";
    import { DatabaseSync } from "node:sqlite";
    const config = JSON.parse(readFileSync("/run/secrets/service.json", "utf8"));
    const marker = JSON.parse(readFileSync("/var/lib/dim-ordinary-ci/state-format.json", "utf8"));
    const configKeys = ["claimLeaseMilliseconds", "credentials", "database", "eligibilityLeaseMilliseconds", "hosts", "nativeGit", "schemaVersion", "serviceId"];
    if (config.schemaVersion !== 5 || config.serviceId !== "ordinary-main"
      || config.database !== "/var/lib/dim-ordinary-ci/ordinary-ci.sqlite3"
      || JSON.stringify(Object.keys(config).sort()) !== JSON.stringify(configKeys)
      || marker.schemaVersion !== 1 || marker.stateFormat !== 12
      || marker.database !== "ordinary-ci.sqlite3") process.exit(2);
    const database = new DatabaseSync("/var/lib/dim-ordinary-ci/ordinary-ci.sqlite3", { readOnly: true });
    if (database.prepare("PRAGMA user_version").get()?.user_version !== 12) process.exit(2);
    const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = ? AND name NOT LIKE ? AND name <> ? ORDER BY name")
      .all("table", "sqlite_%", "native_root_ci_service_epochs").map(({ name }) => name);
    const hash = createHash("sha256");
    for (const table of tables) {
      if (typeof table !== "string" || !/^[a-z0-9_]+$/.test(table)) process.exit(2);
      const rows = database.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
      hash.update(JSON.stringify([table, rows]));
    }
    database.close();
    process.stdout.write(`${hash.digest("hex")}\n`);
  ')" || die "ordinary service state inspection failed"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || die "ordinary service state inspection was malformed"
  printf '%s\n' "$digest"
}

require_expected() {
  [[ "$#" -eq 5 && "$4" =~ ^[0-9a-f]{64}$ && "$5" =~ ^[0-9a-f]{64}$ ]] ||
    die "expected immutable container and state identities are required"
}

case "$action" in
  inspect)
    [[ "$#" -eq 3 ]] || die "inspect accepts no expected identities"
    identity="$(inspect_service "$container")"
    jq -e '.running == true' <<<"$identity" >/dev/null || die "owned ordinary service is not running"
    state="$(state_sha256 "$(jq -er '.containerId' <<<"$identity")")"
    jq -cn --argjson identity "$identity" --arg stateSha256 "$state" \
      '{schemaVersion:1,action:"inspected",identity:$identity,stateSha256:$stateSha256,
        contracts:{ordinaryConfigSchema:5,ordinaryStateFormat:12}}'
    ;;
  stopped)
    [[ "$#" -eq 4 && "$4" =~ ^[0-9a-f]{64}$ ]] || die "stopped requires the immutable container ID"
    identity="$(inspect_service "$4")"
    jq -e --arg id "$4" '.containerId == $id and .running == false' <<<"$identity" >/dev/null ||
      die "owned ordinary service is not stopped"
    jq -cn --argjson identity "$identity" '{schemaVersion:1,action:"stopped",identity:$identity}'
    ;;
  stop)
    require_expected "$@"
    identity="$(inspect_service "$container")"
    id="$(jq -er '.containerId' <<<"$identity")"
    [[ "$id" == "$4" ]] || die "ordinary service immutable container ID changed before stop"
    jq -e '.running == true' <<<"$identity" >/dev/null || die "owned ordinary service is not running before stop"
    state="$(state_sha256 "$id")"
    [[ "$state" == "$5" ]] || die "ordinary service state changed before stop"
    docker container stop "$id" >/dev/null || die "failed to stop owned ordinary service"
    stopped="$(inspect_service "$id")"
    jq -e --arg id "$id" '.containerId == $id and .running == false' <<<"$stopped" >/dev/null ||
      die "owned ordinary service did not stop"
    jq -cn --argjson identity "$stopped" --arg stateSha256 "$state" \
      '{schemaVersion:1,action:"stopped",identity:$identity,stateSha256:$stateSha256}'
    ;;
  start)
    require_expected "$@"
    identity="$(inspect_service "$container")"
    id="$(jq -er '.containerId' <<<"$identity")"
    [[ "$id" == "$4" ]] || die "ordinary service immutable container ID changed before restore"
    if jq -e '.running == false' <<<"$identity" >/dev/null; then
      docker container start "$id" >/dev/null || die "failed to restore owned ordinary service"
    fi
    ready=0
    for _ in {1..30}; do
      if docker container exec --user 10002:10002 "$id" /usr/local/bin/dim-service ready >/dev/null 2>&1; then
        ready=1
        break
      fi
      sleep 1
    done
    [[ "$ready" -eq 1 ]] || die "restored ordinary service did not become ready"
    generation="$(jq -er '.generationId' <<<"$identity")"
    docker container exec --user 10002:10002 "$id" /usr/local/bin/dim-service activate "$generation" >/dev/null ||
      die "restored ordinary service activation failed"
    restored="$(inspect_service "$id")"
    jq -e --arg id "$id" '.containerId == $id and .running == true' <<<"$restored" >/dev/null ||
      die "ordinary service identity changed during restore"
    state="$(state_sha256 "$id")"
    [[ "$state" == "$5" ]] || die "ordinary service state changed while stopped"
    jq -cn --argjson identity "$restored" --arg stateSha256 "$state" \
      '{schemaVersion:1,action:"started",identity:$identity,stateSha256:$stateSha256}'
    ;;
  *) die "unknown action '$action'" ;;
esac
