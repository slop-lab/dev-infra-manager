import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AuthoritativeRepositoryError } from "../../../../packages/control-plane/plugins/git-repositories/src/authoritative-native-root-target.js";
import { resolveAuthoritativeNativeRepositoryTarget } from "../../../../packages/control-plane/plugins/git-repositories/src/authoritative-native-root-target.js";
import {
  authoritativePolicy,
  candidateContext,
  finalizedCandidateRoot,
  matchingRunner,
  proofBytes
} from "./authoritativeNativeCandidateFixture.js";
import { cleanupFinalizeFixtures, rootRepository, runGit } from "./nativeRootImportFinalizeFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("authoritative imported-root target", () => {
  it("resolves only the live owned repository and complete kind-bound policy without changing proof", async () => {
    // Given
    const fixture = await finalizedCandidateRoot("target", matchingRunner(), authoritativePolicy());
    const before = await proofBytes(fixture.root);

    // When
    const target = await resolveAuthoritativeNativeRepositoryTarget(fixture.context, { projectId: "project-a", repositoryId: "root" });

    // Then
    expect(target.repository).toBe(rootRepository(fixture.root));
    expect(target.currentHead).toMatchObject({ sequence: 0, commit: fixture.bundle.commit,
      tree: fixture.bundle.tree, protectedRef: "refs/heads/main" });
    expect(target.imported).toMatchObject({ serviceId: "native-main", projectId: "project-a",
      repositoryId: "root", protectedRef: "refs/heads/main",
      expectedCommit: fixture.bundle.commit, resolvedTree: fixture.bundle.tree,
      policy: authoritativePolicy() });
    expect(target.imported.policy.extensions["git-ci"]).toMatchObject({ requiredJobs: [
      { name: "integration", kind: "qemu" }, { name: "source", kind: "ordinary-sysbox" }
    ] });
    expect(await proofBytes(fixture.root)).toEqual(before);
    await fixture.close();
  });

  it.each([
    { projectId: "project-a", ownerHostId: "host-a" },
    { projectId: "missing" },
    { projectId: "../project-a" }
  ])("denies non-exact or foreign selector %j", async (selector) => {
    // Given
    const fixture = await finalizedCandidateRoot("invalid-selector", matchingRunner(), authoritativePolicy());
    const before = await proofBytes(fixture.root);

    // When
    const read = resolveAuthoritativeNativeRepositoryTarget(fixture.context, selector);

    // Then
    await expect(read).rejects.toBeInstanceOf(AuthoritativeRepositoryError);
    expect(await proofBytes(fixture.root)).toEqual(before);
    await fixture.close();
  });

  it("accepts only the upstream tracking namespace while retaining protected-head and foreign-ref checks", async () => {
    const fixture = await finalizedCandidateRoot("tracking-namespace", matchingRunner(), authoritativePolicy());
    try {
      const read = () => resolveAuthoritativeNativeRepositoryTarget(fixture.context, { projectId: "project-a", repositoryId: "root" });
      for (const ref of ["refs/remotes/upstream/development", "refs/remotes/upstream/feature/nested"]) {
        await runGit("/usr/bin/git", ["--git-dir", fixture.repository, "update-ref", ref, fixture.bundle.commit]);
        expect((await read()).currentHead.commit).toBe(fixture.bundle.commit);
        await runGit("/usr/bin/git", ["--git-dir", fixture.repository, "update-ref", "-d", ref]);
      }
      for (const ref of ["refs/remotes/origin/development", "refs/tags/release", "refs/heads/development"]) {
        await runGit("/usr/bin/git", ["--git-dir", fixture.repository, "update-ref", ref, fixture.bundle.commit]);
        await expect(read()).rejects.toBeInstanceOf(AuthoritativeRepositoryError);
        await runGit("/usr/bin/git", ["--git-dir", fixture.repository, "update-ref", "-d", ref]);
      }
      expect((await read()).currentHead.commit).toBe(fixture.bundle.commit);
    } finally { await fixture.close(); }
  });

  it("refuses a released owner before returning a target", async () => {
    // Given
    const fixture = await finalizedCandidateRoot("target-released", matchingRunner(), authoritativePolicy());
    await fixture.close();

    // When
    const read = resolveAuthoritativeNativeRepositoryTarget(fixture.context, { projectId: "project-a", repositoryId: "root" });

    // Then
    await expect(read).rejects.toBeInstanceOf(AuthoritativeRepositoryError);
  });

  it("does not treat a completed legacy import as kind-bound authority", async () => {
    // Given
    const fixture = await finalizedCandidateRoot("target-legacy", matchingRunner(), authoritativePolicy());
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
    // When / Then
    await expect(candidateContext(fixture.root)).rejects.toThrow(/policy/);
    expect(await proofBytes(fixture.root)).toEqual(before);
  });
});
