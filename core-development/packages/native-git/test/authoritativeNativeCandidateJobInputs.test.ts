import { createHash } from "node:crypto";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  CandidateExecutionError,
  candidateArgv,
  loadAuthoritativeNativeCandidateJobInputs
} from "../../../../core/packages/native-git/src/index.js";
import {
  authoritativePolicy,
  candidateContext,
  digest,
  finalizedCandidateRoot,
  matchingRunner,
  objectId,
  proofBytes,
  wrongKindRunner
} from "./authoritativeNativeCandidateFixture.js";
import {
  activateFinalizeServiceForGeneration,
  activationTokenB,
  cleanupFinalizeFixtures,
  closeFinalizeService,
  generationB,
  rootRepository,
  runGit,
  startFinalizeServiceForGeneration
} from "./nativeRootImportFinalizeFixture.js";
import { descendantCommit, seedRootPromotion } from "./nativeCurrentRootProofFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("authoritative imported-root candidate job inputs", () => {
  it("returns only kind-bound blob identities and fixed argv without mutating proof state", async () => {
    // Given
    const fixture = await finalizedCandidateRoot("matching", matchingRunner(), authoritativePolicy());
    const before = await proofBytes(fixture.root);

    // When
    const result = await loadAuthoritativeNativeCandidateJobInputs(fixture.context, fixture.selector);

    // Then
    expect(result).toEqual({
      configBlob: {
        objectId: await objectId(fixture, ".dim/ci/runner.yml"),
        sha256: digest(matchingRunner())
      },
      plan: [
        {
          name: "source", kind: "ordinary-sysbox",
          script: {
            path: ".dim/ci/jobs/source.bash",
            objectId: await objectId(fixture, ".dim/ci/jobs/source.bash"),
            sha256: digest("set -euo pipefail\nprintf 'source\\n'\n")
          },
          argv: candidateArgv
        },
        {
          name: "integration", kind: "qemu",
          script: {
            path: ".dim/ci/jobs/integration.bash",
            objectId: await objectId(fixture, ".dim/ci/jobs/integration.bash"),
            sha256: digest("set -euo pipefail\nprintf 'integration\\n'\n")
          },
          argv: candidateArgv
        }
      ]
    });
    expect(JSON.stringify(result)).not.toMatch(/image|bound|host|capacity|credential|bytes/);
    expect(await proofBytes(fixture.root)).toEqual(before);
    await fixture.close();
  });

  it("rejects a candidate that moves a policy-bound QEMU job to ordinary", async () => {
    // Given
    const fixture = await finalizedCandidateRoot("wrong-kind", wrongKindRunner(), authoritativePolicy());

    // When
    const read = loadAuthoritativeNativeCandidateJobInputs(fixture.context, fixture.selector);

    // Then
    await expect(read).rejects.toBeInstanceOf(CandidateExecutionError);
    await fixture.close();
  });

  it("rejects a candidate read after the imported-root storage owner releases", async () => {
    // Given
    const fixture = await finalizedCandidateRoot("released-owner", matchingRunner(), authoritativePolicy());
    await fixture.close();

    // When
    const read = loadAuthoritativeNativeCandidateJobInputs(fixture.context, fixture.selector);

    // Then
    await expect(read).rejects.toBeInstanceOf(CandidateExecutionError);
  });

  it("rejects a runtime mixing an owned root with a different state directory", async () => {
    // Given
    const fixture = await finalizedCandidateRoot("mixed-owner", matchingRunner(), authoritativePolicy());
    const foreign = await finalizedCandidateRoot("foreign-owner", matchingRunner(), authoritativePolicy());
    const mixedRuntime = { ...fixture.context, stateDirectory: foreign.root };

    // When
    const read = loadAuthoritativeNativeCandidateJobInputs(mixedRuntime, fixture.selector);

    // Then
    await expect(read).rejects.toBeInstanceOf(CandidateExecutionError);
    await fixture.close();
    await foreign.close();
  });

  it("refuses a completed legacy import without changing its proof data", async () => {
    // Given
    const fixture = await finalizedCandidateRoot("legacy", matchingRunner(), authoritativePolicy());
    await fixture.close();
    const legacyPolicy = {
      protectedRef: "refs/heads/main", policyRevision: "policy-1", requiredReviewRevision: "reviews-1",
      requiredJobSetRevision: "jobs-1", requiredJobNames: ["integration", "source"],
      requiredReviewerIds: ["owner"], pathReviewerRules: []
    } as const;
    const policyJson = JSON.stringify(legacyPolicy);
    const database = new DatabaseSync(join(fixture.root, "native-idle.sqlite3"));
    database.prepare("UPDATE native_project_root_import SET policy_json = ?, policy_sha256 = ?")
      .run(policyJson, createHash("sha256").update(policyJson).digest("hex"));
    database.close();
    const before = await proofBytes(fixture.root);
    const reopened = await candidateContext(fixture.root);

    // When
    const read = loadAuthoritativeNativeCandidateJobInputs(reopened.context, fixture.selector);

    // Then
    await expect(read).rejects.toBeInstanceOf(CandidateExecutionError);
    expect(await proofBytes(fixture.root)).toEqual(before);
    await reopened.close();
  });

  it("reads an unchanged generation-A import under exact generation-B activation", async () => {
    // Given
    const fixture = await finalizedCandidateRoot("rollover", matchingRunner(), authoritativePolicy());
    await fixture.close();
    const servingB = await startFinalizeServiceForGeneration(fixture.root, generationB, activationTokenB);
    await activateFinalizeServiceForGeneration(servingB.origin, generationB, activationTokenB);
    await closeFinalizeService(servingB);
    const reopened = await candidateContext(fixture.root, generationB, activationTokenB);

    // When
    const result = await loadAuthoritativeNativeCandidateJobInputs(reopened.context, fixture.selector);

    // Then
    expect(result.plan.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "source", kind: "ordinary-sysbox" },
      { name: "integration", kind: "qemu" }
    ]);
    await reopened.close();
  });

  it("denies candidate reads from a finalized head without independently verified evidence", async () => {
    // Given
    const fixture = await finalizedCandidateRoot("promoted-head", matchingRunner(), authoritativePolicy());
    const promoted = await descendantCommit(fixture.root, fixture.bundle.tree, fixture.bundle.commit);
    await seedRootPromotion({ root: fixture.root, candidateCommit: promoted,
      candidateTree: fixture.bundle.tree });
    const candidate = await descendantCommit(fixture.root, fixture.bundle.tree, promoted);

    // When
    const read = loadAuthoritativeNativeCandidateJobInputs(fixture.context, {
      projectId: "project-a", candidateCommit: candidate, candidateTree: fixture.bundle.tree
    });

    // Then
    await expect(read).rejects.toBeInstanceOf(CandidateExecutionError);
    await fixture.close();
  });

  it.each(["inactive", "owner drift", "ref drift", "graph drift"] as const)(
    "denies %s before returning candidate identities",
    async (failure) => {
      // Given
      const fixture = await finalizedCandidateRoot(`deny-${failure.replace(" ", "-")}`,
        matchingRunner(), authoritativePolicy());
      if (failure === "inactive") {
        fixture.context.activated = () => false;
      } else if (failure === "owner drift") {
        const database = new DatabaseSync(join(fixture.root, "native-idle.sqlite3"));
        database.prepare("UPDATE native_project_registration SET owner_host_id = 'host-b'").run();
        database.close();
      } else if (failure === "ref drift") {
        const moved = (await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.root),
          "-c", "user.name=DIM Test", "-c", "user.email=dim@example.invalid",
          "commit-tree", fixture.selector.candidateTree, "-m", "moved"])).stdout.trim();
        await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.root), "update-ref",
          "refs/heads/main", moved, fixture.selector.candidateCommit]);
      } else {
        const packDirectory = join(rootRepository(fixture.root), "objects", "pack");
        const pack = (await readdir(packDirectory)).find((name) => name.endsWith(".pack"));
        if (pack === undefined) throw new Error("imported root has no pack fixture");
        await writeFile(join(packDirectory, pack), "corrupt graph", { mode: 0o444 });
      }

      // When
      const read = loadAuthoritativeNativeCandidateJobInputs(fixture.context, fixture.selector);

      // Then
      await expect(read).rejects.toBeInstanceOf(CandidateExecutionError);
      await fixture.close();
    }
  );
});
