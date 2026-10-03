#!/usr/bin/env bash

dim_registry_evidence_result_count() {
  local evidence_file="$1" repository="$2" result="$3"
  node -e '
    const fs = require("node:fs");
    const [file, repository, result] = process.argv.slice(1);
    const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
    const count = lines.map((line) => JSON.parse(line)).filter((record) =>
      record.event_kind === "upstream-request"
      && record.repository === repository
      && record.result === result
    ).length;
    process.stdout.write(`${count}\n`);
  ' "$evidence_file" "$repository" "$result"
}

dim_registry_request_count() {
  local evidence_file="$1"
  node -e '
    const fs = require("node:fs");
    const lines = fs.existsSync(process.argv[1])
      ? fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean)
      : [];
    const count = lines.map((line) => JSON.parse(line))
      .filter((record) => record.event_kind === "upstream-request").length;
    process.stdout.write(`${count}\n`);
  ' "$evidence_file"
}

dim_registry_fixture_field() {
  local readiness_file="$1" field="$2"
  node -e '
    const fs = require("node:fs");
    const [file, field] = process.argv.slice(1);
    const value = JSON.parse(fs.readFileSync(file, "utf8"))[field];
    if (typeof value !== "string" && typeof value !== "number") process.exit(1);
    process.stdout.write(`${value}\n`);
  ' "$readiness_file" "$field"
}

dim_registry_cache_image() {
  local source_file="$1"
  node -e '
    const fs = require("node:fs");
    const source = fs.readFileSync(process.argv[1], "utf8");
    const match = source.match(/dockerImage:\s*"(registry@sha256:[a-f0-9]{64})"/);
    if (!match) process.exit(1);
    process.stdout.write(`${match[1]}\n`);
  ' "$source_file"
}

dim_registry_fixture_address() {
  node -e '
    const { networkInterfaces } = require("node:os");
    const address = Object.values(networkInterfaces()).flatMap((values) => values ?? [])
      .find((entry) => entry.family === "IPv4" && !entry.internal)?.address;
    if (!address) process.exit(1);
    process.stdout.write(`${address}\n`);
  '
}

dim_registry_cache_ingress_count() {
  local log_file="$1" repository="$2"
  node -e '
    const fs = require("node:fs");
    const [file, repository] = process.argv.slice(1);
    const encoded = `/v2/${repository}/`;
    const count = fs.readFileSync(file, "utf8").split("\n").filter((line) =>
      line.includes(encoded) && line.includes("http.request")
    ).length;
    process.stdout.write(`${count}\n`);
  ' "$log_file" "$repository"
}

dim_registry_cache_request_evidence() {
  local log_file="$1" repository="$2"
  node -e '
    const fs = require("node:fs");
    const [file, repository] = process.argv.slice(1);
    const encoded = `/v2/${repository}/`;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (line.includes(encoded) && line.includes("http.request")) process.stdout.write(`${line}\n`);
    }
  ' "$log_file" "$repository"
}

dim_registry_artifact_count() {
  local evidence_file="$1" repository="$2"
  local manifests blobs
  manifests="$(dim_registry_evidence_result_count "$evidence_file" "$repository" manifest)"
  blobs="$(dim_registry_evidence_result_count "$evidence_file" "$repository" blob)"
  printf '%s\n' "$((manifests + blobs))"
}

dim_registry_refuse_managed_collisions() {
  local resource
  for resource in dim-registry-cache dim-control dim-registry-cache-data; do
    if docker container inspect "$resource" >/dev/null 2>&1 \
      || docker network inspect "$resource" >/dev/null 2>&1 \
      || docker volume inspect "$resource" >/dev/null 2>&1; then
      echo "Docker resource '$resource' already exists; refusing disposable cache-routing verification" >&2
      return 2
    fi
  done
}

dim_registry_assert_loopback_fallback() {
  local evidence_file="$1"
  grep -Eq '(registry-1\.docker\.io|auth\.docker\.io)' "$evidence_file" \
    && grep -Eq '(^|[^0-9])127\.0\.0\.1([^0-9]|$)' "$evidence_file" || {
    echo "outage evidence did not identify a Docker Hub endpoint contained at loopback: $evidence_file" >&2
    return 1
  }
}
