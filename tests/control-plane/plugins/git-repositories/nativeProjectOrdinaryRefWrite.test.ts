import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nativeRepositoryPolicyRevision } from "@slop-lab/dim-contracts-git";
import { isExitError } from "../../../support/gitHelpers.js";
import { publishedReviewNames } from "../git-ci/nativeBundleReviewFixture.js";
import {
  activateFinalizeService,
  authorization,
  cleanupFinalizeFixtures,
  closeFinalizeService,
  createFinalizeRoot,
  createRootBundle,
  finalizeRootImport,
  generationId,
  importer,
  parseImportReceipt,
  projectInput,
  rootRepository,
  runGit,
  startFinalizeService,
  uploadRootBundle,
  workspaceWriteIssuerAuthorization,
  type RunningService
} from "./nativeRootImportFinalizeFixture.js";

const workspaceId = Buffer.alloc(32, 60).toString("base64url");

afterEach(cleanupFinalizeFixtures);

describe("native Project ordinary ref writes", () => {
  it("creates, updates, force-updates, deletes, reads, and reproves ordinary branches and tags", async () => {
    // Given
    const fixture = await finalizedFixture("ordinary-ref-positive");
    const lease = await issueLease(fixture.service.origin);
    const clone = await writerClone(fixture.service.origin, lease);
    const protectedBefore = await refValue(fixture.root, "refs/heads/main");
    const first = await commit(clone, "first.txt", "first\n");

    // When
    await push(clone, [`${first}:refs/heads/topic`]);
    const second = await commit(clone, "second.txt", "second\n");
    await push(clone, [`${second}:refs/heads/topic`]);
    expect(await refValue(fixture.root, "refs/heads/main")).toBe(protectedBefore);
    await push(clone, ["--force", `${first}:refs/heads/topic`]);
    await runGit("/usr/bin/git", ["-C", clone, "tag", "lightweight", second]);
    await runGit("/usr/bin/git", ["-C", clone, "tag", "-a", "annotated", "-m", "annotated", first]);
    await push(clone, ["refs/tags/lightweight", "refs/tags/annotated"]);
    await runGit("/usr/bin/git", ["-C", clone, "tag", "-f", "lightweight", first]);
    await push(clone, ["--force", "refs/tags/lightweight"]);
    const reader = await writerClone(fixture.service.origin, lease);
    expect((await runGit("/usr/bin/git", ["-C", reader, "rev-parse", "refs/remotes/origin/topic"])).stdout.trim()).toBe(first);
    expect((await runGit("/usr/bin/git", ["-C", reader, "rev-parse", "refs/tags/annotated^{}"])).stdout.trim()).toBe(first);
    expect((await proof(fixture.service.origin)).status).toBe(200);
    expect(await publishedReviewNames(fixture.root)).toEqual([]);
    await push(clone, [":refs/heads/topic", ":refs/tags/lightweight", ":refs/tags/annotated"]);

    // Then
    expect(await refValue(fixture.root, "refs/heads/topic")).toBeUndefined();
    expect(await refValue(fixture.root, "refs/tags/lightweight")).toBeUndefined();
    expect((await proof(fixture.service.origin)).status).toBe(200);
    await closeFinalizeService(fixture.service);
    const restarted = await startFinalizeService(fixture.root);
    await activateFinalizeService(restarted.origin);
    expect((await proof(restarted.origin)).status).toBe(200);
    const restartedLease = await issueLease(restarted.origin);
    await push(await writerClone(restarted.origin, restartedLease), [`HEAD:refs/heads/after-restart`]);
    expect(await refValue(fixture.root, "refs/heads/after-restart")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("atomically denies protected, reserved, and foreign proposal writes while retaining legacy proposal rules", async () => {
    // Given
    const fixture = await finalizedFixture("ordinary-ref-denials", protectedPolicy());
    const lease = await issueLease(fixture.service.origin);
    const clone = await writerClone(fixture.service.origin, lease);
    const candidate = await commit(clone, "candidate.txt", "candidate\n");
    const ownProposal = `refs/heads/proposals/${workspaceId}/change`;
    await push(clone, [`${candidate}:${ownProposal}`]);
    const proposalUpdate = await commit(clone, "proposal-update.txt", "proposal update\n");
    await push(clone, [`${proposalUpdate}:${ownProposal}`]);
    const proposalBefore = await refValue(fixture.root, ownProposal);
    const foreignWorkspace = Buffer.alloc(32, 61).toString("base64url");

    // When / Then
    for (const ref of [
      "refs/heads/main",
      "refs/heads/development",
      "refs/heads/release",
      "refs/heads/proposals/reserved/change",
      `refs/heads/proposals/${foreignWorkspace}/change`,
      "refs/dim/extensions/foreign/pin",
      "refs/remotes/upstream/foreign"
    ]) await expectRejectedPush(clone, [`${candidate}:${ref}`]);
    await expectRejectedPush(clone, [":refs/heads/main", `${candidate}:refs/heads/ordinary-mixed`]);
    expect(await refValue(fixture.root, "refs/heads/ordinary-mixed")).toBeUndefined();
    await expectRejectedPush(clone, [`:${ownProposal}`]);
    await runGit("/usr/bin/git", ["-C", clone, "checkout", "--orphan", "replacement"]);
    await runGit("/usr/bin/git", ["-C", clone, "rm", "-rf", "."]);
    const replacement = await commit(clone, "replacement.txt", "replacement\n");
    await expectRejectedPush(clone, ["--force", `${replacement}:${ownProposal}`]);
    expect(await refValue(fixture.root, ownProposal)).toBe(proposalBefore);
  });
});

async function finalizedFixture(label: string, policy?: object): Promise<{ readonly root: string; readonly service: RunningService }> {
  const root = await createFinalizeRoot(label);
  const bundle = await createRootBundle();
  const service = await startFinalizeService(root);
  await activateFinalizeService(service.origin);
  await service.prepareProject(generationId, importer.hostId, projectInput("project-a"));
  const receipt = parseImportReceipt(await (await uploadRootBundle(service.origin, bundle, policy)).json());
  expect((await finalizeRootImport(service.origin, { schemaVersion: 1, generationId,
    importNonce: receipt.importNonce, bundleDigest: receipt.bundleDigest })).status).toBe(200);
  return { root, service };
}

function protectedPolicy(): object {
  const branches = { "refs/heads/main": { review: true }, "refs/heads/development": { review: false },
    "refs/heads/release": { review: true } } as const;
  const input = { protectedRef: "refs/heads/main", defaultRef: "refs/heads/main", branches, extensions: { "code-review": { requiredReviewerIds: ["owner"], pathReviewerRules: [] } } } as const;
  return { schemaVersion: 1, ...input, policyRevision: nativeRepositoryPolicyRevision(input) };
}

async function issueLease(origin: string): Promise<Lease> {
  const response = await fetch(`${origin}/v1/projects/project-a/repositories/root/workspace-write-leases`, {
    method: "POST", headers: { authorization: workspaceWriteIssuerAuthorization, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, generationId, repositoryId: "root", workspaceId })
  });
  expect(response.status).toBe(201);
  const value: unknown = await response.json();
  const username = typeof value === "object" && value !== null ? Reflect.get(value, "username") : undefined;
  const password = typeof value === "object" && value !== null ? Reflect.get(value, "password") : undefined;
  if (typeof username !== "string" || typeof password !== "string") throw new TestSetupError();
  return { username, password };
}

async function writerClone(origin: string, lease: Lease): Promise<string> {
  const clone = await createFinalizeRoot("ordinary-ref-clone");
  await runGit("/usr/bin/git", ["clone", authenticatedRemote(origin, lease), clone]);
  await runGit("/usr/bin/git", ["-C", clone, "config", "user.name", "DIM writer"]);
  await runGit("/usr/bin/git", ["-C", clone, "config", "user.email", "writer@example.invalid"]);
  return clone;
}

async function commit(clone: string, file: string, contents: string): Promise<string> {
  await mkdir(clone, { recursive: true });
  await writeFile(join(clone, file), contents);
  await runGit("/usr/bin/git", ["-C", clone, "add", file]);
  await runGit("/usr/bin/git", ["-C", clone, "commit", "-m", file]);
  return (await runGit("/usr/bin/git", ["-C", clone, "rev-parse", "HEAD"])).stdout.trim();
}

function push(clone: string, refspecs: readonly string[]): Promise<unknown> {
  return runGit("/usr/bin/git", ["-C", clone, "push", "origin", ...refspecs]);
}

async function expectRejectedPush(clone: string, refspecs: readonly string[]): Promise<void> {
  await expect(push(clone, refspecs)).rejects.toSatisfy((error: unknown) => isExitError(error) && /remote rejected/.test(error.stderr));
}

async function refValue(root: string, ref: string): Promise<string | undefined> {
  try { return (await runGit("/usr/bin/git", ["--git-dir", rootRepository(root), "rev-parse", "--verify", ref])).stdout.trim(); }
  catch (error) { if (isExitError(error)) return undefined; throw error; }
}

function proof(origin: string): Promise<Response> {
  return fetch(`${origin}/v1/projects/project-a/repositories/root/import/proof`, {
    method: "POST", headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, generationId })
  });
}

function authenticatedRemote(origin: string, lease: Lease): string {
  const url = new URL("/v1/projects/project-a/repositories/root.git", origin);
  url.username = lease.username; url.password = lease.password;
  return url.toString();
}

type Lease = { readonly username: string; readonly password: string };
class TestSetupError extends Error { readonly name = "TestSetupError"; }
