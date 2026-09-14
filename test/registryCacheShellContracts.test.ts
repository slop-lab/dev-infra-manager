import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTemporaryRootTracker } from "./registryCacheRouting.fixture.js";

const verificationRoot = resolve(import.meta.dirname, "..");
const routingLibrary = resolve(verificationRoot, "scripts/lib/registry-cache-routing.bash");
const journeyLibrary = resolve(verificationRoot, "scripts/lib/registry-cache-routing-journey.bash");
const temporaryRoots = createTemporaryRootTracker();

afterEach(async () => {
  await temporaryRoots.cleanup();
});

describe("registry cache routing shell contracts", () => {
  it("counts only successful upstream artifact evidence for one repository", async () => {
    // Given
    const root = await temporaryRoots.create();
    const evidenceFile = resolve(root, "evidence.jsonl");
    await writeFile(evidenceFile, [
      { event_kind: "upstream-request", repository: "wanted/repo", result: "manifest" },
      { event_kind: "upstream-request", repository: "wanted/repo", result: "blob" },
      { event_kind: "upstream-request", repository: "wanted/repo", result: "manifest-unknown" },
      { event_kind: "upstream-request", repository: "other/repo", result: "manifest" },
      { event_kind: "other", repository: "wanted/repo", result: "blob" }
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");

    // When
    const manifest = spawnSync("bash", ["-c", `source "$1"; dim_registry_evidence_result_count "$2" "$3" manifest`, "bash", routingLibrary, evidenceFile, "wanted/repo"], { encoding: "utf8" });
    const blob = spawnSync("bash", ["-c", `source "$1"; dim_registry_evidence_result_count "$2" "$3" blob`, "bash", routingLibrary, evidenceFile, "wanted/repo"], { encoding: "utf8" });

    // Then
    expect(manifest.status).toBe(0);
    expect(manifest.stdout.trim()).toBe("1");
    expect(blob.status).toBe(0);
    expect(blob.stdout.trim()).toBe("1");
  });

  it("counts every upstream request so outage evidence cannot hide non-artifact access", async () => {
    const root = await temporaryRoots.create();
    const evidenceFile = resolve(root, "outage.jsonl");
    await writeFile(evidenceFile, [
      { event_kind: "upstream-request", result: "api-version" },
      { event_kind: "upstream-request", repository: "outage/repo", result: "manifest-unknown" },
      { event_kind: "other", result: "ignored" }
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");

    const result = spawnSync("bash", [
      "-c", 'source "$1"; dim_registry_request_count "$2"',
      "bash", routingLibrary, evidenceFile
    ], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("2");
  });

  it("requires route-local ingress and exact cold and warm upstream deltas", () => {
    const assertDeltas = (values: readonly string[]) => spawnSync("bash", [
      "-c", 'source "$1"; shift; dim_cache_routing_assert_phase_deltas "$@"',
      "bash", journeyLibrary, ...values
    ], { encoding: "utf8" });

    const cold = assertDeltas(["workspace", "cold", "10", "15", "7", "10"]);
    const warm = assertDeltas(["workspace", "warm", "15", "16", "10", "10"]);
    const sharedCacheFalsePositive = assertDeltas(["agent-dind", "cold", "15", "20", "10", "10"]);
    const missingWarmIngress = assertDeltas(["workspace", "warm", "15", "15", "10", "10"]);

    expect(cold.status).toBe(0);
    expect(warm.status).toBe(0);
    expect(sharedCacheFalsePositive.status).not.toBe(0);
    expect(missingWarmIngress.status).not.toBe(0);
  });

  it("accepts only outage evidence naming a Docker Hub endpoint contained at loopback", async () => {
    // Given
    const root = await temporaryRoots.create();
    const validEvidence = resolve(root, "valid.log");
    const remoteEvidence = resolve(root, "remote.log");
    const anonymousLoopback = resolve(root, "anonymous-loopback.log");
    await writeFile(validEvidence, 'Head "https://registry-1.docker.io/v2/example/manifests/latest": dial tcp 127.0.0.1:443: connect: connection refused\n');
    await writeFile(remoteEvidence, 'Get "https://auth.docker.io/token": dial tcp 34.194.164.123:443: connect: connection refused\n');
    await writeFile(anonymousLoopback, "dial tcp 127.0.0.1:443: connect: connection refused\n");

    // When
    const assertEvidence = (path: string) => spawnSync("bash", [
      "-c", 'source "$1"; dim_registry_assert_loopback_fallback "$2"',
      "bash", routingLibrary, path
    ], { encoding: "utf8" });
    const valid = assertEvidence(validEvidence);
    const remote = assertEvidence(remoteEvidence);
    const anonymous = assertEvidence(anonymousLoopback);

    // Then
    expect(valid.status).toBe(0);
    expect(remote.status).not.toBe(0);
    expect(anonymous.status).not.toBe(0);
  });
});
