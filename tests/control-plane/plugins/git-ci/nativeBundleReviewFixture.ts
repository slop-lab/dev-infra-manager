import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-git/http";
import type { AuthoritativeNativeReviewEnvelope } from "../../../../packages/control-plane/plugins/git-ci/src/plan-schema.js";
import type { AuthoritativeNativeReviewHooks, CodeReviewService } from "@slop-lab/dim-control-plane-plugin-code-review/plugin-api";
import { gitCiEnvelope, readAuthoritativeNativeReviewEnvelopes } from "../../../../packages/control-plane/plugins/git-ci/src/plan-store.js";
import type { NativeHumanReviewerHooks } from "../../../../packages/control-plane/plugins/code-review/src/native-human-reviewer-http.js";
import type { CiDeliveryPublicationFaults } from "../../../../packages/control-plane/plugins/git-ci/src/delivery-publication.js";
import { authoritativePolicy, matchingRunner } from "../git-repositories/authoritativeNativeCandidateFixture.js";
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
} from "../git-repositories/nativeRootImportFinalizeFixture.js";

export const reviewWorkspaceId = Buffer.alloc(32, 60).toString("base64url");
export const reviewProposalRef = `refs/heads/proposals/${reviewWorkspaceId}/change-1`;

export type NativeBundleReviewFixture = {
  readonly root: string;
  readonly clone: string;
  readonly repositoryId: string;
  readonly service: RunningService;
};

export async function nativeBundleReviewFixture(
  label: string,
  reviewHooks?: AuthoritativeNativeReviewHooks,
  policy: object = authoritativePolicy(),
  reviewerHooks?: NativeHumanReviewerHooks,
  ordinaryIdentityHttpClient?: NativeGitAdmissionHttpClient,
  deliveryFaults?: CiDeliveryPublicationFaults,
  nativeOrdinaryAttemptHooks?: undefined,
  configOverrides: object = {},
  _reservedPromotionHooks?: undefined,
  runner = matchingRunner(),
  candidateLeaseClock?: () => number,
  repositoryId = "root"
): Promise<NativeBundleReviewFixture> {
  const root = await createFinalizeRoot(label);
  const bundle = await createRootBundle({
    "README.md": "root bundle\n",
    ".dim/ci/runner.yml": runner,
    ".dim/ci/jobs/source.bash": "set -euo pipefail\nprintf 'source\\n'\n",
    ".dim/ci/jobs/integration.bash": "set -euo pipefail\nprintf 'integration\\n'\n"
  });
  const service = await startFinalizeService(
    root, candidateLeaseClock, undefined, undefined, undefined, undefined, reviewHooks, reviewerHooks,
    ordinaryIdentityHttpClient, deliveryFaults, nativeOrdinaryAttemptHooks, configOverrides
  );
  await activateFinalizeService(service.origin);
  await service.prepareProject(generationId, importer.hostId, projectInput("project-a", repositoryId));
  const receipt = parseImportReceipt(await (await uploadRootBundle(
    service.origin,
    bundle,
    policy, repositoryId
  )).json());
  const finalized = await finalizeRootImport(service.origin, {
    schemaVersion: 1,
    generationId,
    importNonce: receipt.importNonce,
    bundleDigest: receipt.bundleDigest
  }, undefined, repositoryId);
  if (finalized.status !== 200) throw new ReviewFixtureError();
  const lease = await issueWorkspaceLease(service.origin, repositoryId);
  const clone = await createFinalizeRoot(`${label}-clone`);
  await runGit("/usr/bin/git", ["clone", authenticatedRemote(service.origin, lease, repositoryId), clone]);
  await runGit("/usr/bin/git", ["-C", clone, "config", "user.name", "DIM writer"]);
  await runGit("/usr/bin/git", ["-C", clone, "config", "user.email", "writer@example.invalid"]);
  await addCandidateCommit(clone, "candidate.bin", Buffer.from([0, 255, 1, 254]));
  await runGit("/usr/bin/git", ["-C", clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
  return { root, clone, service, repositoryId };
}

export async function addCandidateCommit(clone: string, path: string, contents: Buffer): Promise<void> {
  await mkdir(join(clone, path, ".."), { recursive: true });
  await writeFile(join(clone, path), contents);
  await runGit("/usr/bin/git", ["-C", clone, "add", path]);
  await runGit("/usr/bin/git", ["-C", clone, "commit", "-m", path]);
}

export async function refreshBundleReviewWriter(fixture: NativeBundleReviewFixture): Promise<void> {
  const lease = await issueWorkspaceLease(fixture.service.origin, fixture.repositoryId);
  await runGit("/usr/bin/git", ["-C", fixture.clone, "remote", "set-url", "origin",
    authenticatedRemote(fixture.service.origin, lease, fixture.repositoryId)]);
}

export async function publishedReviewNames(root: string, repositoryId = "root"): Promise<readonly string[]> {
  try {
    return await readdir(join(rootRepository(root, repositoryId), "dim-authoritative-reviews", "proposals"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export async function publishedReviewEnvelopes(
  root: string, repositoryId = "root"
): Promise<readonly AuthoritativeNativeReviewEnvelope[]> {
  return readAuthoritativeNativeReviewEnvelopes(rootRepository(root, repositoryId));
}

export async function createBundleReview(service: RunningService, repositoryId = "root"): Promise<AuthoritativeNativeReviewEnvelope> {
  const extension = service.context.extensions.find(({ kind, name }) => kind === "dim.code-review.service" && name === "default");
  if (!extension || !("create" in extension.value) || typeof extension.value.create !== "function") throw new ReviewFixtureError();
  const reviews = extension.value as CodeReviewService;
  const envelope = await reviews.create(service.context, {
    projectId: "project-a", repositoryId, proposalRef: reviewProposalRef
  });
  const planned = await gitCiEnvelope(rootRepository(service.context.stateDirectory, repositoryId), envelope);
  if (planned === undefined) throw new ReviewFixtureError();
  return planned;
}

async function issueWorkspaceLease(origin: string, repositoryId: string): Promise<{ readonly username: string; readonly password: string }> {
  const response = await fetch(`${origin}/v1/projects/project-a/repositories/${repositoryId}/workspace-write-leases`, {
    method: "POST",
    headers: { authorization: workspaceWriteIssuerAuthorization, "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: 1,
      generationId,
      repositoryId,
      workspaceId: reviewWorkspaceId
    })
  });
  if (response.status !== 201) throw new ReviewFixtureError();
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ReviewFixtureError();
  const username = Reflect.get(value, "username");
  const password = Reflect.get(value, "password");
  if (typeof username !== "string" || typeof password !== "string") throw new ReviewFixtureError();
  return { username, password };
}

function authenticatedRemote(
  origin: string,
  lease: { readonly username: string; readonly password: string },
  repositoryId: string
): string {
  const url = new URL(`/v1/projects/project-a/repositories/${repositoryId}.git`, origin);
  url.username = lease.username;
  url.password = lease.password;
  return url.toString();
}

class ReviewFixtureError extends Error {
  readonly name = "ReviewFixtureError";
}
