import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import type {
  AuthoritativeNativeReviewEnvelope,
  AuthoritativeNativeReviewHooks
} from "../../../../core/packages/native-git/src/index.js";
import type { NativeHumanReviewerHooks } from "../../../../core/packages/native-git/src/native-human-reviewer-http.js";
import { authoritativePolicy, matchingRunner } from "./authoritativeNativeCandidateFixture.js";
import {
  activateFinalizeService,
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

export const reviewWorkspaceId = Buffer.alloc(32, 60).toString("base64url");
export const reviewProposalRef = `refs/heads/proposals/${reviewWorkspaceId}/change-1`;

export type NativeBundleReviewFixture = {
  readonly root: string;
  readonly clone: string;
  readonly service: RunningService;
};

export async function nativeBundleReviewFixture(
  label: string,
  reviewHooks?: AuthoritativeNativeReviewHooks,
  policy: object = authoritativePolicy(),
  reviewerHooks?: NativeHumanReviewerHooks
): Promise<NativeBundleReviewFixture> {
  const root = await createFinalizeRoot(label);
  const bundle = await createRootBundle({
    "README.md": "root bundle\n",
    ".dim/ci/runner.yml": matchingRunner(),
    ".dim/ci/jobs/source.bash": "set -euo pipefail\nprintf 'source\\n'\n",
    ".dim/ci/jobs/integration.bash": "set -euo pipefail\nprintf 'integration\\n'\n"
  });
  const service = await startFinalizeService(
    root, undefined, undefined, undefined, undefined, undefined, reviewHooks, reviewerHooks
  );
  await activateFinalizeService(service.origin);
  await service.prepareProject(generationId, importer.hostId, projectInput("project-a"));
  const receipt = parseImportReceipt(await (await uploadRootBundle(
    service.origin,
    bundle,
    policy
  )).json());
  expect((await finalizeRootImport(service.origin, {
    schemaVersion: 1,
    generationId,
    importNonce: receipt.importNonce,
    bundleDigest: receipt.bundleDigest
  })).status).toBe(200);
  const lease = await issueWorkspaceLease(service.origin);
  const clone = await createFinalizeRoot(`${label}-clone`);
  await runGit("/usr/bin/git", ["clone", authenticatedRemote(service.origin, lease), clone]);
  await runGit("/usr/bin/git", ["-C", clone, "config", "user.name", "DIM writer"]);
  await runGit("/usr/bin/git", ["-C", clone, "config", "user.email", "writer@example.invalid"]);
  await addCandidateCommit(clone, "candidate.bin", Buffer.from([0, 255, 1, 254]));
  await runGit("/usr/bin/git", ["-C", clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
  return { root, clone, service };
}

export async function addCandidateCommit(clone: string, path: string, contents: Buffer): Promise<void> {
  await mkdir(join(clone, path, ".."), { recursive: true });
  await writeFile(join(clone, path), contents);
  await runGit("/usr/bin/git", ["-C", clone, "add", path]);
  await runGit("/usr/bin/git", ["-C", clone, "commit", "-m", path]);
}

export async function publishedReviewNames(root: string): Promise<readonly string[]> {
  try {
    return await readdir(join(rootRepository(root), "dim-authoritative-reviews", "proposals"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export function createBundleReview(service: RunningService): Promise<AuthoritativeNativeReviewEnvelope> {
  return service.createReview({
    projectId: "project-a",
    repositoryId: "root",
    proposalRef: reviewProposalRef
  });
}

async function issueWorkspaceLease(origin: string): Promise<{ readonly username: string; readonly password: string }> {
  const response = await fetch(`${origin}/v1/projects/project-a/workspace-write-leases`, {
    method: "POST",
    headers: { authorization: workspaceWriteIssuerAuthorization, "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: 1,
      generationId,
      repositoryId: "root",
      workspaceId: reviewWorkspaceId
    })
  });
  expect(response.status).toBe(201);
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ReviewFixtureError();
  const username = Reflect.get(value, "username");
  const password = Reflect.get(value, "password");
  if (typeof username !== "string" || typeof password !== "string") throw new ReviewFixtureError();
  return { username, password };
}

function authenticatedRemote(
  origin: string,
  lease: { readonly username: string; readonly password: string }
): string {
  const url = new URL("/v1/projects/project-a/repositories/root.git", origin);
  url.username = lease.username;
  url.password = lease.password;
  return url.toString();
}

class ReviewFixtureError extends Error {
  readonly name = "ReviewFixtureError";
}
