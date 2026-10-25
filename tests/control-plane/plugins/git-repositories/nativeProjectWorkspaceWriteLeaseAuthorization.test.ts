import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  basicAuthorization,
  expectWorkspaceWriteCloneRejected,
  finalizedWorkspaceWriteFixture,
  issueWorkspaceWriteLease,
  workspaceId
} from "./nativeProjectWorkspaceWriteLeaseFixture.js";
import {
  cleanupFinalizeFixtures,
  closeFinalizeService,
  generationId,
  rootReadIssuerAuthorization,
  startFinalizeService,
  workspaceWriteIssuer,
  workspaceWriteIssuerAuthorization
} from "./nativeRootImportFinalizeFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("native Project workspace write lease authorization", () => {
  it("invalidates workspace write leases on expiry and restart", async () => {
    // Given
    let now = 1_000;
    const fixture = await finalizedWorkspaceWriteFixture("workspace-write-lifecycle", () => now);
    const expiredLease = await issueWorkspaceWriteLease(fixture.service.origin);
    now = expiredLease.expiresAt;

    // When / Then
    await expectWorkspaceWriteCloneRejected(fixture.service.origin, expiredLease, "workspace-write-expired");
    now = 1_000;
    const restartedLease = await issueWorkspaceWriteLease(fixture.service.origin);
    await closeFinalizeService(fixture.service);
    const restarted = await startFinalizeService(fixture.root, undefined, undefined, () => now);
    await expectWorkspaceWriteCloneRejected(restarted.origin, restartedLease, "workspace-write-restarted");
  });

  it("rejects an issued lease that expires while write verification is blocked", async () => {
    // Given
    let now = 1_000;
    let block = false;
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const fixture = await finalizedWorkspaceWriteFixture("workspace-write-expiry-race", () => now, {
      async beforeVerification() {
        if (!block) return;
        entered?.();
        await blocked;
      }
    });
    const lease = await issueWorkspaceWriteLease(fixture.service.origin);
    block = true;
    const discovery = fetch(`${fixture.service.origin}/v1/projects/project-a/repositories/root.git/info/refs?service=git-receive-pack`, {
      headers: { authorization: basicAuthorization(lease.username, lease.password) }
    });
    await started;

    // When
    now = lease.expiresAt;
    release?.();
    const response = await discovery;

    // Then
    expect(response.status).toBe(401);
  });

  it("does not issue workspace write authority for a completed legacy policy", async () => {
    // Given
    const fixture = await finalizedWorkspaceWriteFixture("workspace-write-legacy");
    await closeFinalizeService(fixture.service);
    const legacyPolicy = {
      protectedRef: "refs/heads/main", policyRevision: "policy-1", requiredReviewRevision: "reviews-1",
      requiredJobSetRevision: "jobs-1", requiredJobNames: ["source"],
      requiredReviewerIds: ["owner"], pathReviewerRules: []
    } as const;
    const policyJson = JSON.stringify(legacyPolicy);
    const database = new DatabaseSync(join(fixture.root, "native-idle.sqlite3"));
    database.prepare("UPDATE native_project_root_import SET policy_json = ?, policy_sha256 = ?")
      .run(policyJson, createHash("sha256").update(policyJson).digest("hex"));
    database.close();
    // When / Then
    await expect(startFinalizeService(fixture.root)).rejects.toThrow(/policy/);
  });

  it("requires the exact route, issuer role, root repository, generation, and workspace ID", async () => {
    // Given
    const fixture = await finalizedWorkspaceWriteFixture("workspace-write-boundary");
    const endpoint = `${fixture.service.origin}/v1/projects/project-a/repositories/root/workspace-write-leases`;
    const validBody = { schemaVersion: 1, generationId, repositoryId: "root", workspaceId };
    const hostAlias = basicAuthorization(workspaceWriteIssuer.hostId, workspaceWriteIssuer.password);

    // When
    const wrongRole = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: rootReadIssuerAuthorization, "content-type": "application/json" },
      body: JSON.stringify(validBody)
    });
    const alias = await fetch(endpoint, {
      method: "POST", headers: { authorization: hostAlias, "content-type": "application/json" },
      body: JSON.stringify(validBody)
    });
    const identity = await fetch(`${fixture.service.origin}/v1/operator-workspace-write-issuer-identity`, {
      headers: { authorization: workspaceWriteIssuerAuthorization }
    });
    const aliasIdentity = await fetch(`${fixture.service.origin}/v1/operator-workspace-write-issuer-identity`, {
      headers: { authorization: hostAlias }
    });
    const queryBearing = await fetch(`${endpoint}?scope=root`, {
      method: "POST",
      headers: { authorization: workspaceWriteIssuerAuthorization, "content-type": "application/json" },
      body: JSON.stringify(validBody)
    });
    const malformed = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: workspaceWriteIssuerAuthorization, "content-type": "application/json" },
      body: JSON.stringify({ ...validBody, workspaceId: "short" })
    });

    // Then
    expect(wrongRole.status).toBe(403);
    expect(alias.status).toBe(401);
    expect(aliasIdentity.status).toBe(401);
    expect(identity.status).toBe(200);
    expect(await identity.json()).toMatchObject({ hostId: workspaceWriteIssuer.hostId });
    expect(queryBearing.status).toBe(404);
    expect(malformed.status).toBe(400);
  });

  it("grants no Project-ready, reviewer, or CI authority", async () => {
    // Given
    const fixture = await finalizedWorkspaceWriteFixture("workspace-write-no-elevation");
    const lease = await issueWorkspaceWriteLease(fixture.service.origin);
    const headers = { authorization: basicAuthorization(lease.username, lease.password) };

    // When
    const responses = await Promise.all([
      fetch(`${fixture.service.origin}/v1/projects/project-a/ready`, { headers }),
      fetch(`${fixture.service.origin}/v1/projects/project-a/repositories/root/reviews`, { headers }),
      fetch(`${fixture.service.origin}/v1/projects/project-a/repositories/root/job-attempts`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}"
      })
    ]);

    // Then
    expect(responses.map((response) => response.status)).toEqual([404, 401, 404]);
  });
});
