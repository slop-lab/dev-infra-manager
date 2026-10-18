import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nativeQemuDescriptorDigest, type NativeQemuDescriptor } from "../../../../core/packages/managed/src/nativeQemuAssignment.js";
import { verifyAndMaterializeNativeQemuCandidate } from "../../../../core/packages/managed/src/nativeQemuHostCandidateVerifier.js";
import type { NativeCandidateReadAuthority } from "../../../../core/packages/managed/src/nativeOrdinaryCandidateVerifier.js";

const roots: string[] = [];
const config = Buffer.from(`schemaVersion: 4
ordinary:
  jobs: {}
qemu:
  jobs:
    integration:
      script: .dim/ci/jobs/integration.bash
      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]
`);
const script = Buffer.from("set -o pipefail\nprintf 'candidate-executed\\n'\n");

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("native QEMU host candidate verification", () => {
  it("materializes the exact candidate tree and stages the Git script bytes", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-native-qemu-candidate-"));
    roots.push(root);
    const descriptor = candidateDescriptor();

    // When
    await verifyAndMaterializeNativeQemuCandidate({ authority: authority(), descriptor,
      descriptorDigest: nativeQemuDescriptorDigest(descriptor), workspace: join(root, "workspace"),
      scriptFile: join(root, "job", "script"), signal: AbortSignal.timeout(5_000) });

    // Then
    await expect(readFile(join(root, "workspace", "candidate.txt"), "utf8")).resolves.toBe("verified tree\n");
    await expect(readFile(join(root, "job", "script"))).resolves.toEqual(script);
  });

  it("rejects a config blob that does not match the descriptor before materialization", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-native-qemu-candidate-reject-"));
    roots.push(root);
    const descriptor = candidateDescriptor();
    let materialized = false;
    const reader = authority({ async readBlob(input) {
      if (input.path === ".dim/ci/runner.yml") {
        return { objectId: "4".repeat(40), mode: "100644", bytes: Buffer.from("wrong") };
      }
      return { objectId: "5".repeat(40), mode: "100755", bytes: script };
    }, async materializeTree() {
      materialized = true;
      return { commitObjectId: "2".repeat(40), treeObjectId: "3".repeat(40) };
    } });

    // When
    const verification = verifyAndMaterializeNativeQemuCandidate({ authority: reader, descriptor,
      descriptorDigest: nativeQemuDescriptorDigest(descriptor), workspace: join(root, "workspace"),
      scriptFile: join(root, "job", "script"), signal: AbortSignal.timeout(5_000) });

    // Then
    await expect(verification).rejects.toThrow(/config blob does not match/);
    expect(materialized).toBe(false);
  });
});

function candidateDescriptor(): NativeQemuDescriptor {
  return {
    schemaVersion: 1, executionKind: "qemu", admissionGeneration: "generation-1", jobName: "integration",
    runnerBaseImage: `runner@sha256:${"a".repeat(64)}`, bounds: { cpu: "2", memoryBytes: "536870912",
      pids: "128", wallClockSeconds: "30", outputBytes: "1024" }, projectId: "project-a", repositoryId: "root",
    protectedRef: "refs/heads/main", expectedProtectedHead: "1".repeat(40), candidateCommit: "2".repeat(40),
    candidateTree: "3".repeat(40), policyRevision: "policy-1", requiredReviewRevision: "review-1",
    requiredJobSetRevision: "jobs-1", evidenceClass: "candidate-controlled",
    configBlob: { objectId: "4".repeat(40), sha256: digest(config) },
    script: { path: ".dim/ci/jobs/integration.bash", objectId: "5".repeat(40), sha256: digest(script) },
    argv: ["/bin/bash", "--noprofile", "--norc", "/run/dim/job/script"],
    jobImage: `job@sha256:${"b".repeat(64)}`
  };
}

function authority(overrides: Partial<NativeCandidateReadAuthority> = {}): NativeCandidateReadAuthority {
  return {
    async resolveProtectedHead() { return "1".repeat(40); },
    async readCommit() { return { objectId: "2".repeat(40), treeObjectId: "3".repeat(40) }; },
    async readBlob(input) {
      return input.path === ".dim/ci/runner.yml"
        ? { objectId: "4".repeat(40), mode: "100644", bytes: config }
        : { objectId: "5".repeat(40), mode: "100755", bytes: script };
    },
    async materializeTree(input) {
      await mkdir(input.destination);
      await writeFile(join(input.destination, "candidate.txt"), "verified tree\n", { flag: "wx" });
      return { commitObjectId: "2".repeat(40), treeObjectId: "3".repeat(40) };
    },
    ...overrides
  };
}

function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
