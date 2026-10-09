import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { isExitError } from "./nativeGitHarness.js";
import {
  activateFinalizeService,
  cleanupFinalizeFixtures,
  closeFinalizeService,
  createFinalizeRoot,
  createRootBundle,
  finalizeRootImport,
  generationId,
  importer,
  parseImportReceipt,
  projectInput,
  rootReadIssuerAuthorization,
  rootRepository,
  runGit,
  startFinalizeService,
  uploadRootBundle,
  workspaceWriteIssuerAuthorization,
  type WorkspaceWriteLeaseHooks,
  type RunningService
} from "./nativeRootImportFinalizeFixture.js";

const workspaceId = Buffer.alloc(32, 60).toString("base64url");

afterEach(cleanupFinalizeFixtures);

describe("native Project workspace write lease", () => {
  it("pushes only its own proposal through real Git smart HTTP", async () => {
    // Given
    const fixture = await finalizedFixture("workspace-write-happy");
    const lease = await issueLease(fixture.service.origin);
    const clone = await writerClone(fixture.service.origin, lease, "workspace-write-clone");
    await commit(clone, "proposal.txt", "candidate\n");

    // When
    await runGit("/usr/bin/git", ["-C", clone, "push", "origin",
      `HEAD:refs/heads/proposals/${workspaceId}/change-1`]);

    // Then
    const proposal = await refValue(fixture.root, `refs/heads/proposals/${workspaceId}/change-1`);
    expect(proposal).toMatch(/^[0-9a-f]{40}$/);
  });

  it("denies protected, tag, foreign-workspace, deletion, and non-fast-forward force writes", async () => {
    // Given
    const fixture = await finalizedFixture("workspace-write-denials");
    const lease = await issueLease(fixture.service.origin);
    const clone = await writerClone(fixture.service.origin, lease, "workspace-write-denial-clone");
    const proposalRef = `refs/heads/proposals/${workspaceId}/change-1`;
    const foreignWorkspaceId = Buffer.alloc(32, 61).toString("base64url");
    const protectedBefore = await refValue(fixture.root, "refs/heads/main");
    await commit(clone, "proposal.txt", "candidate\n");
    await runGit("/usr/bin/git", ["-C", clone, "push", "origin", `HEAD:${proposalRef}`]);
    const proposalBefore = await refValue(fixture.root, proposalRef);

    // When / Then
    await expectRejectedPush(clone, ["HEAD:refs/heads/main"]);
    await expectRejectedPush(clone, ["HEAD:refs/tags/unreviewed"]);
    await expectRejectedPush(clone, [`HEAD:refs/heads/proposals/${foreignWorkspaceId}/stolen`]);
    await expectRejectedPush(clone, [`:${proposalRef}`]);
    await runGit("/usr/bin/git", ["-C", clone, "checkout", "--orphan", "rewritten-proposal"]);
    await runGit("/usr/bin/git", ["-C", clone, "rm", "-rf", "."]);
    await commit(clone, "replacement.txt", "replacement\n");
    await expectRejectedPush(clone, ["--force", `HEAD:${proposalRef}`]);
    expect(await refValue(fixture.root, "refs/heads/main")).toBe(protectedBefore);
    expect(await refValue(fixture.root, proposalRef)).toBe(proposalBefore);
    expect(await refValue(fixture.root, "refs/tags/unreviewed")).toBeUndefined();
    expect(await refValue(fixture.root, `refs/heads/proposals/${foreignWorkspaceId}/stolen`)).toBeUndefined();
  });

  it("invalidates workspace write leases on expiry and restart", async () => {
    // Given
    let now = 1_000;
    const fixture = await finalizedFixture("workspace-write-lifecycle", () => now);
    const expiredLease = await issueLease(fixture.service.origin);
    now = expiredLease.expiresAt;

    // When / Then
    await expectCloneRejected(fixture.service.origin, expiredLease, "workspace-write-expired");
    now = 1_000;
    const restartedLease = await issueLease(fixture.service.origin);
    await closeFinalizeService(fixture.service);
    const restarted = await startFinalizeService(fixture.root, undefined, undefined, () => now);
    await expectCloneRejected(restarted.origin, restartedLease, "workspace-write-restarted");
  });

  it("rejects an issued lease that expires while write verification is blocked", async () => {
    // Given
    let now = 1_000;
    let block = false;
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const fixture = await finalizedFixture("workspace-write-expiry-race", () => now, {
      async beforeVerification() {
        if (!block) return;
        entered?.();
        await blocked;
      }
    });
    const lease = await issueLease(fixture.service.origin);
    block = true;
    const discovery = fetch(`${fixture.service.origin}/v1/projects/project-a/repositories/root.git/info/refs?service=git-receive-pack`, {
      headers: { authorization: basic(lease.username, lease.password) }
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
    const fixture = await finalizedFixture("workspace-write-legacy");
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
    const restarted = await startFinalizeService(fixture.root);

    // When
    const response = await fetch(`${restarted.origin}/v1/projects/project-a/workspace-write-leases`, {
      method: "POST",
      headers: { authorization: workspaceWriteIssuerAuthorization, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, generationId, repositoryId: "root", workspaceId })
    });

    // Then
    expect(response.status).toBe(409);
  });

  it("requires the exact route, issuer role, root repository, generation, and workspace ID", async () => {
    // Given
    const fixture = await finalizedFixture("workspace-write-boundary");
    const endpoint = `${fixture.service.origin}/v1/projects/project-a/workspace-write-leases`;
    const validBody = { schemaVersion: 1, generationId, repositoryId: "root", workspaceId };

    // When
    const wrongRole = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: rootReadIssuerAuthorization, "content-type": "application/json" },
      body: JSON.stringify(validBody)
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
    expect(queryBearing.status).toBe(404);
    expect(malformed.status).toBe(400);
  });

  it("grants no Project-ready, reviewer, or CI authority", async () => {
    // Given
    const fixture = await finalizedFixture("workspace-write-no-elevation");
    const lease = await issueLease(fixture.service.origin);
    const headers = { authorization: basic(lease.username, lease.password) };

    // When
    const responses = await Promise.all([
      fetch(`${fixture.service.origin}/v1/projects/project-a/ready`, { headers }),
      fetch(`${fixture.service.origin}/v1/projects/project-a/repositories/root/reviews`, { headers }),
      fetch(`${fixture.service.origin}/v1/projects/project-a/repositories/root/job-attempts`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}"
      })
    ]);

    // Then
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404]);
  });
});

