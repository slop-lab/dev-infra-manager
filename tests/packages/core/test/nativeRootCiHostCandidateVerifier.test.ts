import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyAndMaterializeNativeRootCiCandidate } from "../../../../core/packages/managed/src/nativeRootCiHostCandidateVerifier.js";
import { authority, execution } from "./nativeOrdinaryExecutorFixture.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("native root CI host candidate verification", () => {
  it("accepts an ordinary-only schema-4 config with an empty QEMU section", async () => {
    // Given
    const config = Buffer.from(`schemaVersion: 4
ordinary:
  jobs:
    source:
      script: .dim/ci/jobs/source.bash
      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]
qemu:
  jobs: {}
`);
    const selected = execution(config).claim;
    const root = await mkdtemp(join(tmpdir(), "dim-native-root-candidate-"));
    roots.push(root);

    // When
    await verifyAndMaterializeNativeRootCiCandidate({ authority: authority({}, config),
      descriptor: selected.descriptor, descriptorDigest: selected.descriptorDigest,
      workspace: join(root, "workspace"), scriptFile: join(root, "script"), signal: AbortSignal.timeout(5_000) });

    // Then
    expect(selected.descriptor.jobName).toBe("source");
  });

  it("rejects a schema-4 script path outside the authoritative flat job directory", async () => {
    // Given
    const config = Buffer.from(`schemaVersion: 4
ordinary:
  jobs:
    source:
      script: .dim/ci/jobs/nested/source.bash
      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]
qemu:
  jobs: {}
`);
    const selected = execution(config).claim;
    const root = await mkdtemp(join(tmpdir(), "dim-native-root-candidate-invalid-"));
    roots.push(root);

    // When
    const verification = verifyAndMaterializeNativeRootCiCandidate({ authority: authority({}, config),
      descriptor: selected.descriptor, descriptorDigest: selected.descriptorDigest,
      workspace: join(root, "workspace"), scriptFile: join(root, "script"), signal: AbortSignal.timeout(5_000) });

    // Then
    await expect(verification).rejects.toThrow(/ordinary job is invalid/);
  });
});
