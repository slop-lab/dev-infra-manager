import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AuthoritativeRepositoryError } from "../../../../packages/control-plane/plugins/git-repositories/src/authoritative-native-root-target.js";
import { assertAuthoritativeNativeRepositoryTargetCurrent, resolveAuthoritativeNativeRepositoryTarget } from "../../../../packages/control-plane/plugins/git-repositories/src/authoritative-native-root-target.js";
import { nativeRepositoryPolicyRevision } from "@slop-lab/dim-contracts-git";
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
  it("rechecks the resolved default branch when it differs from the imported branch", async () => {
    // Given
    const policyInput = { ...authoritativePolicy(), defaultRef: "refs/heads/development", branches: {
      "refs/heads/main": { review: true }, "refs/heads/development": { review: false }
    } };
    const policy = { ...policyInput, policyRevision: nativeRepositoryPolicyRevision(policyInput) };
    const fixture = await finalizedCandidateRoot("default-target-current", matchingRunner(), policy);
    const selector = { projectId: "project-a", repositoryId: "root" };
    const before = await proofBytes(fixture.root);
    try {
      // When
      const target = await resolveAuthoritativeNativeRepositoryTarget(fixture.context, selector);

      // Then
      expect(target.imported.protectedRef).toBe("refs/heads/main");
      expect(target.currentHead.protectedRef).toBe("refs/heads/development");
      await expect(assertAuthoritativeNativeRepositoryTargetCurrent({ runtime: fixture.context, selector, target }))
        .resolves.toBeUndefined();
      await expect(assertAuthoritativeNativeRepositoryTargetCurrent({ runtime: fixture.context,
        selector: { ...selector, protectedRef: "refs/heads/main" }, target }))
        .rejects.toBeInstanceOf(AuthoritativeRepositoryError);
      expect(await proofBytes(fixture.root)).toEqual(before);
    } finally { await fixture.close(); }
  });

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

  it("accepts ordinary refs and upstream tracking while retaining protected-head and reserved-ref checks", async () => {
    const fixture = await finalizedCandidateRoot("tracking-namespace", matchingRunner(), authoritativePolicy());
    try {
      const read = () => resolveAuthoritativeNativeRepositoryTarget(fixture.context, { projectId: "project-a", repositoryId: "root" });
      for (const ref of ["refs/remotes/upstream/development", "refs/remotes/upstream/feature/nested", "refs/tags/release", "refs/heads/feature/change"]) {
        await runGit("/usr/bin/git", ["--git-dir", fixture.repository, "update-ref", ref, fixture.bundle.commit]);
        expect((await read()).currentHead.commit).toBe(fixture.bundle.commit);
        await runGit("/usr/bin/git", ["--git-dir", fixture.repository, "update-ref", "-d", ref]);
      }
      for (const ref of ["refs/remotes/origin/development", "refs/dim/unowned", "refs/heads/development"]) {
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