async function finalizedFixture(
  label: string,
  workspaceWriteClock?: () => number,
  workspaceWriteHooks?: WorkspaceWriteLeaseHooks
): Promise<{ readonly root: string; readonly service: RunningService }> {
  const root = await createFinalizeRoot(label);
  const bundle = await createRootBundle();
  const service = await startFinalizeService(root, undefined, undefined, workspaceWriteClock, workspaceWriteHooks);
  await activateFinalizeService(service.origin);
  await service.prepareProject(generationId, importer.hostId, projectInput("project-a"));
  const receipt = parseImportReceipt(await (await uploadRootBundle(service.origin, bundle)).json());
  expect((await finalizeRootImport(service.origin, {
    schemaVersion: 1, generationId, importNonce: receipt.importNonce, bundleDigest: receipt.bundleDigest
  })).status).toBe(200);
  return { root, service };
}

async function issueLease(origin: string): Promise<WorkspaceWriteLease> {
  const response = await fetch(`${origin}/v1/projects/project-a/workspace-write-leases`, {
    method: "POST",
    headers: { authorization: workspaceWriteIssuerAuthorization, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, generationId, repositoryId: "root", workspaceId })
  });
  expect(response.status).toBe(201);
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TestSetupError();
  const username = Reflect.get(value, "username");
  const password = Reflect.get(value, "password");
  const expiresAt = Reflect.get(value, "expiresAt");
  if (typeof username !== "string" || typeof password !== "string" || typeof expiresAt !== "number") {
    throw new TestSetupError();
  }
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(value).toEqual({ schemaVersion: 1, serviceId: "native-main", projectId: "project-a",
    repositoryId: "root", generationId, workspaceId, username, password, expiresAt });
  return { username, password, expiresAt };
}

async function writerClone(origin: string, lease: WorkspaceWriteLease, label: string): Promise<string> {
  const clone = await createFinalizeRoot(label);
  await runGit("/usr/bin/git", ["clone", authenticatedRemote(origin, lease), clone]);
  await runGit("/usr/bin/git", ["-C", clone, "config", "user.name", "DIM writer"]);
  await runGit("/usr/bin/git", ["-C", clone, "config", "user.email", "writer@example.invalid"]);
  return clone;
}

async function commit(clone: string, file: string, contents: string): Promise<void> {
  await mkdir(clone, { recursive: true });
  await writeFile(join(clone, file), contents);
  await runGit("/usr/bin/git", ["-C", clone, "add", file]);
  await runGit("/usr/bin/git", ["-C", clone, "commit", "-m", file]);
}

async function expectRejectedPush(clone: string, refspec: readonly string[]): Promise<void> {
  await expect(runGit("/usr/bin/git", ["-C", clone, "push", "origin", ...refspec]))
    .rejects.toSatisfy((error: unknown) => isExitError(error) && /remote rejected/.test(error.stderr));
}

async function expectCloneRejected(origin: string, lease: WorkspaceWriteLease, label: string): Promise<void> {
  const clone = await createFinalizeRoot(label);
  await expect(runGit("/usr/bin/git", ["clone", authenticatedRemote(origin, lease), clone]))
    .rejects.toSatisfy((error: unknown) => isExitError(error));
}

async function refValue(root: string, ref: string): Promise<string | undefined> {
  try {
    return (await runGit("/usr/bin/git", ["--git-dir", rootRepository(root), "rev-parse", "--verify", ref]))
      .stdout.trim();
  } catch (error) {
    if (isExitError(error)) return undefined;
    throw error;
  }
}

function authenticatedRemote(origin: string, lease: WorkspaceWriteLease): string {
  const url = new URL("/v1/projects/project-a/repositories/root.git", origin);
  url.username = lease.username;
  url.password = lease.password;
  return url.toString();
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

type WorkspaceWriteLease = {
  readonly username: string;
  readonly password: string;
  readonly expiresAt: number;
};

class TestSetupError extends Error {
  readonly name = "TestSetupError";
}
